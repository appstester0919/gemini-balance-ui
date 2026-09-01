/**
 * Single Next.js API route that proxies ALL /v1/* requests to the Deno backend.
 *
 * Client shape:
 *   POST /api/proxy
 *   { endpoint: "/v1/audio/transcriptions", body: { ... upstream payload ... } }
 *
 * Server-side flow:
 *   1. Pick a Gemini API key round-robin from process.env.GMB_KEYS (never to client).
 *   2. Forward JSON body to `${BACKEND}${endpoint}` with Authorization header.
 *   3. Return upstream JSON (or error) to client. Never echo the key.
 */

import { NextResponse } from "next/server";
import { proxyFetch, getKeyPool } from "@/lib/proxy";

export const runtime = "nodejs"; // uses process.env, needs full Node API
export const dynamic = "force-dynamic";

interface RequestBody {
  endpoint?: unknown;
  body?: unknown;
}

export async function POST(req: Request) {
  let parsed: RequestBody;
  try {
    parsed = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const endpoint = typeof parsed.endpoint === "string" ? parsed.endpoint : "";
  const body = parsed.body;

  if (!endpoint || !endpoint.startsWith("/v1/")) {
    return NextResponse.json(
      { ok: false, error: "endpoint must be a string starting with /v1/" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { ok: false, error: "body must be a JSON object" },
      { status: 400 },
    );
  }

  // If no keys configured, surface that explicitly so user knows what to fix.
  if (getKeyPool().length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Server is missing GMB_KEYS env var. Set it in Vercel project settings (comma-separated keys).",
      },
      { status: 500 },
    );
  }

  const result = await proxyFetch({ endpoint, body });

  // Echo upstream status so the client can react (e.g. 429 backoff).
  return NextResponse.json(
    result.ok
      ? { ok: true, data: result.data }
      : { ok: false, error: result.error, status: result.status },
    { status: result.ok ? 200 : result.status >= 400 ? result.status : 502 },
  );
}
