"use client";

/**
 * Read-only live audio listener.
 *
 * URL shape:
 *   /listen/[sessionId]?token=<ephemeral-token>
 *
 * Connects DIRECTLY to the Deno backend
 *   wss://gemini-balance-lite.appstester0919.deno.net/ws/listen?session=<id>
 * via `lib/live-ws.ts`. The browser never sees a Gemini API key — auth is
 * the Deno backend's `GMB_KEYS` env var. The `?token=` query param is
 * accepted for backward-compat (old share links) but is not required and
 * is not sent to the backend.
 *
 * Wire format from the backend:
 *   Binary frames: raw Int16 PCM @ the negotiated sample rate (default
 *     24000 Hz, mono). The page may also receive the same payload as a
 *     JSON envelope of the form
 *       { "type": "audio", "sampleRate": 24000, "data": "<base64 PCM>" }
 *   Control frames:
 *       { "type": "ready" }                                  // server greeting
 *       { "type": "end"   }                                  // stream finished
 *       { "type": "error", "message": "..." }                // fatal server error
 *
 * This page is deliberately read-only — there is no microphone access.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Activity,
} from "lucide-react";
import { resolveListenerWsUrl } from "@/lib/live-ws";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default jitter buffer depth, in seconds. Must be in the 200-500ms range. */
const DEFAULT_JITTER_MS = 300;
const MIN_JITTER_MS = 200;
const MAX_JITTER_MS = 500;

/** Reconnect backoff: 1s, 2s, 4s, capped at 8s. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;
const MAX_RECONNECT_ATTEMPTS = 6;

/** Default sample rate — matches Gemini TTS output for the rest of this app. */
const DEFAULT_SAMPLE_RATE = 24000;

/** How often we recompute buffer stats shown in the UI. */
const STATS_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus =
  | "idle" // page just mounted, haven't started yet
  | "connecting" // WS handshake in flight
  | "connected" // WS open, audio flowing (or paused waiting for chunks)
  | "closed" // server closed the stream cleanly
  | "error"; // handshake / network error

interface AudioEnvelope {
  type: "audio";
  sampleRate?: number;
  sequence?: number;
  format?: string; // "pcm_s16le" | "pcm_f32le" etc.
  data: string; // base64 PCM bytes
}

interface StatusEnvelope {
  type: "ready" | "end" | "error";
  message?: string;
}

type ServerEnvelope = AudioEnvelope | StatusEnvelope | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a base64 string to an Int16Array (little-endian PCM). */
function base64ToInt16(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Align to 2-byte boundary; trailing junk becomes zero.
  const aligned = new Uint8Array(bytes.length - (bytes.length % 2));
  aligned.set(bytes.subarray(0, aligned.length));
  return new Int16Array(aligned.buffer);
}

/** Format a millisecond duration as "1.2s". */
function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PageProps {
  params: { sessionId: string };
}

