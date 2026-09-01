"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, Loader2 } from "lucide-react";
import { wrapPcmInWav } from "@/lib/audio";

export interface AudioPlayerProps {
  /** Base64-encoded raw L16 PCM (no data URL prefix). */
  pcmBase64: string;
  /** Sample rate in Hz. Defaults to 24000 (Gemini TTS output). */
  sampleRate?: number;
  /** Optional caption shown above the player. */
  label?: string;
}

export function AudioPlayer({
  pcmBase64,
  sampleRate = 24000,
  label,
}: AudioPlayerProps) {
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const [duration, setDuration] = useState(0); // seconds
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // Build a WAV-wrapped blob URL once per pcmBase64/sampleRate pair.
  const blobUrl = useMemo(() => {
    if (!pcmBase64) return null;
    try {
      const blob = wrapPcmInWav(pcmBase64, sampleRate);
      return URL.createObjectURL(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to wrap PCM.");
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcmBase64, sampleRate]);

  // Track readiness and revoke URL on unmount or change.
  useEffect(() => {
    setReady(false);
    setPlaying(false);
    setProgress(0);
    setError(null);

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    objectUrlRef.current = blobUrl;
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [blobUrl]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play();
    } else {
      a.pause();
    }
  }

  function onTimeUpdate() {
    const a = audioRef.current;
    if (!a || !a.duration || !isFinite(a.duration)) return;
    setProgress(a.currentTime / a.duration);
  }

  function onLoadedMetadata() {
    const a = audioRef.current;
    if (a && isFinite(a.duration)) setDuration(a.duration);
    setReady(true);
  }

  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a || !a.duration || !isFinite(a.duration)) return;
    const v = Number(e.target.value);
    a.currentTime = (v / 1000) * a.duration;
    setProgress(a.currentTime / a.duration);
  }

  return (
    <div className="card space-y-3">
      {label && <div className="text-sm font-medium text-slate-700">{label}</div>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-primary !py-2 !px-3"
          onClick={toggle}
          disabled={!ready || !blobUrl}
          aria-label={playing ? "Pause" : "Play"}
        >
          {!ready ? (
            <Loader2 size={18} className="animate-spin" />
          ) : playing ? (
            <Pause size={18} />
          ) : (
            <Play size={18} />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(progress * 1000)}
          onChange={onScrub}
          disabled={!ready}
          className="flex-1 accent-emerald-600"
          aria-label="Seek"
        />
        <span className="text-xs text-slate-500 tabular-nums w-16 text-right">
          {duration ? `${duration.toFixed(1)}s` : "—"}
        </span>
      </div>
      {error && (
        <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200">
          {error}
        </p>
      )}
      {blobUrl && (
        <audio
          ref={audioRef}
          src={blobUrl}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          preload="metadata"
          className="hidden"
        />
      )}
    </div>
  );
}
