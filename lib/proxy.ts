/**
 * Server-side fetch wrapper. This module is imported ONLY by server code
 * (Next.js API routes) because it reads process.env.GMB_KEYS which must
 * never reach the browser bundle.
 *
 * The Deno proxy at https://gemini-balance-lite.appstester0919.deno.net
 * expects `Authorization: Bearer <one of the LB-pool keys>`. We pick a
 * key round-robin (simple in-memory counter) so all keys share the load.
 *
 * For dev, if GMB_KEYS is empty, we still attempt the request — the user
 * can wire a custom backend URL (e.g. localhost) for local testing.
 */

export const DEFAULT_BACKEND = "https://gemini-balance-lite.appstester0919.deno.net";

export interface ProxyResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

function getBackend(): string {
  return process.env.GMB_BACKEND_URL || DEFAULT_BACKEND;
}

/** Parse the GMB_KEYS env var into an array. Trims, drops empties. */
export function getKeyPool(): string[] {
  const raw = process.env.GMB_KEYS || "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/** In-memory round-robin counter. Fine for dev; for prod, prefer a real LB. */
let _rr = 0;
export function pickKey(): string | undefined {
  const pool = getKeyPool();
  if (pool.length === 0) return undefined;
  const key = pool[_rr % pool.length];
  _rr = (_rr + 1) >>> 0; // keep as uint32
  return key;
}

interface ProxyOpts {
  endpoint: string; // e.g. "/v1/audio/transcriptions"
  body: unknown;    // JSON-serialisable payload
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function proxyFetch<T = unknown>(opts: ProxyOpts): Promise<ProxyResult<T>> {
  const { endpoint, body, timeoutMs = 60_000, signal } = opts;

  const url = `${getBackend()}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
  const key = pickKey();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }

  // Compose AbortSignal for timeout + caller-supplied signal.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error(`proxy timeout after ${timeoutMs}ms`)), timeoutMs);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
      // Never cache — every request may hit a different upstream key.
      cache: "no-store",
    });

    const text = await resp.text();
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!resp.ok) {
      const obj = parsed as { error?: unknown; message?: unknown } | null;
      const errMsg =
        (obj && typeof obj === "object" && (obj.error || obj.message)
          ? String(obj.error ?? obj.message)
          : `upstream ${resp.status}`);
      return { ok: false, status: resp.status, error: errMsg };
    }

    return { ok: true, status: resp.status, data: parsed as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: msg };
  } finally {
    clearTimeout(t);
  }
}
