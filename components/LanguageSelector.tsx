"use client";

import { isMediaRecorderSupported } from "@/lib/audio";

export type LanguageCode = "yue" | "zh" | "en";

export interface LanguageOption {
  code: LanguageCode;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "yue", label: "yue (廣東話 / Cantonese)" },
  { code: "zh", label: "zh (普通話 / Mandarin)" },
  { code: "en", label: "en (English)" },
];

interface Props {
  value: LanguageCode;
  onChange: (v: LanguageCode) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function LanguageSelector({
  value,
  onChange,
  id,
  className = "input-base",
  disabled,
}: Props) {
  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as LanguageCode)}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}

// Re-export the support flag so consumers don't need to import lib/audio directly.
export { isMediaRecorderSupported };
