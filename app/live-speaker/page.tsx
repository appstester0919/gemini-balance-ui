"use client";

/**
 * /live-speaker — speaker console for the Live API session.
 *
 * Responsibilities (single-screen):
 *  1. Capture mic audio via AudioContext → AudioWorklet that downsamples to
 *     16kHz mono Float32 PCM in ~100ms chunks.
 *  2. Open a WebSocket DIRECTLY to the Deno backend
 *     (gemini-balance-lite.appstester0919.deno.net/ws/live — see
 *     lib/live-ws.ts) and stream the PCM frames as binary messages.
 *  3. Surface session metadata: source language, up to three target
 *     languages (default yue→zh), and a stable `sessionId` so listeners can
 *     join the same stream.
 *  4. Render a QR code that links to /listen/<sessionId> for users who scan
 *     it from a phone.
 *  5. Expose an end-session button that cleanly tears down mic, worklet,
 *     AudioContext and the socket.
 *
 * Backend contract: the FIRST text frame after WS open MUST be a JSON
 * `{ setup: { ... } }` message — the Deno bridge sniffs it, fills in
 * `model` + `sessionResumption`, and forwards it to the Gemini Live API
 * upstream. Subsequent text frames are passed through; binary frames are
 * PCM chunks for the speaker's own mic.
 *
 * Auth: handled server-side by the Deno backend's `GMB_KEYS` env var. The
 * browser cannot set WS handshake headers, so we never see a Gemini key.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import {
  Mic,
  MicOff,
  Loader2,
  ArrowLeft,
  QrCode,
  Square,
  Radio,
  Copy,
  Check,
  AlertTriangle,
} from "lucide-react";
import {
  LanguageSelector,
  LANGUAGES,
  type LanguageCode,
} from "@/components/LanguageSelector";
import type { LanguageOption } from "@/components/LanguageSelector";
import { resolveSpeakerWsUrl } from "@/lib/live-ws";

type ConnStatus =
  | "idle"
  | "connecting"
  | "live"
  | "ending"
  | "ended"
  | "error";

/**
 * Possible source languages the speaker might be talking in. We keep this
 * shape separate from the targets so the UI can grow independently.
 */
type SourceLanguage = LanguageCode;
type TargetLanguage = LanguageCode;

interface SessionMeta {
  /** Stable per-session id; used by listeners to subscribe. */
  id: string;
  /** Wall-clock ISO timestamp of when the session was opened. */
  startedAt: string;
  /** Human-readable name, defaults to "Live session". */
  label?: string;
}

/**
 * WS endpoint resolution lives in lib/live-ws.ts. We open the socket
 * directly to the Deno backend (wss://gemini-balance-lite.appstester0919.deno.net/ws/live),
 * bypassing the Vercel frontend so the Basic Auth middleware cannot block
 * the WS handshake. See lib/live-ws.ts for the auth rationale.
 */

/**
 * Build a listener URL (relative to the current Next.js origin) so a phone
 * that scans the QR opens `/listen/<sessionId>` on this app. The listener
 * page will dial its own WS out to /ws/listen?session=<id>.
 */
function buildListenerUrl(sessionId: string, targets: TargetLanguage[]): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const params = new URLSearchParams();
  if (targets.length > 0) params.set("targets", targets.join(","));
  return `${origin}/listen/${encodeURIComponent(sessionId)}${
    params.toString() ? `?${params.toString()}` : ""
  }`;
}

/**
 * Pick 3 distinct target languages from the global list. The API only
 * supports 3 simultaneous target languages (one per fan-out channel).
 */
function pickTargets(
  source: SourceLanguage,
  selected: TargetLanguage[],
): TargetLanguage[] {
  const filtered = selected.filter((t) => t !== source);
  const unique: TargetLanguage[] = [];
  for (const t of filtered) {
    if (!unique.includes(t)) unique.push(t);
    if (unique.length >= 3) break;
  }
  // Fill up to 3 with anything that isn't the source and isn't already picked.
  for (const l of LANGUAGES) {
    if (unique.length >= 3) break;
    if (l.code === source) continue;
    if (!unique.includes(l.code)) unique.push(l.code);
  }
  return unique;
}

