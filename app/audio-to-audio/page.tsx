"use client";

import { useState } from "react";
import Link from "next/link";
import { FileAudio, Loader2, ArrowLeft, Check } from "lucide-react";
import { AudioRecorder, type RecordedAudio } from "@/components/AudioRecorder";
import { AudioPlayer } from "@/components/AudioPlayer";
import {
  LanguageSelector,
  type LanguageCode,
} from "@/components/LanguageSelector";
import { fileToBase64 } from "@/lib/audio";

const VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede"];

type Tab = "record" | "upload";

interface A2AResult {
  transcript: string;
  translation: string;
  pcm: string;
  sampleRate: number;
}

export default function AudioToAudioPage() {
  const [tab, setTab] = useState<Tab>("record");
  const [sourceLang, setSourceLang] = useState<LanguageCode>("yue");
  const [targetLang, setTargetLang] = useState<LanguageCode>("zh");
  const [voice, setVoice] = useState<string>("Kore");
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const [uploaded, setUploaded] = useState<{
    data: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<A2AResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasAudio = tab === "record" ? !!recorded : !!uploaded;

  async function translateAndSpeak() {
    if (!hasAudio) {
      setError("Provide audio first (record or upload).");
      return;
    }
    setError(null);
    setResult(null);
    setLoading(true);
    try {
      const audio =
        tab === "record"
          ? { data: (recorded as RecordedAudio).data, mimeType: (recorded as RecordedAudio).mimeType }
          : { data: (uploaded as { data: string; mimeType: string }).data, mimeType: (uploaded as { data: string; mimeType: string }).mimeType };

      const resp = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "/v1/audio/speech",
          body: {
            audio,
            source_lang: sourceLang,
            target_lang: targetLang,
            voice,
          },
        }),
      });
      const json = (await resp.json()) as
        | {
            ok: true;
            data: {
              transcript?: string;
              translation?: string;
              audio?: { data?: string; format?: string };
            };
          }
        | { ok: false; error: string };

      if (!json.ok) {
        setError(json.error || "Pipeline failed.");
        return;
      }
      const data = json.data;
      const pcm = data.audio?.data;
      if (!pcm) {
        setError("Upstream returned no audio.");
        return;
      }
      const m = data.audio?.format?.match(/rate=(\d+)/);
      setResult({
        transcript: data.transcript ?? "",
        translation: data.translation ?? "",
        pcm,
        sampleRate: m ? Number(m[1]) : 24000,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setRecorded(null);
    const data = await fileToBase64(file);
    setUploaded({ data, mimeType: file.type || "audio/mpeg", name: file.name });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="btn-secondary !py-2 !px-3">
          <ArrowLeft size={16} /> Back
        </Link>
        <h1 className="text-2xl font-bold text-slate-900 inline-flex items-center gap-2">
          <FileAudio className="text-emerald-600" /> Audio → Audio
        </h1>
      </div>

      <div className="card space-y-4">
        <div role="tablist" className="inline-flex rounded-xl bg-slate-100 p-1">
          <button
            role="tab"
            type="button"
            aria-selected={tab === "record"}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === "record"
                ? "bg-white shadow-sm text-slate-900"
                : "text-slate-600 hover:text-slate-900"
            }`}
            onClick={() => setTab("record")}
          >
            Record
          </button>
          <button
            role="tab"
            type="button"
            aria-selected={tab === "upload"}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === "upload"
                ? "bg-white shadow-sm text-slate-900"
                : "text-slate-600 hover:text-slate-900"
            }`}
            onClick={() => setTab("upload")}
          >
            Upload
          </button>
        </div>

        {tab === "record" ? (
          <AudioRecorder
            value={recorded}
            onComplete={(a) => {
              setRecorded(a);
              setUploaded(null);
              setResult(null);
            }}
            disabled={loading}
          />
        ) : (
          <div className="card space-y-2">
            <label htmlFor="a2a-upload" className="label-base">
              Audio file
            </label>
            <input
              id="a2a-upload"
              type="file"
              accept="audio/*"
              onChange={onUpload}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-lg file:border-0 file:bg-emerald-600 file:text-white file:px-4 file:py-2 file:cursor-pointer hover:file:bg-emerald-700"
            />
            {uploaded && (
              <p className="text-xs text-slate-500">
                Loaded <code>{uploaded.name}</code> · {uploaded.mimeType}
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="a2a-source" className="label-base">
              Source language
            </label>
            <LanguageSelector
              id="a2a-source"
              value={sourceLang}
              onChange={setSourceLang}
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="a2a-target" className="label-base">
              Target language
            </label>
            <LanguageSelector
              id="a2a-target"
              value={targetLang}
              onChange={setTargetLang}
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="a2a-voice" className="label-base">
              Voice
            </label>
            <select
              id="a2a-voice"
              className="input-base"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={loading}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          className="btn-primary"
          onClick={translateAndSpeak}
          disabled={loading || !hasAudio}
        >
          {loading ? (
            <>
              <Loader2 size={18} className="animate-spin" /> Processing…
            </>
          ) : (
            <>
              <FileAudio size={18} /> Translate + Speak
            </>
          )}
        </button>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200">
            {error}
          </p>
        )}
      </div>

      {result && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="card space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="section-title">Transcript</h2>
              <span className="text-xs text-slate-500">{sourceLang}</span>
            </div>
            <p className="text-sm text-slate-800 whitespace-pre-wrap min-h-[80px]">
              {result.transcript || <span className="text-slate-400">—</span>}
            </p>
          </div>
          <div className="card space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="section-title">Translation</h2>
              <span className="text-xs text-slate-500">{targetLang}</span>
            </div>
            <p className="text-sm text-slate-800 whitespace-pre-wrap min-h-[80px]">
              {result.translation || <span className="text-slate-400">—</span>}
            </p>
          </div>
          <div className="card space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="section-title">Audio reply</h2>
              <span className="text-xs text-slate-500 inline-flex items-center gap-1">
                <Check size={12} /> ready
              </span>
            </div>
            <AudioPlayer pcmBase64={result.pcm} sampleRate={result.sampleRate} />
          </div>
        </div>
      )}
    </div>
  );
}
