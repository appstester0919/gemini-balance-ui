"use client";

import { useState } from "react";
import Link from "next/link";
import { Mic, FileAudio, Loader2, Copy, ArrowLeft, Check } from "lucide-react";
import { AudioRecorder, type RecordedAudio } from "@/components/AudioRecorder";
import {
  LanguageSelector,
  type LanguageCode,
} from "@/components/LanguageSelector";
import { fileToBase64 } from "@/lib/audio";

type Tab = "record" | "upload";

export default function AudioToTextPage() {
  const [tab, setTab] = useState<Tab>("record");
  const [language, setLanguage] = useState<LanguageCode>("yue");
  const [recorded, setRecorded] = useState<RecordedAudio | null>(null);
  const [uploaded, setUploaded] = useState<{
    data: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const hasAudio = tab === "record" ? !!recorded : !!uploaded;

  async function transcribe() {
    if (!hasAudio) {
      setError("Provide audio first (record or upload).");
      return;
    }
    setError(null);
    setTranscript(null);
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
          endpoint: "/v1/audio/transcriptions",
          body: {
            model: "gemini-2.5-flash",
            audio,
            language,
            prompt:
              "Transcribe the audio exactly as spoken. Keep punctuation and code-switching.",
          },
        }),
      });
      const json = (await resp.json()) as
        | { ok: true; data: { text: string } }
        | { ok: false; error: string };

      if (!json.ok) {
        setError(json.error || "Transcription failed.");
        return;
      }
      setTranscript(json.data.text ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  async function copyTranscript() {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setTranscript(null);
    setRecorded(null); // clear other source
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
          <Mic className="text-emerald-600" /> Audio → Text
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
            <Mic size={14} className="inline -mt-0.5 mr-1" /> Record
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
            <FileAudio size={14} className="inline -mt-0.5 mr-1" /> Upload
          </button>
        </div>

        {tab === "record" ? (
          <AudioRecorder
            value={recorded}
            onComplete={(a) => {
              setRecorded(a);
              setUploaded(null);
              setTranscript(null);
            }}
            disabled={loading}
          />
        ) : (
          <div className="card space-y-2">
            <label htmlFor="a2t-upload" className="label-base">
              Audio file
            </label>
            <input
              id="a2t-upload"
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

        <div>
          <label htmlFor="a2t-lang" className="label-base">
            Language
          </label>
          <LanguageSelector
            id="a2t-lang"
            value={language}
            onChange={setLanguage}
            disabled={loading}
          />
        </div>

        <div>
          <button
            type="button"
            className="btn-primary"
            onClick={transcribe}
            disabled={loading || !hasAudio}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Transcribing…
              </>
            ) : (
              <>
                <Mic size={18} /> Transcribe
              </>
            )}
          </button>
        </div>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 ring-1 ring-red-200">
            {error}
          </p>
        )}
      </div>

      {transcript !== null && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Transcript</h2>
            <button
              type="button"
              className="btn-secondary !py-2 !px-3 text-sm"
              onClick={copyTranscript}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <textarea
            readOnly
            className="input-base min-h-[160px] resize-y"
            value={transcript}
          />
        </div>
      )}
    </div>
  );
}
