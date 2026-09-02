/**
 * Stub endpoint that exists so the WebSocket URL
 *   ws(s)://<this-app>/live-speaker
 * resolves to something during local dev. The real live backend lives in
 * `/mnt/d/AI/gemini-balance-live` (a separate Deno deployment) and is
 * reached via `NEXT_PUBLIC_LIVE_WS_URL` when configured.
 *
 * Returning 426 with the upgrade header tells the browser (and any client
 * library) to retry as a WebSocket if the deployment has one, and gives a
 * useful hint to anyone hitting the HTTP path by accident.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return new NextResponse(
    "This endpoint is a WebSocket. Connect with `new WebSocket(...)` or set NEXT_PUBLIC_LIVE_WS_URL to the real live backend.",
    {
      status: 426,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Upgrade: "websocket",
        Connection: "Upgrade",
      },
    },
  );
}

// Head method returns the same hint; useful for health-check tools.
export function HEAD() {
  return GET();
}