export default function LiveSpeakerPage() {
  // ---- language pickers (3 in × 3 out, default yue → zh) -----------------
  const [source, setSource] = useState<SourceLanguage>("yue");
  // Selected by the user; we trim/sanitize before sending.
  const [targetDraft, setTargetDraft] = useState<TargetLanguage[]>(["zh"]);
  const targets = useMemo(
    () => pickTargets(source, targetDraft),
    [source, targetDraft],
  );

  function setTarget(idx: number, code: TargetLanguage) {
    setTargetDraft((prev) => {
      const next = prev.slice();
      next[idx] = code;
      return next;
    });
  }

  function addTargetSlot() {
    setTargetDraft((prev) =>
      prev.length >= 3 ? prev : [...prev, "en"],
    );
  }

  function removeTargetSlot(idx: number) {
    setTargetDraft((prev) => prev.filter((_, i) => i !== idx));
  }

  // ---- session state -----------------------------------------------------
  const [status, setStatus] = useState<ConnStatus>("idle");
  const [session, setSession] = useState<SessionMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [listenersOnline, setListenersOnline] = useState<number>(0);
  const [bytesSent, setBytesSent] = useState<number>(0);
  const [muted, setMuted] = useState(false);

  // ---- refs (non-reactive engine state) ----------------------------------
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const startedAtRef = useRef<number>(0);
  const sessionIdRef = useRef<string>("");
  const samplingRef = useRef<{ windowMs: number; bytes: number }>({
    windowMs: 0,
    bytes: 0,
  });

  // Generate the QR whenever the listener URL changes. Memoised so we don't
  // regenerate while data-URL is already fresh (QR library is sync but not free).
  const listenerUrl = useMemo(
    () => (session ? buildListenerUrl(session.id, targets) : ""),
    [session, targets],
  );

  useEffect(() => {
    if (!listenerUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(listenerUrl, {
      errorCorrectionLevel: "M",
      width: 256,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) {
          setQrDataUrl(null);
          console.warn("QR generation failed", err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listenerUrl]);

  // ---- session lifecycle -------------------------------------------------
  function generateSessionId(): string {
    // Browser-friendly UUID v4. crypto.randomUUID is available in modern
    // browsers and secure contexts.
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `s-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  }

  const cleanup = useCallback(() => {
    // Stop the worklet / mic / context first so we stop emitting frames.
    try {
      workletRef.current?.port.close();
    } catch {
      /* noop */
    }
    workletRef.current?.disconnect();
    workletRef.current = null;

    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    streamRef.current = null;

    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {
        /* noop */
      });
    }

    // Then close the socket.
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          // Tell the server to terminate the session.
          ws.send(JSON.stringify({ type: "end", sessionId: sessionIdRef.current }));
        }
      } catch {
        /* noop */
      }
      try {
        ws.close(1000, "client-end");
      } catch {
        /* noop */
      }
    }
  }, []);

  function teardownSession(finalStatus: ConnStatus = "ended") {
    cleanup();
    setStatus(finalStatus);
  }

  async function startSession() {
    setError(null);
    setListenersOnline(0);
    setBytesSent(0);
    startedAtRef.current = Date.now();
    sessionIdRef.current = generateSessionId();

    setSession({
      id: sessionIdRef.current,
      startedAt: new Date().toISOString(),
    });

    setStatus("connecting");

    // 1. Open WebSocket first so the server can fail-fast on auth.
    // sessionId is sent on the query string so the backend can reuse the
    // upstream Gemini Live session across the 9-minute rotate.
    const wsUrl = resolveSpeakerWsUrl(sessionIdRef.current);
    const ws = new WebSocket(wsUrl, ["audio.v1"]);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      try {
        // FIRST text frame MUST be a `{ setup: { ... } }` envelope — the
        // Deno bridge sniffs it (live_handler.ts:178), injects `model` +
        // `sessionResumption`, and forwards it to the Gemini Live API.
        ws.send(
          JSON.stringify({
            setup: {
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Orus" },
                  },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
        // 2. Once the socket is up, capture mic & load worklet. Doing this
        // AFTER the socket is open means we never sit on a hot mic stream
        // the server is ignoring.
        await startCapture();
        setStatus("live");
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Could not start microphone.";
        setError(msg);
        teardownSession("error");
      }
    };

    ws.onmessage = (ev) => {
      // Server messages are JSON control frames; binary frames (if any)
      // would be downstream TTS playback for the speaker, which we ignore.
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === "listeners") {
          setListenersOnline(Number(msg.count) || 0);
        } else if (msg?.type === "error") {
          setError(msg.error || "Server reported an error.");
          teardownSession("error");
        } else if (msg?.type === "ended") {
          // Server initiated teardown (e.g. timeout).
          teardownSession("ended");
        }
      } catch {
        /* ignore malformed frames */
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection failed.");
      teardownSession("error");
    };

    ws.onclose = (ev) => {
      // Don't surface a noisy error if the user intentionally ended it.
      if (status === "ending" || status === "ended") return;
      if (ev.code === 1000 || ev.code === 1001) return;
      if (ev.code === 401 || ev.code === 403) {
        setError(
          "Server rejected the connection (auth required). Configure the live backend to accept this origin or provide credentials.",
        );
      }
      // If we never made it to "live", treat close as a connect failure.
      if (status !== "live") {
        setStatus("error");
      } else {
        setStatus("ended");
      }
    };
  }

  async function startCapture() {
    if (typeof window === "undefined") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia is not available in this browser.");
    }

    // Acquire mic at a reasonable sample rate for the OS default; the
    // worklet handles downsampling to 16kHz.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
      video: false,
    });
    streamRef.current = stream;

    // Use a fixed 16k target rate: the worklet down-samples regardless of
    // the context rate, so we pick a context rate that's well-supported.
    const Ctor: typeof AudioContext =
      window.AudioContext ||
      // Safari support.
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctor({ sampleRate: 48000, latencyHint: "interactive" });
    audioCtxRef.current = ctx;

    // Load the worklet module (served from /public/audio-worklets/...).
    await ctx.audioWorklet.addModule(
      "/audio-worklets/pcm-downsampler.js",
    );

    const src = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, "pcm-downsampler", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    workletRef.current = worklet;

    worklet.port.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || data.type !== "pcm") return;
      const buffer: ArrayBuffer | undefined = data.samples;
      if (!buffer) return;

      // Apply mute by dropping frames if the speaker paused their mic.
      if (mutedRef.current) return;

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
        const bytes = buffer.byteLength;
        setBytesSent((prev) => prev + bytes);
        // 1-second sampling window for live throughput stats.
        const now = Date.now();
        const s = samplingRef.current;
        s.bytes += bytes;
        if (now - s.windowMs >= 1000) {
          s.windowMs = now;
          s.bytes = 0;
        }
      }
    };

    // Keep the worklet alive — it doesn't need to feed any destination, but
    // we route it through a muted gain so Chrome doesn't suspend the node
    // for having no output. (Connect-to-destination would cause feedback.)
    const silent = ctx.createGain();
    silent.gain.value = 0;
    src.connect(worklet);
    worklet.connect(silent);
    silent.connect(ctx.destination);
  }

  function endSession() {
    setStatus("ending");
    // Defer the actual close slightly so the UI can show "ending" first.
    setTimeout(() => {
      teardownSession("ended");
    }, 150);
  }

  // Ref mirror of `muted` so the worklet-port callback (created at capture
  // time) can see the latest value without re-binding on every change.
  const mutedRef = useRef(false);
  useEffect(() => {
    mutedRef.current = muted;
    // Tell the worklet whether to gate frames as well, so heavy chunks
    // don't pile up while muted.
    const w = workletRef.current;
    if (w) {
      try {
        w.port.postMessage({ type: "enabled", value: !muted });
      } catch {
        /* noop */
      }
    }
  }, [muted]);

  // Unmount teardown: don't leak mic or socket.
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Convenience derived state.
  const isLive = status === "live";
  const isBusy = status === "connecting" || status === "ending";

  // For throughput stat: show kbps roughly.
  const throughputKbps = useMemo(() => {
    // 16kHz * 4 bytes (f32) * 1 ch = 64 KB/s base rate. Show actual based
    // on `bytesSent` and elapsed seconds.
    const elapsedSec = session
      ? Math.max(0.001, (Date.now() - startedAtRef.current) / 1000)
      : 0;
    return elapsedSec > 0 ? (bytesSent / 1024 / elapsedSec) * 8 : 0;
  }, [bytesSent, session]);

  async function copyListenerUrl() {
    if (!listenerUrl) return;
    try {
      await navigator.clipboard.writeText(listenerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }

  // ---- UI ----------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Link href="/" className="btn-secondary !py-2 !px-3">
            <ArrowLeft size={16} /> Back
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 inline-flex items-center gap-2">
            <Radio className="text-emerald-600" /> Live · Speaker
          </h1>
        </div>
        <ConnectionPill status={status} listeners={listenersOnline} />
      </div>

      {/* Setup / start card */}
      <div className="card space-y-5">
        {/* Language pickers: 1 source + up to 3 targets */}
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="ls-source" className="label-base">
                You speak <span className="text-slate-400">(source)</span>
              </label>
              <LanguageSelector
                id="ls-source"
                value={source}
                onChange={setSource}
                disabled={isLive || isBusy}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label-base">
                Listeners hear <span className="text-slate-400">(up to 3 targets)</span>
              </label>
              <div className="space-y-2">
                {Array.from({ length: Math.max(1, targetDraft.length) }).map(
                  (_, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        className="input-base"
                        value={targetDraft[idx] ?? "zh"}
                        onChange={(e) =>
                          setTarget(idx, e.target.value as TargetLanguage)
                        }
                        disabled={isLive || isBusy}
                        aria-label={`Target language ${idx + 1}`}
                      >
                        {LANGUAGES.filter((l) => l.code !== source).map(
                          (l: LanguageOption) => (
                            <option key={l.code} value={l.code}>
                              {l.label}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeTargetSlot(idx)}
                        disabled={
                          isLive || isBusy || targetDraft.length <= 1
                        }
                        className="btn-secondary !py-2 !px-2 text-xs"
                        aria-label="Remove target"
                      >
                        −
                      </button>
                    </div>
                  ),
                )}
                <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                  <span>
                    {targets.length} of 3 target
                    {targets.length === 1 ? "" : "s"} selected
                  </span>
                  {targetDraft.length < 3 && (
                    <button
                      type="button"
                      onClick={addTargetSlot}
                      disabled={isLive || isBusy}
                      className="text-emerald-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                    >
                      + Add another
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Primary controls */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-200">
          {!isLive ? (
            <button
              type="button"
              className="btn-primary"
              onClick={startSession}
              disabled={isBusy || targets.length === 0}
            >
              {status === "connecting" ? (
                <>
                  <Loader2 size={18} className="animate-spin" /> Connecting…
                </>
              ) : (
                <>
                  <Mic size={18} /> Start speaking
                </>
              )}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                className={`btn-secondary ${muted ? "!bg-red-50 !text-red-700" : ""}`}
                aria-pressed={muted}
              >
                {muted ? <MicOff size={16} /> : <Mic size={16} />}
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                className="btn-primary !bg-red-600 hover:!bg-red-700 active:!bg-red-800"
                onClick={endSession}
              >
                <Square size={18} /> End session
              </button>
            </>
          )}

          {session && (
            <div className="text-xs text-slate-500 inline-flex items-center gap-3 ml-auto">
              <span className="inline-flex items-center gap-1">
                <Radio size={12} className="text-emerald-600" />
                {listenersOnline} listener
                {listenersOnline === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums">
                {throughputKbps.toFixed(0)} kbps
              </span>
              <code className="text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">
                {session.id.slice(0, 8)}
              </code>
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200 inline-flex items-center gap-2">
            <AlertTriangle size={14} />
            {error}
          </p>
        )}
      </div>

      {/* QR + share for listeners */}
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <QrCode size={18} className="text-slate-700" />
          <h2 className="section-title">Listener link</h2>
        </div>

        {!session ? (
          <p className="text-sm text-slate-600">
            Start a session to receive a stable share link and QR code that
            listeners can scan to join.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 items-start">
            <div className="rounded-xl ring-1 ring-slate-200 bg-white p-3 inline-block">
              {qrDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="QR code linking to the listener page"
                  width={192}
                  height={192}
                  className="block"
                />
              ) : (
                <div className="w-[192px] h-[192px] grid place-items-center text-xs text-slate-400">
                  <Loader2 size={20} className="animate-spin" />
                </div>
              )}
            </div>
            <div className="space-y-3 min-w-0">
              <div>
                <label htmlFor="ls-url" className="label-base">
                  Share this URL
                </label>
                <div className="flex gap-2">
                  <input
                    id="ls-url"
                    readOnly
                    value={listenerUrl}
                    className="input-base font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    onClick={copyListenerUrl}
                    className="btn-secondary !py-2 !px-3 text-sm shrink-0"
                    aria-label="Copy listener URL"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
              <div className="text-sm text-slate-600">
                <p>
                  Listeners will join automatically once they scan the QR code
                  or open the link. Their browser will subscribe to your
                  session over the same WebSocket.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Target languages streamed:{" "}
                  <code>{targets.join(", ") || "—"}</code>
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Help footer */}
      <div className="card text-sm text-slate-600">
        <h2 className="section-title mb-2">How this works</h2>
        <ol className="list-decimal pl-5 space-y-1">
          <li>
            We capture your mic with <code>getUserMedia</code> and run it
            through an <code>AudioWorklet</code> that downsamples to 16 kHz
            mono Float32 PCM in ~100 ms chunks.
          </li>
          <li>
            Each chunk is sent as a binary WebSocket frame to{" "}
            <code>{resolveSpeakerWsUrl(session?.id || "preview").replace(/^wss?:\/\//, "")}</code>.
          </li>
          <li>
            The backend fans the recognized text out to every connected
            listener subscribed to <code>session.id</code> in their requested
            target languages.
          </li>
          <li>
            End the session when done — this stops the mic, closes the socket
            and lets the server free the room.
          </li>
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection pill — extracted so we can reuse it cleanly and keep the main
// render function uncluttered.
// ---------------------------------------------------------------------------

function ConnectionPill({
  status,
  listeners,
}: {
  status: ConnStatus;
  listeners: number;
}) {
  const styling = (() => {
    switch (status) {
      case "live":
        return {
          cls: "bg-emerald-50 text-emerald-700 ring-emerald-200",
          dot: "bg-emerald-500",
          label: `Live · ${listeners} listener${listeners === 1 ? "" : "s"}`,
        };
      case "connecting":
        return {
          cls: "bg-amber-50 text-amber-700 ring-amber-200",
          dot: "bg-amber-400",
          label: "Connecting…",
        };
      case "ending":
        return {
          cls: "bg-amber-50 text-amber-700 ring-amber-200",
          dot: "bg-amber-400 animate-pulse",
          label: "Ending…",
        };
      case "ended":
        return {
          cls: "bg-slate-100 text-slate-600 ring-slate-200",
          dot: "bg-slate-400",
          label: "Session ended",
        };
      case "error":
        return {
          cls: "bg-red-50 text-red-700 ring-red-200",
          dot: "bg-red-500",
          label: "Error",
        };
      default:
        return {
          cls: "bg-slate-100 text-slate-600 ring-slate-200",
          dot: "bg-slate-400",
          label: "Idle",
        };
    }
  })();

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ring-1 ${styling.cls}`}
      role="status"
      aria-live="polite"
    >
      <span className={`w-2 h-2 rounded-full ${styling.dot}`} />
      {styling.label}
    </span>
  );
}
