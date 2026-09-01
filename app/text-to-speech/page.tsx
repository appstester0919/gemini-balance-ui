"use client";

import { useState } from "react";
import Link from "next/link";
import { Volume2, Loader2, ArrowLeft } from "lucide-react";
import { AudioPlayer } from "@/components/AudioPlayer";

export interface TtsVoice {
  id: string;
  label: string;
}

const VOICES: TtsVoice[] = [
  { id: "Kore", label: "Kore (firm, confident)" },
  { id: "Puck", label: "Puck (upbeat, playful)" },
  { id: "Charon", label: "Charon (deep, calm)" },
  { id: "Fenrir", label: "Fenrir (bright, energetic)" },
  { id: "Aoede", label: "Aoede (warm, gentle)" },
];

const MAX_CHARS = 500;

export default function TextToSpeechPage() {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState<string>("Kore");
  const [loading, setLoading] = useState(false);
  const [pcm, setPcm] = useState<string | null>(null);
  const [sampleRate, setSampleRate] = useState<number>(24000);
  const [error, setError] = useState<string | null>(null);

  const overLimit = text.length > MAX_CHARS;

  async function generate() {
    if (!text.trim()) {
      setError("Please type some text first.");
      return;
    }
    if (overLimit) {
      setError(`Text exceeds ${MAX_CHARS}-character limit.`);
      return;
    }
    setError(null);
    setPcm(null);
    setLoading(true);
    try {
      const resp = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "/v1/audio/speech",
          body: {
            input: text,
            model: "gemini-2.5-flash-preview-tts",
            voice,
            response_modalities: ["AUDIO"],
            audio_format: "pcm16",
          },
        }),
      });
      const json = (await resp.json()) as
        | { ok: true; data: { audio?: { data?: string; format?: string } } }
        | { ok: false; error: string };

      if (!json.ok) {
        setError(json.error || "TTS failed.");
        return;
      }
      const audio = json.data?.audio;
      if (!audio?.data) {
        setError("Upstream returned no audio.");
        return;
      }
      setPcm(audio.data);
      // Best-effort sample rate parse from format like "audio/L16;rate=24000".
      const m = audio.format?.match(/rate=(\d+)/);
      if (m) setSampleRate(Number(m[1]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="btn-secondary !py-2 !px-3">
          <ArrowLeft size={16} /> Back
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 inline-flex items-center gap-2">
          <Volume2 className="text-emerald-600" /> Text → Speech
        </h1>
      </div>

      <div className="card space-y-4">
        <div>
          <label htmlFor="tts-text" className="label-base">
            Text to speak
          </label>
          <textarea
            id="tts-text"
            className={`input-base min-h-[140px] resize-y font-mono text-sm ${
              overLimit ? "ring-2 ring-red-400 border-red-400" : ""
            }`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type up to 500 characters…"
            maxLength={MAX_CHARS + 50}
          />
          <div className="mt-1 text-xs text-slate-500 flex justify-between">
            <span>Up to {MAX_CHARS} characters.</span>
            <span className={overLimit ? "text-red-600" : ""}>
              {text.length} / {MAX_CHARS}
            </span>
          </div>
        </div>

        <div>
          <label htmlFor="tts-voice" className="label-base">
            Voice
          </label>
          <select
            id="tts-voice"
            className="input-base"
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
          >
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={generate}
            disabled={loading || !text.trim() || overLimit}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Volume2 size={18} /> Generate Speech
              </>
            )}
          </button>
          {pcm && (
            <span className="text-xs text-slate-500">
              Ready · {sampleRate} Hz PCM
            </span>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200">
            {error}
          </p>
        )}
      </div>

      {pcm && <AudioPlayer pcmBase64={pcm} sampleRate={sampleRate} label="Result" />}
    </div>
  );
}
