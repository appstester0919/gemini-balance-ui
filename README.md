# gemini-balance-ui

Next.js 14 frontend for the [`gemini-balance-lite`](https://gemini-balance-lite.appstester0919.deno.net) Deno Deploy proxy.

Three modes over a single Gemini API:

| Mode             | Endpoint                       | What it does                                          |
| ---------------- | ------------------------------ | ----------------------------------------------------- |
| Text → Speech    | `POST /v1/chat/completions`    | TTS via Gemini (`modalities: ["audio"]`)              |
| Audio → Text     | `POST /v1/audio/transcriptions` | Transcribe audio via `gemini-3.5-flash`            |
| Audio → Audio    | `POST /v1/audio/speech`        | Transcribe → translate → re-speak (full pipeline)      |

The browser **never sees** a Gemini API key. A single server-side Next.js API
route at `app/api/proxy/route.ts` adds `Authorization: Bearer <key>` to every
upstream call, picking keys round-robin from `GMB_KEYS`.

## Stack

- Next.js 14.2 (App Router) + React 18 + TypeScript
- Tailwind CSS 3.4 + `lucide-react` icons (no other UI library)
- No state library — `useState` / `useReducer` only
- No shadcn, no Radix, no Material UI

## Repo layout

```
app/
  layout.tsx            # html shell, top nav, footer
  page.tsx              # home — hero + 3 mode cards
  globals.css           # tailwind base + a few component classes
  api/proxy/route.ts    # server-side proxy → Deno backend
  text-to-speech/page.tsx
  audio-to-text/page.tsx
  audio-to-audio/page.tsx
components/
  ModeSelector.tsx
  LanguageSelector.tsx
  AudioRecorder.tsx     # MediaRecorder → base64
  AudioPlayer.tsx       # wraps L16 PCM in WAV header, plays in <audio>
lib/
  audio.ts              # WAV header writer, blob/file base64 helpers
  proxy.ts              # server-side fetch w/ round-robin LB key
```

## Getting started

```bash
# 1. install deps
pnpm install   # or npm install / yarn install

# 2. configure env
cp .env.local.example .env.local
# edit .env.local — set GMB_KEYS to your comma-separated Gemini API keys

# 3. dev
pnpm dev       # http://localhost:3000

# 4. production
pnpm build && pnpm start
```

## Deploy (Vercel)

1. **Create the GitHub repo** at https://github.com/new (owner: `appstester0919`,
   name: `gemini-balance-ui`, **do NOT initialize with README** — local repo already
   has one). Copy the HTTPS URL.

2. **Push** (from `D:\AI\gemini-balance-ui`):
   ```bash
   git push -u origin main
   ```
   Use a GitHub PAT if prompted (HTTPS + 2FA). See the `github-auth` skill for the
   WSL HTTPS+PAT recipe.

3. **Import in Vercel**: https://vercel.com/new → pick `appstester0919/gemini-balance-ui`
   → Next.js preset auto-detected.

4. **Add environment variables** in Vercel project settings:
   - `GMB_KEYS` = comma-separated Gemini API keys (NO `NEXT_PUBLIC_` prefix!)
   - `GMB_BACKEND_URL` (optional) = `https://gemini-balance-lite.appstester0919.deno.net`
     (default is already correct)
   - `APP_PASSWORD` = a strong password (Vercel env var). Leave empty for public access.

5. **Deploy**. The first build will fetch deps + run `next build` + start the
   Node.js serverless functions. The `/api/proxy` route runs server-side only.

6. **Verify** by opening the deployed URL → record audio on `/audio-to-audio` →
   confirm transcript + translation + TTS playback all work end-to-end.

## Security notes

- All upstream calls go through `app/api/proxy/route.ts`. The browser sends
  only `{endpoint, body}` — never any `Authorization` header.
- The `GMB_KEYS` env var is read **only** server-side (`runtime = "nodejs"`).
  It will not be bundled into the client.
- Do not prefix `GMB_KEYS` with `NEXT_PUBLIC_` — that would expose it.
- `APP_PASSWORD` gate runs at the edge middleware (`middleware.ts`) and covers
  both static pages and API routes (Vercel's built-in Password Protection does
  not cover API routes, hence the custom middleware).
- For the cleanest deployment, disable Vercel Authentication in
  Settings → Deployment Protection so our middleware is the sole gate.

## Limitations / next steps

- LB key selection is a simple round-robin counter in memory. For production,
  swap in a smarter strategy (least-recently-used, weighted by recent error
  rate, etc.) and persist across serverless cold-starts via Upstash Redis.
- No streaming yet — large transcriptions could block. Consider server-sent
  events if user feedback demands it.
- Real-time / live streaming (Sub-task C from the original plan) is NOT yet
  implemented — current A2A path is upload-and-process. Live API WebSocket
  requires a separate session.
