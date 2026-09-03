/**
 * lib/live-ws.ts
 *
 * Centralised WebSocket URL resolution for the Live Translation feature.
 *
 * The browser opens WebSockets DIRECTLY to the Deno backend
 * (gemini-balance-lite.appstester0919.deno.net) — they do NOT go through
 * the Vercel-hosted Next.js frontend. Reason: Vercel's edge runs HTTP only,
 * and the frontend's Basic Auth middleware would block unauthenticated WS
 * upgrades before the request ever reaches a Deno server.
 *
 * Auth at the WS handshake
 * ------------------------
 * The Deno `/ws/live` and `/ws/listen` endpoints honour two handshake
 * headers:
 *   - `Authorization: Bearer <gemini-key>`
 *   - `x-goog-api-key: <gemini-key>`
 * BUT: the browser WebSocket API does NOT expose a way to set custom
 * handshake headers. Passing keys via `Sec-WebSocket-Protocol` is the only
 * browser-side trick, and it's brittle (subprotocol lists are echoed in
 * Deno logs as plaintext).
 *
 * Therefore, in production the backend MUST be configured with the
 * `GMB_KEYS` env var (comma-separated Gemini API keys) on the Deno
 * Deploy dashboard. The browser never holds a Gemini key.
 *
 * This file is safe to import from client components: the constants and
 * env-var reads are public and ship with the JS bundle.
 */

/**
 * Default Deno backend WebSocket origin. Matches DEFAULT_BACKEND in
 * lib/proxy.ts (which serves the same Deno deployment for HTTP traffic).
 */
export const DEFAULT_LIVE_BACKEND =
  "wss://gemini-balance-lite.appstester0919.deno.net";

/** Speaker (mic capture) WebSocket path. */
export const DEFAULT_SPEAK_PATH = "/ws/live";

/** Listener (audio playback) WebSocket path. Requires `?session=<id>`. */
export const DEFAULT_LISTEN_PATH = "/ws/listen";

/**
 * Build the speaker (mic capture) WebSocket URL.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_LIVE_WS_URL` env var — overrides the whole URL (e.g.
 *      `wss://my-test-host.example.com/ws/live` for staging). Useful for
 *      pointing at `ws://localhost:8000/ws/live` during local dev.
 *   2. Otherwise: `${DEFAULT_LIVE_BACKEND}${DEFAULT_SPEAK_PATH}` — direct
 *      connection to the production Deno backend.
 *
 * `sessionId` is appended as a `?session=<id>` query parameter so the
 * backend's `url.searchParams.get("session")` (live_handler.ts:46) can
 * reuse an existing session for the 9-minute upstream rotate.
 */
export function resolveSpeakerWsUrl(sessionId: string): string {
  const base =
    process.env.NEXT_PUBLIC_LIVE_WS_URL?.trim() ||
    `${DEFAULT_LIVE_BACKEND}${DEFAULT_SPEAK_PATH}`;
  // Append sessionId — backend reuses it across the 9-min upstream rotate.
  // URL-encode in case a future caller passes a weird id.
  return `${base}${base.includes("?") ? "&" : "?"}session=${encodeURIComponent(sessionId)}`;
}

/**
 * Build the listener (audio playback) WebSocket URL.
 *
 * The Deno `/ws/listen` endpoint requires `?session=<id>` to know which
 * upstream room to subscribe to. Authentication, if any, is handled by
 * the backend's `GMB_KEYS` env var — not by this URL.
 */
export function resolveListenerWsUrl(sessionId: string): string {
  return `${DEFAULT_LIVE_BACKEND}${DEFAULT_LISTEN_PATH}?session=${encodeURIComponent(sessionId)}`;
}
