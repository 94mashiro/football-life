/**
 * CORS for /api/* — the SPA is served from the same Pages origin, but dev
 * (vite :5173 → wrangler :8788 via proxy) and any future domain need the
 * headers. Runs for every Functions route; static assets are untouched.
 */
import type { EventContext } from "./_types";

const CORS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

export async function onRequest(ctx: EventContext): Promise<Response> {
  if (ctx.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const res = await ctx.next();
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}
