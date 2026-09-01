import { ModeSelector } from "@/components/ModeSelector";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <section className="text-center space-y-3 pt-6">
        <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight">
          Talk to Gemini, any way you want.
        </h1>
        <p className="text-slate-600 text-lg max-w-2xl mx-auto">
          Three modes, one proxy. Text in → speech out, audio in → text out, or
          full pipeline: audio in → transcript + translation + speech out.
        </p>
      </section>

      <section>
        <ModeSelector />
      </section>

      <section className="card text-sm text-slate-600">
        <h2 className="section-title mb-2">How it works</h2>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Your browser calls this Next.js app&apos;s own <code>/api/proxy</code> route.</li>
          <li>
            The route adds a Gemini LB-pool key (server-side, never exposed to the
            browser) and forwards to{" "}
            <code>gemini-balance-lite.appstester0919.deno.net</code>.
          </li>
          <li>Upstream Gemini results stream back as JSON / base64 audio.</li>
        </ol>
      </section>
    </div>
  );
}
