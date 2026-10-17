/**
 * Vercel Function: peer-to-peer signaling for hosted matches (see src/signal.ts).
 * Needs a Redis database connected to the project (free tier is enough). Either:
 * - REDIS_URL (redis:// or rediss://, Vercel's Redis integration), or
 * - KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*), Upstash REST.
 */
import { createClient } from "redis";
import {
  handleSignal,
  MemoryStore,
  RedisRestStore,
  type SignalStore,
} from "../src/signal.js";

const makeClient = (url: string) =>
  createClient({
    url,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
type Client = ReturnType<typeof makeClient>;
/** Standard Redis protocol store; one connection reused across invocations. */
class RedisTcpStore implements SignalStore {
  private ready: Promise<Client> | null = null;
  constructor(private url: string) {}
  private connection(): Promise<Client> {
    if (!this.ready) {
      const client = makeClient(this.url);
      // Drop a broken connection; the next request reconnects.
      client.on("error", () => (this.ready = null));
      const ready = client.connect().then(() => client);
      ready.catch(() => (this.ready = null));
      this.ready = ready;
    }
    return this.ready;
  }
  async get(key: string) {
    return (await this.connection()).get(key);
  }
  async set(key: string, value: string, ttl: number, nx = false) {
    const result = await (
      await this.connection()
    ).set(key, value, {
      expiration: { type: "EX", value: ttl },
      ...(nx ? { condition: "NX" as const } : {}),
    });
    return result === "OK";
  }
  async del(key: string) {
    await (await this.connection()).del(key);
  }
  async sadd(key: string, member: string) {
    await (await this.connection()).sAdd(key, member);
  }
  async srem(key: string, member: string) {
    await (await this.connection()).sRem(key, member);
  }
  async smembers(key: string) {
    return (await this.connection()).sMembers(key);
  }
  async rpush(key: string, value: string, ttl: number) {
    const c = await this.connection();
    await c.rPush(key, value);
    await c.expire(key, ttl);
  }
  async lpop(key: string, count: number) {
    return ((await (await this.connection()).lPopCount(key, count)) ?? []) as string[];
  }
}

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redisUrl = process.env.REDIS_URL || process.env.KV_URL;
// Memory only works within one process, so it is limited to local `vercel dev`.
const store: SignalStore | null =
  url && token
    ? new RedisRestStore(url, token)
    : redisUrl
      ? new RedisTcpStore(redisUrl)
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
    store: url && token ? "redis-rest" : redisUrl ? "redis" : store ? "memory" : "none",
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!store)
    return json(503, {
      error:
        "Online play needs a Redis database (REDIS_URL or KV_REST_API_*). Connect one in Vercel Storage and redeploy.",
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
