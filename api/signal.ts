/**
 * Vercel Function: peer-to-peer signaling for hosted matches (see src/signal.ts).
 * Needs a Redis database from the Vercel Marketplace (free tier is enough); its
 * KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*) variables are
 * added to the project automatically when the database is connected.
 */
import {
  handleSignal,
  MemoryStore,
  RedisRestStore,
  type SignalStore,
} from "../src/signal.js";

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
// Memory only works within one process, so it is limited to local `vercel dev`.
const store: SignalStore | null =
  url && token
    ? new RedisRestStore(url, token)
    : process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "development"
      ? null
      : new MemoryStore();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

export async function GET(): Promise<Response> {
  return json(store ? 200 : 503, {
    status: store ? "ok" : "missing-store",
    store: url && token ? "redis" : store ? "memory" : "none",
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!store)
    return json(503, {
      error:
        "Online play needs a Redis database. Connect one from the Vercel Marketplace and redeploy.",
    });
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 65536) return json(413, { error: "Request too large." });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON." });
  }
  try {
    const result = await handleSignal(store, body);
    return json(result.status, result.body);
  } catch {
    return json(502, { error: "Signaling store unavailable." });
  }
}
