import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gemini Balance",
  description:
    "Text-to-Speech, Audio-to-Text, and Audio-to-Audio powered by Gemini via a load-balanced proxy.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-slate-200 bg-white/70 backdrop-blur sticky top-0 z-10">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-2">
            <a href="/" className="font-semibold text-emerald-700 text-lg">
              Gemini Balance
            </a>
            <span className="text-xs text-slate-500 ml-2">
              LB-pool proxy · 3 modes
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-slate-500">
          Frontend for <code className="text-slate-700">gemini-balance-lite</code> Deno Deploy proxy.
        </footer>
      </body>
    </html>
  );
}
