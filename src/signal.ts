/**
 * Peer-to-peer signaling ("introductions") for hosted matches.
 *
 * The match itself runs in the host's browser (src/authority.worker.ts) and
 * travels over WebRTC data channels. This handler only stores short-lived room
 * listings, connection offers and answers so two browsers can find each other.
 * It runs as a Vercel Function (api/signal.ts) backed by Redis, and in the Vite
 * dev server backed by memory. Everything expires within ROOM_TTL / SDP_TTL.
 */
// Self-contained (no relative imports) so the Vercel Function loads it as plain ESM.
// Keep in sync with GAME_MODES in src/match.ts.
const MODES = ["teams", "br", "ffa", "ctf"];
const validMode = (value: unknown): string =>
  typeof value === "string" && MODES.includes(value) ? value : "teams";

export const ROOM_TTL = 25;
export const SDP_TTL = 60;
export const MAX_SDP = 20000;
const CODE = /^[-\w]{1,24}$/;
const PEER = /^[a-z0-9]{6,24}$/;

export interface SignalStore {
  get(key: string): Promise<string | null>;
  /** Returns false when nx is set and the key already exists. */
  set(key: string, value: string, ttl: number, nx?: boolean): Promise<boolean>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  srem(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  rpush(key: string, value: string, ttl: number): Promise<void>;
  /** Removes and returns up to count items from the head of a list. */
  lpop(key: string, count: number): Promise<string[]>;
}

export type RoomListing = {
  code: string;
  public: boolean;
  mode: string;
  humans: number;
  joinable: boolean;
  /** Matchmaking bracket of the host (0 rookie … 3 elite). */
  tier: number;
  updated: number;
  /** Secret shared with the migration successor; never returned to clients. */
  token?: string;
};
const TOKEN = /^[a-f0-9]{16,64}$/;
const publicView = (room: RoomListing) => {
  const { token, ...rest } = room;
  void token;
  return rest;
};
export type SignalResult = { status: number; body: unknown };

const roomKey = (code: string) => "wl:room:" + code;
const offerKey = (code: string) => "wl:offers:" + code;
const answerKey = (code: string, id: string) => "wl:answer:" + code + ":" + id;
const PUBLIC = "wl:public";

const bad = (message: string, status = 400): SignalResult => ({
  status,
  body: { error: message },
});
const ok = (body: unknown = { ok: true }): SignalResult => ({
  status: 200,
  body,
});

export async function handleSignal(
  store: SignalStore,
  input: unknown,
  now = Date.now(),
): Promise<SignalResult> {
  if (!input || typeof input !== "object") return bad("Invalid request.");
  const msg = input as Record<string, unknown>;
  const code = typeof msg.code === "string" ? msg.code : "";
  const id = typeof msg.id === "string" ? msg.id : "";
  const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
  switch (msg.action) {
    case "host": {
      // Register (create: true) or refresh a hosted room listing.
      if (!CODE.test(code)) return bad("Invalid party code.");
      const token = typeof msg.token === "string" && TOKEN.test(msg.token) ? msg.token : "";
      // Refreshes and migration takeovers must prove the listing's token.
      const existing = await store.get(roomKey(code));
      const owner = existing ? (JSON.parse(existing) as RoomListing).token : undefined;
      if (existing && owner && owner !== token) return bad("Party code already exists.", 409);
      const listing: RoomListing = {
        code,
        public: msg.public === true,
        mode: validMode(msg.mode),
        humans: Number.isInteger(msg.humans)
          ? Math.max(0, Math.min(30, msg.humans as number))
          : 1,
        joinable: msg.joinable !== false,
        tier: Number.isInteger(msg.tier) ? Math.max(0, Math.min(3, msg.tier as number)) : 0,
        updated: now,
        token: token || undefined,
      };
      const stored = await store.set(
        roomKey(code),
        JSON.stringify(listing),
        ROOM_TTL,
        msg.create === true && !(existing && owner === token),
      );
      if (!stored) return bad("Party code already exists.", 409);
      if (listing.public) await store.sadd(PUBLIC, code);
      return ok();
    }
    case "close": {
      if (!CODE.test(code)) return bad("Invalid party code.");
      const raw = await store.get(roomKey(code));
      const owner = raw ? (JSON.parse(raw) as RoomListing).token : undefined;
      if (owner && owner !== msg.token) return bad("Not the host of this party.", 403);
      await store.del(roomKey(code));
      await store.srem(PUBLIC, code);
      await store.del(offerKey(code));
      return ok();
    }
    case "room": {
      if (!CODE.test(code)) return bad("Invalid party code.");
      const raw = await store.get(roomKey(code));
      return raw ? ok(publicView(JSON.parse(raw))) : bad("Party not found.", 404);
    }
    case "find": {
      // Closest bracket first (within one), then the busiest joinable public room.
      const tier = Number.isInteger(msg.tier) ? (msg.tier as number) : 0;
      const exclude = (
        Array.isArray(msg.exclude) ? msg.exclude : [msg.exclude]
      ).filter((v): v is string => typeof v === "string");
      let best: RoomListing | null = null;
      for (const member of await store.smembers(PUBLIC)) {
        const raw = await store.get(roomKey(member));
        if (!raw) {
          await store.srem(PUBLIC, member);
          continue;
        }
        const room = JSON.parse(raw) as RoomListing;
        const gap = Math.abs((room.tier ?? 0) - tier);
        if (
          !exclude.includes(room.code) &&
          room.public &&
          room.joinable &&
          room.humans < 30 &&
          gap <= 1 &&
          (!best ||
            gap < Math.abs((best.tier ?? 0) - tier) ||
            (gap === Math.abs((best.tier ?? 0) - tier) && room.humans > best.humans))
        )
          best = room;
      }
      return ok({ room: best ? publicView(best) : null });
    }
    case "offer": {
      if (!CODE.test(code) || !PEER.test(id)) return bad("Invalid offer.");
      if (!sdp || sdp.length > MAX_SDP) return bad("Invalid offer.");
      if (!(await store.get(roomKey(code))))
        return bad("Party not found.", 404);
      await store.rpush(offerKey(code), JSON.stringify({ id, sdp }), SDP_TTL);
      return ok();
    }
    case "offers": {
      if (!CODE.test(code)) return bad("Invalid party code.");
      const offers = [];
      for (const raw of await store.lpop(offerKey(code), 10)) {
        try {
          const offer = JSON.parse(raw);
          if (
            PEER.test(offer.id) &&
            typeof offer.sdp === "string" &&
            offer.sdp.length <= MAX_SDP
          )
            offers.push(offer);
        } catch {
          // Ignore malformed entries.
        }
      }
      return ok({ offers });
    }
    case "answer": {
      if (!CODE.test(code) || !PEER.test(id)) return bad("Invalid answer.");
      if (!sdp || sdp.length > MAX_SDP) return bad("Invalid answer.");
      await store.set(answerKey(code, id), sdp, SDP_TTL);
      return ok();
    }
    case "poll": {
      if (!CODE.test(code) || !PEER.test(id)) return bad("Invalid request.");
      const answer = await store.get(answerKey(code, id));
      if (answer) await store.del(answerKey(code, id));
      return ok({ sdp: answer });
    }
    default:
      return bad("Unknown action.");
  }
}

/** Single-process store for the Vite dev server and tests. */
export class MemoryStore implements SignalStore {
  private values = new Map<string, { value: string; until: number }>();
  private sets = new Map<string, Set<string>>();
  private lists = new Map<string, { items: string[]; until: number }>();
  private live(until: number) {
    return until > Date.now();
  }
  async get(key: string) {
    const entry = this.values.get(key);
    if (!entry || !this.live(entry.until)) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }
  async set(key: string, value: string, ttl: number, nx = false) {
    if (nx && (await this.get(key)) !== null) return false;
    this.values.set(key, { value, until: Date.now() + ttl * 1000 });
    return true;
  }
  async del(key: string) {
    this.values.delete(key);
    this.lists.delete(key);
  }
  async sadd(key: string, member: string) {
    let set = this.sets.get(key);
    if (!set) this.sets.set(key, (set = new Set()));
    set.add(member);
  }
  async srem(key: string, member: string) {
    this.sets.get(key)?.delete(member);
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
  async rpush(key: string, value: string, ttl: number) {
    let list = this.lists.get(key);
    if (!list || !this.live(list.until))
      this.lists.set(key, (list = { items: [], until: 0 }));
    list.items.push(value);
    list.until = Date.now() + ttl * 1000;
  }
  async lpop(key: string, count: number) {
    const list = this.lists.get(key);
    if (!list || !this.live(list.until)) return [];
    return list.items.splice(0, count);
  }
}

/**
 * Upstash-compatible Redis REST store (what Vercel Marketplace Redis provides).
 * Uses plain fetch so the function has no extra dependencies.
 */
export class RedisRestStore implements SignalStore {
  constructor(
    private url: string,
    private token: string,
  ) {}
  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    const data = (await response.json()) as { result?: unknown; error?: string };
    if (!response.ok || data.error)
      throw new Error(data.error || "Redis request failed");
    return data.result;
  }
  async get(key: string) {
    return (await this.command(["GET", key])) as string | null;
  }
  async set(key: string, value: string, ttl: number, nx = false) {
    const args: (string | number)[] = ["SET", key, value, "EX", ttl];
    if (nx) args.push("NX");
    return (await this.command(args)) === "OK";
  }
  async del(key: string) {
    await this.command(["DEL", key]);
  }
  async sadd(key: string, member: string) {
    await this.command(["SADD", key, member]);
  }
  async srem(key: string, member: string) {
    await this.command(["SREM", key, member]);
  }
  async smembers(key: string) {
    return ((await this.command(["SMEMBERS", key])) as string[]) ?? [];
  }
  async rpush(key: string, value: string, ttl: number) {
    await this.command(["RPUSH", key, value]);
    await this.command(["EXPIRE", key, ttl]);
  }
  async lpop(key: string, count: number) {
    const result = await this.command(["LPOP", key, count]);
    return Array.isArray(result) ? (result as string[]) : [];
  }
}