export default function ListenPage({ params }: PageProps) {
  const { sessionId } = params;

  // ----- URL params -----
  const token = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token") ?? "";
  }, []);

  // ----- UI state -----
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);

  const [volume, setVolume] = useState<number>(0.8); // 0..1
  const [muted, setMuted] = useState<boolean>(false);

  const [jitterMs, setJitterMs] = useState<number>(DEFAULT_JITTER_MS);

  // Live stats — updated on a timer, not on every chunk, to avoid React churn.
  const [stats, setStats] = useState({
    bufferedSec: 0,
    playedChunks: 0,
    droppedChunks: 0,
    receivedChunks: 0,
    sampleRate: DEFAULT_SAMPLE_RATE,
  });

  // ----- Refs (mutable, no rerender on change) -----
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  /** Pending PCM (Float32 mono @ activeSampleRate) waiting in the jitter buffer. */
  const queueRef = useRef<Float32Array[]>([]);
  /** Total seconds of audio currently sitting in the jitter buffer. */
  const bufferedSecRef = useRef<number>(0);
  /** Last time we scheduled a chunk — used to schedule the next one seamlessly. */
  const nextStartTimeRef = useRef<number>(0);
  /** Currently playing source nodes (for cleanup on stop). */
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  /** Active sample rate, negotiated on first audio frame. */
  const sampleRateRef = useRef<number>(DEFAULT_SAMPLE_RATE);
  /** Bookkeeping for stats. */
  const countersRef = useRef({ played: 0, dropped: 0, received: 0 });
  /** Reconnect bookkeeping. */
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);
  /** Set true when we intentionally close (user navigated away) — skip reconnect. */
  const intentionalCloseRef = useRef<boolean>(false);
  /** Latest status setter — referenced from inside event handlers. */
  const statusRef = useRef<ConnectionStatus>("idle");
  statusRef.current = status;

  // -------------------------------------------------------------------------
  // Audio graph lifecycle
  // -------------------------------------------------------------------------

  /** Lazily create the AudioContext + gain node. Must be called from a user
   *  gesture or after one — browsers block audio until then. */
  const ensureAudioGraph = useCallback(async (): Promise<boolean> => {
    if (typeof window === "undefined") return false;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      setErrorMsg("This browser does not support Web Audio.");
      setStatus("error");
      return false;
    }
    if (!audioCtxRef.current) {
      const ctx = new Ctor({ latencyHint: "playback" });
      const gain = ctx.createGain();
      gain.gain.value = muted ? 0 : volume;
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainRef.current = gain;
    }
    if (audioCtxRef.current.state === "suspended") {
      try {
        await audioCtxRef.current.resume();
      } catch {
        // Some browsers throw if resume() is called without a user gesture
        // even though we got here after one. Swallow.
      }
    }
    return true;
  }, [muted, volume]);

  /** Tear down the audio graph. Used on disconnect / unmount. */
  const destroyAudioGraph = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSourcesRef.current = [];
    queueRef.current = [];
    bufferedSecRef.current = 0;
    nextStartTimeRef.current = 0;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    gainRef.current = null;
  }, []);

  // Apply volume / mute changes to the live gain node.
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = muted ? 0 : volume;
    }
  }, [volume, muted]);

  // -------------------------------------------------------------------------
  // Jitter buffer drain
  //
  // We accumulate Float32 PCM chunks until we have >= jitterMs seconds of
  // audio, then schedule a single AudioBufferSourceNode to play it at the
  // current AudioContext time + (any currently-scheduled tail). This gives
  // gap-free playback without re-creating one source per network chunk.
  // -------------------------------------------------------------------------

  const drainQueue = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    const targetSec = jitterMs / 1000;
    if (bufferedSecRef.current < targetSec) return;

    // Concatenate queued Float32 chunks.
    const queued = queueRef.current;
    if (queued.length === 0) return;
    let totalLen = 0;
    for (const c of queued) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let off = 0;
    for (const c of queued) {
      merged.set(c, off);
      off += c.length;
    }
    queueRef.current = [];
    bufferedSecRef.current = 0;

    // Build the AudioBuffer and schedule it.
    const buf = ctx.createBuffer(1, merged.length, sampleRateRef.current);
    buf.copyToChannel(merged, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;

    if (gainRef.current) {
      src.connect(gainRef.current);
    } else {
      src.connect(ctx.destination);
    }

    const startAt =
      nextStartTimeRef.current < ctx.currentTime ? ctx.currentTime : nextStartTimeRef.current;
    src.start(startAt);
    nextStartTimeRef.current = startAt + buf.duration;

    activeSourcesRef.current.push(src);
    src.onended = () => {
      // Drop finished sources from the active list to allow GC.
      const idx = activeSourcesRef.current.indexOf(src);
      if (idx >= 0) activeSourcesRef.current.splice(idx, 1);
      countersRef.current.played += 1;
    };
  }, [jitterMs]);

  // -------------------------------------------------------------------------
  // Ingest one PCM chunk (Int16 mono @ given sample rate).
  // -------------------------------------------------------------------------

  const enqueuePcm = useCallback(
    (pcm: Int16Array, sampleRate: number) => {
      // Adopt the sample rate from the first audio frame.
      if (sampleRate > 0) sampleRateRef.current = sampleRate;

      // Convert Int16 → Float32 in [-1, 1].
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7fff);

      queueRef.current.push(float);
      bufferedSecRef.current += float.length / sampleRateRef.current;
      countersRef.current.received += 1;

      // Drop the oldest chunk if the buffer grows more than 2x the jitter
      // target — protects against a stalled drainer stalling playback.
      const maxSec = (jitterMs / 1000) * 4;
      while (bufferedSecRef.current > maxSec && queueRef.current.length > 1) {
        const dropped = queueRef.current.shift();
        if (dropped) bufferedSecRef.current -= dropped.length / sampleRateRef.current;
        countersRef.current.dropped += 1;
      }

      drainQueue();
    },
    [drainQueue, jitterMs],
  );

  // -------------------------------------------------------------------------
  // WS message dispatch
  // -------------------------------------------------------------------------

  const handleMessage = useCallback(
    async (evt: MessageEvent) => {
      // Binary frame — treat as raw Int16 PCM at the negotiated sample rate.
      if (evt.data instanceof ArrayBuffer) {
        const view = new Int16Array(evt.data);
        if (view.length === 0) return;
        enqueuePcm(view, sampleRateRef.current);
        return;
      }
      if (evt.data instanceof Blob) {
        const buf = await evt.data.arrayBuffer();
        const view = new Int16Array(buf);
        if (view.length === 0) return;
        enqueuePcm(view, sampleRateRef.current);
        return;
      }

      // Text frame — try JSON envelope first.
      if (typeof evt.data === "string") {
        let env: ServerEnvelope | null = null;
        try {
          env = JSON.parse(evt.data) as ServerEnvelope;
        } catch {
          // Not JSON, not binary — ignore.
          return;
        }
        if (!env || typeof env !== "object") return;

        if ((env as StatusEnvelope).type === "ready") {
          setServerMessage("Server ready.");
          return;
        }
        if ((env as StatusEnvelope).type === "end") {
          setServerMessage("Stream ended by server.");
          setStatus("closed");
          return;
        }
        if ((env as StatusEnvelope).type === "error") {
          setErrorMsg((env as StatusEnvelope).message ?? "Server error.");
          setStatus("error");
          return;
        }
        if ((env as AudioEnvelope).type === "audio") {
          const a = env as AudioEnvelope;
          if (!a.data) return;
          try {
            const pcm = base64ToInt16(a.data);
            if (pcm.length === 0) return;
            enqueuePcm(pcm, a.sampleRate && a.sampleRate > 0 ? a.sampleRate : sampleRateRef.current);
          } catch (err) {
            countersRef.current.dropped += 1;
            console.warn("[listener] bad audio frame", err);
          }
          return;
        }
      }
    },
    [enqueuePcm],
  );

  // -------------------------------------------------------------------------
  // WS connection lifecycle + reconnect
  // -------------------------------------------------------------------------

  const connect = useCallback(async () => {
    // No more required token — the Deno backend authenticates via its
    // `GMB_KEYS` env var. The page still surfaces a parsed token in the UI
    // header for backward-compat with old share links.

    const ok = await ensureAudioGraph();
    if (!ok) return;

    setErrorMsg(null);
    setServerMessage(null);
    setStatus("connecting");

    const url = resolveListenerWsUrl(sessionId);
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      setStatus("connected");
      setServerMessage("Connected. Waiting for audio…");
    };

    ws.onmessage = (evt) => {
      void handleMessage(evt);
    };

    ws.onerror = () => {
      // The 'close' event will fire right after — let that drive the UI.
    };

    ws.onclose = (evt) => {
      wsRef.current = null;
      if (intentionalCloseRef.current) {
        setStatus("closed");
        return;
      }
      // Auth failures should not retry.
      if (evt.code === 1008 || evt.code === 4401 || evt.code === 4403) {
        setErrorMsg(`Connection refused (code ${evt.code}). The backend requires GMB_KEYS to be set on the Deno Deploy dashboard.`);
        setStatus("error");
        return;
      }
      // Otherwise attempt a backoff reconnect.
      if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setErrorMsg("Lost connection. Max reconnect attempts reached.");
        setStatus("error");
        return;
      }
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** reconnectAttemptRef.current,
      );
      reconnectAttemptRef.current += 1;
      setServerMessage(`Disconnected. Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void connect();
      }, delay);
    };
  }, [ensureAudioGraph, handleMessage, sessionId]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "client disconnect");
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
    destroyAudioGraph();
    setStatus("closed");
  }, [destroyAudioGraph]);

  // Auto-connect on mount, disconnect on unmount.
  useEffect(() => {
    intentionalCloseRef.current = false;
    void connect();
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "unmount");
        } catch {
          /* ignore */
        }
      }
      destroyAudioGraph();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Stats polling — drain now if jitter changes and flush UI.
  // -------------------------------------------------------------------------

  useEffect(() => {
    const id = window.setInterval(() => {
      setStats({
        bufferedSec: bufferedSecRef.current,
        playedChunks: countersRef.current.played,
        droppedChunks: countersRef.current.dropped,
        receivedChunks: countersRef.current.received,
        sampleRate: sampleRateRef.current,
      });
    }, STATS_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // When the user changes jitter, kick the drainer so they hear audio sooner.
  useEffect(() => {
    drainQueue();
  }, [jitterMs, drainQueue]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const statusBadge = (() => {
    switch (status) {
      case "idle":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 text-slate-700 px-3 py-1 text-xs font-medium">
            <Loader2 size={12} className="animate-spin" /> Starting
          </span>
        );
      case "connecting":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-800 px-3 py-1 text-xs font-medium">
            <Loader2 size={12} className="animate-spin" /> Connecting
          </span>
        );
      case "connected":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-xs font-medium">
            <Wifi size={12} /> Live
          </span>
        );
      case "closed":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-200 text-slate-700 px-3 py-1 text-xs font-medium">
            <CheckCircle2 size={12} /> Ended
          </span>
        );
      case "error":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 text-red-800 px-3 py-1 text-xs font-medium">
            <WifiOff size={12} /> Error
          </span>
        );
    }
  })();

  const volumeIcon = muted || volume === 0 ? VolumeX : Volume2;
  const VolumeIcon = volumeIcon;

  const onVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value) / 100;
    setVolume(v);
    if (v > 0) setMuted(false);
  };

  const onMuteToggle = () => setMuted((m) => !m);

  const onJitterChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setJitterMs(Math.min(MAX_JITTER_MS, Math.max(MIN_JITTER_MS, v)));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="btn-secondary !py-2 !px-3 shrink-0">
            <ArrowLeft size={16} /> Back
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 truncate">
            Live listen
          </h1>
        </div>
        {statusBadge}
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <div>
            <span className="text-slate-500">Session</span>{" "}
            <code className="text-slate-800 bg-slate-100 rounded px-2 py-0.5">
              {sessionId}
            </code>
          </div>
          <div>
            <span className="text-slate-500">Token</span>{" "}
            <code className="text-slate-800 bg-slate-100 rounded px-2 py-0.5">
              {token ? `${token.slice(0, 6)}…${token.slice(-4)}` : "—"}
            </code>
          </div>
        </div>

        {errorMsg && (
          <p className="text-sm text-red-700 bg-red-50 rounded-full px-3 py-2 ring-1 ring-red-200 inline-flex items-center gap-2">
            <AlertTriangle size={14} /> {errorMsg}
          </p>
        )}
        {serverMessage && !errorMsg && (
          <p className="text-sm text-slate-600">{serverMessage}</p>
        )}
      </div>

      <div className="card space-y-5">
        <div>
          <h2 className="section-title inline-flex items-center gap-2">
            <Volume2 size={18} className="text-emerald-600" /> Playback
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Read-only — your microphone is not used.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onMuteToggle}
            aria-pressed={muted}
            aria-label={muted ? "Unmute" : "Mute"}
            className="btn-secondary !py-2 !px-3"
          >
            <VolumeIcon size={18} />
            <span className="text-xs">{muted ? "Muted" : "On"}</span>
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round((muted ? 0 : volume) * 100)}
            onChange={onVolumeChange}
            aria-label="Volume"
            className="flex-1 accent-emerald-600"
          />
          <span className="text-xs text-slate-500 tabular-nums w-12 text-right">
            {Math.round((muted ? 0 : volume) * 100)}%
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="label-base !mb-0 whitespace-nowrap">
            Jitter buffer
          </span>
          <input
            type="range"
            min={MIN_JITTER_MS}
            max={MAX_JITTER_MS}
            step={10}
            value={jitterMs}
            onChange={onJitterChange}
            aria-label="Jitter buffer (milliseconds)"
            className="flex-1 accent-emerald-600"
          />
          <span className="text-xs text-slate-500 tabular-nums w-12 text-right">
            {jitterMs}ms
          </span>
        </div>
        <p className="text-xs text-slate-500 -mt-3">
          Range {MIN_JITTER_MS}–{MAX_JITTER_MS}ms. Larger = smoother under
          network jitter, but more delay before you hear audio.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <StatTile
            icon={<Activity size={14} className="text-emerald-600" />}
            label="Buffered"
            value={fmtMs(stats.bufferedSec * 1000)}
          />
          <StatTile label="Sample rate" value={`${stats.sampleRate} Hz`} />
          <StatTile label="Received" value={String(stats.receivedChunks)} />
          <StatTile
            label="Played / Dropped"
            value={`${stats.playedChunks} / ${stats.droppedChunks}`}
          />
        </div>

        <div className="flex items-center gap-2 pt-2">
          {status === "connected" || status === "connecting" ? (
            <button type="button" className="btn-secondary" onClick={disconnect}>
              <WifiOff size={16} /> Disconnect
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={() => void connect()}>
              <Wifi size={16} /> Connect
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helper
// ---------------------------------------------------------------------------

function StatTile({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500 inline-flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold text-slate-900 tabular-nums mt-0.5">
        {value}
      </div>
    </div>
  );
}