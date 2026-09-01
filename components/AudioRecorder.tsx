"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
import { blobToBase64, isMediaRecorderSupported } from "@/lib/audio";

export interface RecordedAudio {
  /** base64-encoded audio (no data URL prefix) */
  data: string;
  /** MIME type the recorder produced (e.g. audio/webm;codecs=opus) */
  mimeType: string;
  /** Duration in seconds */
  durationSec: number;
}

interface Props {
  /** Called whenever a recording is finalised. */
  onComplete: (audio: RecordedAudio) => void;
  /** Currently-recorded audio, if any. The component clears it on re-record. */
  value?: RecordedAudio | null;
  /** Max duration in seconds (auto-stop). Default 120s. */
  maxDurationSec?: number;
  /** Disable UI. */
  disabled?: boolean;
}

/**
 * Mic recorder using navigator.mediaDevices + MediaRecorder.
 * Picks the first supported MIME in preference order (webm/opus → webm → mp4).
 */
export function AudioRecorder({
  onComplete,
  value,
  maxDurationSec = 120,
  disabled,
}: Props) {
  const [supported, setSupported] = useState(true);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSupported(isMediaRecorderSupported());
    return () => {
      // Clean up on unmount.
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickMime(): string {
    if (typeof MediaRecorder === "undefined") return "audio/webm";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
    ];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "audio/webm";
  }

  function clearTimers() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }

  function stopAll() {
    clearTimers();
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    streamRef.current = null;
    mediaRecorderRef.current = null;
  }

  async function start() {
    setError(null);
    if (!supported) {
      setError("MediaRecorder is not available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMime();
      const mr = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const durationSec = (Date.now() - startedAtRef.current) / 1000;
        stopAll();
        setRecording(false);
        setElapsed(0);
        try {
          const data = await blobToBase64(blob);
          onComplete({ data, mimeType, durationSec });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Encoding failed.");
        }
      };

      startedAtRef.current = Date.now();
      mr.start();
      setRecording(true);
      tickRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 100);
      maxTimerRef.current = setTimeout(() => stop(), maxDurationSec * 1000);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not access microphone.";
      setError(msg);
      stopAll();
    }
  }

  function stop() {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop(); // triggers onstop
    } else {
      stopAll();
      setRecording(false);
      setElapsed(0);
    }
  }

  if (!supported) {
    return (
      <div className="card text-sm text-amber-700 bg-amber-50 ring-amber-200">
        Your browser doesn&apos;t support <code>MediaRecorder</code>. Please use
        the Upload tab instead.
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={
              recording
                ? "btn-primary !bg-red-600 hover:!bg-red-700 active:!bg-red-800"
                : "btn-primary"
            }
            disabled={disabled}
            onClick={recording ? stop : start}
            aria-pressed={recording}
          >
            {recording ? (
              <>
                <Square size={18} /> Stop
              </>
            ) : (
              <>
                <Mic size={18} /> Record
              </>
            )}
          </button>
          {recording && (
            <span className="inline-flex items-center gap-2 text-sm text-red-700">
              <Loader2 size={14} className="animate-spin" />
              {elapsed.toFixed(1)}s / {maxDurationSec}s
            </span>
          )}
        </div>
        {value && !recording && (
          <span className="text-xs text-slate-500">
            Recorded {value.durationSec.toFixed(1)}s · {value.mimeType}
          </span>
        )}
      </div>
      {error && (
        <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200">
          {error}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Recording uses your default microphone. Audio is sent to the server as
        base64 and never persisted beyond the request.
      </p>
    </div>
  );
}
