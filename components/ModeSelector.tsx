import { Mic, FileAudio, Volume2 } from "lucide-react";
import Link from "next/link";

interface ModeCard {
  href: string;
  title: string;
  blurb: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  accent: string; // tailwind class for the icon ring
}

const MODES: ModeCard[] = [
  {
    href: "/text-to-speech",
    title: "Text → Speech",
    blurb: "Type any text, pick a voice, listen back as audio.",
    Icon: Volume2,
    accent: "ring-emerald-500/40 bg-emerald-50 text-emerald-700",
  },
  {
    href: "/audio-to-text",
    title: "Audio → Text",
    blurb: "Record or upload audio, get a transcript back.",
    Icon: Mic,
    accent: "ring-sky-500/40 bg-sky-50 text-sky-700",
  },
  {
    href: "/audio-to-audio",
    title: "Audio → Audio",
    blurb: "Speak in one language, get transcript + translation + spoken reply.",
    Icon: FileAudio,
    accent: "ring-violet-500/40 bg-violet-50 text-violet-700",
  },
];

export function ModeSelector() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {MODES.map(({ href, title, blurb, Icon, accent }) => (
        <Link
          key={href}
          href={href}
          className="card hover:shadow-md hover:-translate-y-0.5 transition-all group"
        >
          <div className="flex items-start gap-4">
            <div className={`shrink-0 rounded-xl p-3 ring-1 ${accent}`}>
              <Icon size={24} />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-slate-900 group-hover:text-emerald-700 transition-colors">
                {title}
              </h3>
              <p className="text-sm text-slate-600 mt-1">{blurb}</p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
