/**
 * Transport-neutral match authority: rooms, combat, bots, modes and snapshots.
 * Runs in Node behind the `ws` server (server/index.ts) and in a browser Worker
 * when a player hosts a peer-to-peer match (src/authority.worker.ts).
 */
import {
  WEAPONS,
  FIREARM_MASK,
  FIREARM_IDS,
  validWeapon,
  firstWeapon,
  stormRadius,
  stormDamage,
  axeReach,
  STORM_START_RADIUS,
  ASSIST_CREDIT_SECONDS,
  KILL_POINTS,
  UNARMED,
  MEDKIT_HEAL,
  CHEST_MEDKIT_CHANCE,
  MEDKIT_DROP_CHANCE,
  chestWeapon,
  chestAmmo,
} from "./combat";
import {
  MAX_PARTICIPANTS,
  TEAM_SIZE,
  type GameMode,
  validMode,
  soloMode,
  respawnMode,
  stormMode,
  timeLimit,
  hostile,
  baseX,
  FFA_KILL_TARGET,
  CTF_CAPTURE_TARGET,
  RESPAWN_SECONDS,
  FLAG_REACH,
  WINNER_INDIVIDUAL,
} from "./match";
import { SKINS, TIER_DIFFICULTY } from "./profile";
import { STAMINA_DRAIN, STAMINA_REGEN } from "./entities";
import { randomPlayerName } from "./names";
import {
  Chunk,
  CHUNK,
  seedHash,
  hash,
  terrainHeight,
  STRUCTURE,
  STRUCTURE_RADIUS,
  MEDKIT,
  blockedSpot,
} from "./world";

type Actor = {
  id: number;
  x: number;
  y: number;
  angle: number;
  health: number;
  supplies: number;
  name: string;
  room: Room | null;
  lastMove: number;
  lastShot: number;
  deadUntil: number;
  ready: boolean;
  team: number;
  bot: boolean;
  skin: number;
  weapon: number;
  startingWeapon: number;
  magazine: number;
  reserve: number;
  reloading: number;
  inventory: number;
  kills: number;
  hidden: boolean;
  /** Last human attacker (0 = none), used to credit kills finished by bots or the storm. */
  lastHitBy: number;
  lastHitAt: number;
  lastHitWeapon: number;
  /** Server-side sprint stamina mirroring src/entities.ts. */
  stamina: number;
  /** Respawn modes: untargetable until this time (ms) unless they attack first. */
  shieldUntil?: number;
};
type Player = Actor & {
  /** Private token that lets this player reclaim their slot after host migration. */
  resume: string;
  ws: Conn;
  budget: number;
  budgetAt: number;
  alive: boolean;
};
type Bot = Actor & {
  active: boolean;
  /** Battle royale: cached chest the unarmed bot is heading to (re-scanned every 2 s). */
  chest?: { cx: number; cy: number; i: number; x: number; y: number; at: number };
};
type Edit = { x: number; y: number; i: number; hp: number };
type Flag = { x: number; y: number; carrier: number; home: boolean };
type Room = {
  name: string;
  /** Snapshot bookkeeping (compact deltas). */
  snapshotCount?: number;
  lastRoster?: number;
  lastLoots?: string;
  /** Matchmaking bracket of the creating player (public rooms). */
  tier: number;
  mode: GameMode;
  winnerId: number;
  flags: [Flag, Flag];
  captures: [number, number];
  seed: string;
  relief: number;
  density: number;
  players: Map<number, Player>;
  edits: Map<string, Edit>;
  public: boolean;
  infiniteAmmo: boolean;
  weapons: number;
  botsEnabled: boolean;
  botDifficulty: number;
  hasOpposition: boolean;
  eliminationSerial: number;
  hostId: number;
  round: number;
  startedAt: number;
  winner: number;
  elapsed: number;
  radius: number;
  loots: {
    id: number;
    x: number;
    y: number;
    weapon: number;
    ammo: number;
    gun: boolean;
    /** Medkit health restored on pickup (0 = not a medkit). */
    heal: number;
  }[];
  lootSerial: number;
  bots: Bot[];
};
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
function intersection(
  x: number,
  y: number,
  dx: number,
  dy: number,
  tx: number,
  ty: number,
  r: number,
): number {
  const a = (tx - x) * dx + (ty - y) * dy,
    d2 = (tx - x) ** 2 + (ty - y) ** 2 - a * a;
  if (a < 0 || d2 > r * r) return Infinity;
  return Math.max(0, a - Math.sqrt(Math.max(0, r * r - d2)));
}
/** Minimal connection surface implemented by WebSocket and WebRTC adapters. */
export interface Conn {
  readonly open: boolean;
  readonly buffered: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  /** Optional keepalive; transports without ping detect closure themselves. */
  ping?: () => void;
  /** The hosting browser's own player (never chosen as migration successor). */
  local?: boolean;
}
export interface ConnHandlers {
  message(data: Uint8Array | string, binary: boolean): void;
  closed(): void;
  pong(): void;
}
const decoder = new TextDecoder();
function hexId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function randInt(max: number): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] % max;
}
/** Timestamp fields stored relative to "now" in backups so clock skew between hosts is harmless. */
const TIME_KEYS = [
  "lastMove",
  "lastShot",
  "deadUntil",
  "reloading",
  "lastHitAt",
  "shieldUntil",
  "budgetAt",
] as const;
const FOREVER = Number.MAX_SAFE_INTEGER;
const SKIP_KEYS = new Set(["ws", "room", "chest", "alive", "budget"]);
function actorState(a: Record<string, unknown>, now: number) {
  const out: Record<string, unknown> = {};
  for (const key in a) if (!SKIP_KEYS.has(key)) out[key] = a[key];
  for (const key of TIME_KEYS) {
    const v = out[key];
    if (typeof v === "number" && v && v !== FOREVER) out[key] = v - now;
  }
  return out;
}
function absolute<T extends Record<string, unknown>>(a: T, now: number): T {
  for (const key of TIME_KEYS) {
    const v = a[key];
    if (typeof v === "number" && v && v !== FOREVER)
      (a as Record<string, unknown>)[key] = v + now;
  }
  return a;
}
export type AuthorityOptions = {
  /** Send a once-per-second state backup to one remote player (browser hosting). */
  backups?: boolean;
};
export function createAuthority(options: AuthorityOptions = {}) {
  const rooms = new Map<string, Room>(),
    clients = new Set<Player>(),
    // Generated chunks are deterministic and never mutated (edits live in room.edits),
    // so a fixed cache removes most terrain-noise work from bot/cover checks.
    chunkCache = Array.from({ length: 2048 }, () => new Chunk()),
    chunkKeys = new Map<string, number>(),
    slotKeys: string[] = Array(2048).fill(""),
    probe = new Chunk(),
    // Players restored from a migration backup, waiting to reclaim their slot.
    pending = new Map<string, { data: Record<string, unknown>; room: Room; until: number }>();
  let backupToken = "";
  let scratch = chunkCache[0],
    chunkCursor = 0;
  function chunkAt(
    seed: number,
    cx: number,
    cy: number,
    relief: number,
    density: number,
  ): Chunk {
    const key = seed + ":" + cx + ":" + cy + ":" + relief + ":" + density;
    const hit = chunkKeys.get(key);
    if (hit !== undefined) return chunkCache[hit];
    const slot = chunkCursor++ % chunkCache.length,
      chunk = chunkCache[slot];
    if (slotKeys[slot]) chunkKeys.delete(slotKeys[slot]);
    chunk.generate(seed, cx, cy, relief, density);
    chunkKeys.set(key, slot);
    slotKeys[slot] = key;
    return chunk;
  }
  let serial = 1;
  const send = (p: Player, data: unknown) => {
    if (p.ws.open && p.ws.buffered < 65536)
      p.ws.send(JSON.stringify(data));
  };
  const broadcast = (room: Room, data: unknown) => {
    const text = JSON.stringify(data);
    for (const p of room.players.values())
      if (p.ws.open && p.ws.buffered < 65536)
        p.ws.send(text);
  };
  const spawn = (p: Actor) => {
    const r = p.room!;
    const seed = seedHash(r.seed);
    for (let attempt = 0; attempt < 40; attempt++) {
      const slot = p.bot ? -p.id - 1 : (p.id * 7) % MAX_PARTICIPANTS;
      const angle =
          (slot / MAX_PARTICIPANTS +
            hash(seed, slot, 11) * 0.01 +
            attempt * 0.381966) *
          Math.PI *
          2,
        radius =
          1100 + (slot % 3) * 420 + hash(seed, slot, attempt + 91) * 200;
      const ctf = r.mode === "ctf",
        br = r.mode === "br",
        // Battle royale scatters everyone across the island, far apart.
        brAngle = hash(seed, slot + 101, attempt + 3) * Math.PI * 2,
        brRadius = 1500 + hash(seed, slot + 101, attempt + 5) * 4800,
        gap = br ? 900 : 180,
        x = ctf
          ? baseX(p.team) + (hash(seed, slot, attempt + 7) - 0.5) * 360
          : br
            ? Math.cos(brAngle) * brRadius
            : Math.cos(angle) * radius,
        y = ctf
          ? (hash(seed, slot, attempt + 13) - 0.5) * 700
          : br
            ? Math.sin(brAngle) * brRadius
            : Math.sin(angle) * radius;
      // Never spawn in water or inside a building.
      if (blockedSpot(seed, x, y, r.relief, r.density, probe)) continue;
      let clear = true;
      for (const other of r.players.values())
        if (
          other !== p &&
          other.ready &&
          Math.hypot(x - other.x, y - other.y) < gap
        ) {
          clear = false;
          break;
        }
      if (clear)
        for (const bot of r.bots)
          if (
            bot !== p &&
            bot.active &&
            bot.health > 0 &&
            Math.hypot(x - bot.x, y - bot.y) < gap
          ) {
            clear = false;
            break;
          }
      p.x = x;
      p.y = y;
      if (clear) break;
    }
    p.health = 100;
    p.stamina = 100;
    p.deadUntil = 0;
    p.lastHitBy = 0;
    p.lastHitAt = 0;
    p.magazine = WEAPONS[p.weapon].magazine;
    p.reserve = WEAPONS[p.weapon].reserve;
    p.reloading = 0;
    p.lastMove = Date.now();
    if (p.bot) p.lastShot = Date.now();
  };
  const error = (p: Player, message: string) =>
    send(p, { t: "error", message });
  const enemies = (room: Room, a: Actor, b: Actor) =>
    hostile(room.mode, a.id, a.team, b.id, b.team);
  const actorById = (room: Room, id: number): Actor | undefined =>
    id < 0 ? room.bots[-id - 1] : room.players.get(id);
  const resetFlags = (room: Room) => {
    for (let t = 0; t < 2; t++) {
      const f = room.flags[t];
      f.x = baseX(t);
      f.y = 0;
      f.carrier = 0;
      f.home = true;
    }
    room.captures[0] = room.captures[1] = 0;
  };
  function attack(p: Actor, angle: number, weapon: number) {
    const now = Date.now(),
      room = p.room;
    if (
      !room ||
      (weapon !== 1 && !validWeapon(weapon)) ||
      !p.ready ||
      p.health <= 0 ||
      room.winner !== -1 ||
      (weapon !== 1 && weapon !== p.weapon) ||
      (weapon !== 1 && !(room.weapons & (1 << weapon))) ||
      (weapon !== 1 &&
        (p.reloading > now || (!room.infiniteAmmo && p.magazine <= 0))) ||
      now - p.lastShot < WEAPONS[weapon].cooldown * 1000 - 12
    )
      return;
    p.lastShot = now;
    p.shieldUntil = 0; // attacking ends spawn protection
    if (weapon !== 1 && !room.infiniteAmmo) p.magazine--;
    p.angle = angle;
    const dx = Math.cos(angle),
      dy = Math.sin(angle),
      range = WEAPONS[weapon].range;
    let nearest: number = range,
      victim: Actor | null = null,
      cx = 0,
      cy = 0,
      index = -1,
      hp = 0;
    const consider = (other: Actor) => {
      if (
        other !== p &&
        other.ready &&
        other.health > 0 &&
        !((other.shieldUntil ?? 0) > now) &&
        enemies(room, p, other)
      ) {
        const d =
          weapon === 1
            ? axeReach(p.x, p.y, angle, other.x, other.y, 19)
            : intersection(p.x, p.y, dx, dy, other.x, other.y, 19);
        if (d < nearest) {
          nearest = d;
          victim = other;
        }
      }
    };
    for (const other of room.players.values()) consider(other);
    for (const bot of room.bots) if (bot.active) consider(bot);
    const pad = weapon === 1 ? range + 24 : 0;
    const minX = Math.floor(
        (weapon === 1 ? p.x - pad : Math.min(p.x, p.x + dx * range)) / CHUNK,
      ),
      maxX = Math.floor(
        (weapon === 1 ? p.x + pad : Math.max(p.x, p.x + dx * range)) / CHUNK,
      ),
      minY = Math.floor(
        (weapon === 1 ? p.y - pad : Math.min(p.y, p.y + dy * range)) / CHUNK,
      ),
      maxY = Math.floor(
        (weapon === 1 ? p.y + pad : Math.max(p.y, p.y + dy * range)) / CHUNK,
      );
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        scratch = chunkAt(seedHash(room.seed), x, y, room.relief, room.density);
        for (let i = 0; i < scratch.count; i++)
          if (scratch.kind[i] < 2 || scratch.kind[i] === STRUCTURE) {
            const health =
              room.edits.get(`${x},${y},${i}`)?.hp ?? scratch.hp[i];
            if (health <= 0) continue;
            const r =
              scratch.kind[i] === STRUCTURE
                ? STRUCTURE_RADIUS
                : scratch.kind[i] === 0
                  ? 18
                  : 24;
            const d =
              weapon === 1
                ? axeReach(p.x, p.y, angle, scratch.ox[i], scratch.oy[i], r)
                : intersection(
                    p.x,
                    p.y,
                    dx,
                    dy,
                    scratch.ox[i],
                    scratch.oy[i],
                    r,
                  );
            if (d < nearest) {
              nearest = d;
              victim = null;
              cx = x;
              cy = y;
              // Structures absorb the shot without taking damage.
              index = scratch.kind[i] === STRUCTURE ? -2 : i;
              hp = health;
            }
          }
      }
    broadcast(room, { t: "shot", id: p.id, x: p.x, y: p.y, angle, weapon });
    if (victim) {
      const target = victim as Actor;
      if (!p.bot) {
        // Position and damage let the shooter show a floating damage number.
        send(p as Player, {
          t: "hit",
          x: Math.round(target.x),
          y: Math.round(target.y),
          d: WEAPONS[weapon].damage,
        });
        target.lastHitBy = p.id;
        target.lastHitAt = now;
        target.lastHitWeapon = weapon;
      }
      target.health = Math.max(
        0,
        target.health -
          // Bots hit with a share of their actual weapon's damage.
          (p.bot
            ? Math.min(
                25,
                Math.round(WEAPONS[weapon].damage * 0.45 * room.botDifficulty),
              )
            : WEAPONS[weapon].damage),
      );
      if (target.health === 0) {
        eliminate(room, target, p, weapon);
      }
    } else if (index >= 0) {
      hp = Math.max(0, hp - (weapon === 1 ? 35 : 20));
      edit(room, cx, cy, index, hp);
      if (!p.bot) send(p as Player, { t: "hit" });
      if (hp === 0) p.supplies += 2;
    }
  }
  function eliminate(
    room: Room,
    target: Actor,
    killer?: Actor,
    weapon = 0,
  ): void {
    if (target.deadUntil !== 0) return;
    // A bot or the storm finishing a human's recent target credits that human.
    if (
      (!killer || killer.bot) &&
      target.lastHitBy &&
      Date.now() - target.lastHitAt < ASSIST_CREDIT_SECONDS * 1000
    ) {
      const human = room.players.get(target.lastHitBy);
      if (human && human.ready && enemies(room, human, target)) {
        killer = human;
        weapon = target.lastHitWeapon;
      }
    }
    target.health = 0;
    target.deadUntil = respawnMode(room.mode)
      ? Date.now() + RESPAWN_SECONDS * 1000
      : Number.MAX_SAFE_INTEGER;
    if (room.loots.length >= 96) room.loots.shift();
    // Gun and ammo drop as separate items; sometimes a medkit too.
    const armed = validWeapon(target.weapon),
      drop = (dx: number, dy: number, gun: boolean, ammo: number, heal: number) => {
        if (room.loots.length >= 96) room.loots.shift();
        room.loots.push({
          id: ++room.lootSerial,
          x: target.x + dx,
          y: target.y + dy,
          weapon: armed ? target.weapon : 0,
          ammo,
          gun,
          heal,
        });
      };
    if (armed) drop(-20, 0, true, 0, 0);
    // Bots carry deep reserves; cap dropped ammo so kills do not flood the map.
    const ammo = Math.min(
      60,
      armed ? Math.max(12, target.reserve + target.magazine) : target.reserve,
    );
    if (ammo > 0) drop(20, 0, false, ammo, 0);
    if (randInt(1000) < MEDKIT_DROP_CHANCE * 1000) drop(0, 26, false, 0, MEDKIT_HEAL);
    if (killer) {
      killer.kills++;
      killer.supplies += KILL_POINTS;
    }
    broadcast(room, {
      t: "elimination",
      serial: ++room.eliminationSerial,
      killerId: killer?.id ?? 0,
      killer: killer?.name ?? "Storm",
      victim: target.name,
      weapon,
      kills: killer?.kills ?? 0,
      x: Math.round(target.x),
      y: Math.round(target.y),
    });
  }
  function reload(p: Actor): void {
    if (!p.room || p.room.winner !== -1 || !p.ready || p.health <= 0) return;
    if (
      p.reloading ||
      p.magazine >= WEAPONS[p.weapon].magazine ||
      p.reserve <= 0
    )
      return;
    p.reloading = Date.now() + WEAPONS[p.weapon].reload * 1000;
  }
  function pickLoot(p: Actor, guns = false): void {
    const r = p.room!;
    for (let n = r.loots.length - 1; n >= 0; n--) {
      const loot = r.loots[n];
      if (Math.hypot(p.x - loot.x, p.y - loot.y) > 70) continue;
      if (loot.ammo) {
        p.reserve = Math.min(240, p.reserve + loot.ammo);
        loot.ammo = 0;
      }
      if (loot.heal && p.health < 100) {
        p.health = Math.min(100, p.health + loot.heal);
        loot.heal = 0;
      }
      if (guns && loot.gun && r.weapons & (1 << loot.weapon)) {
        p.inventory |= 1 << loot.weapon;
        p.weapon = loot.weapon;
        p.reloading = 0;
        p.magazine = 0;
        reload(p);
        loot.gun = false;
      }
      if (!loot.ammo && !loot.gun && !loot.heal) r.loots.splice(n, 1);
    }
  }
  function covered(r: Room, p: Actor): boolean {
    if (Date.now() - p.lastShot < 1200) return false;
    const cx = Math.floor(p.x / CHUNK),
      cy = Math.floor(p.y / CHUNK);
    scratch = chunkAt(seedHash(r.seed), cx, cy, r.relief, r.density);
    for (let n = 0; n < scratch.count; n++)
      if (
        (scratch.kind[n] === 0 || scratch.kind[n] === 4) &&
        (r.edits.get(`${cx},${cy},${n}`)?.hp ?? scratch.hp[n]) > 0 &&
        Math.hypot(p.x - scratch.ox[n], p.y - scratch.oy[n]) < 42
      )
        return true;
    return false;
  }
  function respawn(r: Room, p: Actor): void {
    p.weapon = p.startingWeapon;
    p.inventory = p.bot ? r.weapons : 1 << p.weapon;
    p.hidden = false;
    spawn(p);
    p.shieldUntil = Date.now() + 2000;
  }
  function updateFlags(r: Room): void {
    for (let t = 0; t < 2; t++) {
      const flag = r.flags[t];
      if (flag.carrier) {
        const carrier = actorById(r, flag.carrier);
        if (carrier && carrier.ready && carrier.health > 0) {
          flag.x = carrier.x;
          flag.y = carrier.y;
          // Capture: enemy flag carried to the carrier's base while their own flag is home.
          const own = r.flags[carrier.team];
          if (
            own.home &&
            Math.hypot(carrier.x - baseX(carrier.team), carrier.y) < FLAG_REACH * 2
          ) {
            r.captures[carrier.team]++;
            flag.x = baseX(t);
            flag.y = 0;
            flag.carrier = 0;
            flag.home = true;
            carrier.supplies += 10;
            broadcast(r, {
              t: "capture",
              team: carrier.team,
              name: carrier.name,
              captures: r.captures,
            });
          }
          continue;
        }
        flag.carrier = 0; // dropped where the carrier fell
      }
      const visit = (a: Actor) => {
        if (flag.carrier || !a.ready || a.health <= 0) return;
        if (Math.hypot(a.x - flag.x, a.y - flag.y) > FLAG_REACH) return;
        if (a.team !== t) {
          flag.carrier = a.id;
          flag.home = false;
        } else if (!flag.home) {
          flag.x = baseX(t);
          flag.y = 0;
          flag.home = true;
        }
      };
      for (const p of r.players.values()) visit(p);
      for (const b of r.bots) if (b.active) visit(b);
    }
  }
  function nearHuman(room: Room, actor: Actor): boolean {
    for (const p of room.players.values())
      if (
        p.ready &&
        Math.abs(actor.x - p.x) < 1400 &&
        Math.abs(actor.y - p.y) < 1100
      )
        return true;
    return false;
  }
  function matchTick(r: Room, now: number): void {
    if (!r.startedAt || r.winner !== -1) return;
    r.elapsed = (now - r.startedAt) / 1000;
    r.radius = stormMode(r.mode)
      ? stormRadius(r.elapsed, r.mode === "br")
      : STORM_START_RADIUS;
    let team0 = 0,
      team1 = 0,
      alive = 0,
      lastAlive: Actor | undefined,
      leader: Actor | undefined,
      tied = false;
    const tick = (p: Actor) => {
      if (!p.ready) return;
      if (!leader || p.kills > leader.kills) {
        leader = p;
        tied = false;
      } else if (p.kills === leader.kills) tied = true;
      if (p.health <= 0) {
        if (respawnMode(r.mode) && p.deadUntil && now >= p.deadUntil)
          respawn(r, p);
        else return;
      }
      if (p.reloading && now >= p.reloading) {
        const amount = Math.min(
          WEAPONS[p.weapon].magazine - p.magazine,
          p.reserve,
        );
        p.magazine += amount;
        p.reserve -= amount;
        p.reloading = 0;
      }
      p.hidden = covered(r, p);
      if (Math.hypot(p.x, p.y) > r.radius && p.bot && !nearHuman(r, p)) {
        // Bots far from every human are not simulated; rotate them in instead of an unseen storm death.
        const scale = (r.radius * 0.85) / Math.hypot(p.x, p.y);
        p.x *= scale;
        p.y *= scale;
      } else if (Math.hypot(p.x, p.y) > r.radius) {
        p.health = Math.max(
          0,
          p.health - stormDamage(r.elapsed, r.mode === "br") * 0.1,
        );
        if (p.health === 0) eliminate(r, p);
      }
      // Eliminated this tick (storm): no pickups, including their own drop.
      if (p.health <= 0) return;
      pickLoot(p, p.bot);
      if (p.health > 0) {
        p.team === 0 ? team0++ : team1++;
        alive++;
        lastAlive = p;
      }
    };
    for (const p of r.players.values()) tick(p);
    for (const b of r.bots) if (b.active) tick(b);
    if (r.mode === "ctf") updateFlags(r);
    const limit = timeLimit(r.mode),
      overtime = limit > 0 && r.elapsed >= limit;
    if (r.mode === "teams") {
      if (team0 > 0 && team1 > 0) r.hasOpposition = true;
      if (
        (r.hasOpposition || team0 + team1 === 0) &&
        (team0 === 0 || team1 === 0)
      )
        r.winner = team0 > 0 ? 0 : team1 > 0 ? 1 : 2;
    } else if (r.mode === "br") {
      if (alive > 1) r.hasOpposition = true;
      if ((r.hasOpposition && alive <= 1) || (r.startedAt && alive === 0)) {
        r.winner = alive === 1 ? WINNER_INDIVIDUAL : 2;
        r.winnerId = alive === 1 ? lastAlive!.id : 0;
      }
    } else if (r.mode === "ffa") {
      if (alive > 1) r.hasOpposition = true;
      const top = leader as Actor | undefined;
      if (top && (top.kills >= FFA_KILL_TARGET || (overtime && r.hasOpposition))) {
        r.winner = tied && top.kills < FFA_KILL_TARGET ? 2 : WINNER_INDIVIDUAL;
        r.winnerId = r.winner === WINNER_INDIVIDUAL ? top.id : 0;
      }
    } else {
      if (team0 > 0 && team1 > 0) r.hasOpposition = true;
      const [c0, c1] = r.captures;
      if (c0 >= CTF_CAPTURE_TARGET || c1 >= CTF_CAPTURE_TARGET)
        r.winner = c0 > c1 ? 0 : 1;
      else if (overtime && r.hasOpposition)
        r.winner = c0 === c1 ? 2 : c0 > c1 ? 0 : 1;
    }
  }
  function edit(room: Room, x: number, y: number, i: number, hp: number) {
    const key = `${x},${y},${i}`;
    if (!room.edits.has(key) && room.edits.size === 8192)
      room.edits.delete(room.edits.keys().next().value!);
    room.edits.set(key, { x, y, i, hp });
    broadcast(room, { t: "edit", x, y, i, hp });
  }
  /** guns=false for automatic touch collection: guns need an explicit pickup. */
  function collect(p: Player, guns = true) {
    const room = p.room!;
    if (room.winner !== -1) return;
    pickLoot(p, guns);
    const cx = Math.floor(p.x / CHUNK),
      cy = Math.floor(p.y / CHUNK);
    for (let y = cy - 1; y <= cy + 1; y++)
      for (let x = cx - 1; x <= cx + 1; x++) {
        scratch = chunkAt(seedHash(room.seed), x, y, room.relief, room.density);
        for (let i = 0; i < scratch.count; i++)
          if (
            scratch.kind[i] === 2 &&
            (room.mode !== "br" || scratch.chest[i]) &&
            (room.edits.get(`${x},${y},${i}`)?.hp ?? scratch.hp[i]) > 0 &&
            Math.hypot(p.x - scratch.ox[i], p.y - scratch.oy[i]) < 105
          ) {
            openCache(room, p, x, y, i);
          } else if (
            scratch.kind[i] === MEDKIT &&
            p.health < 100 &&
            (room.edits.get(`${x},${y},${i}`)?.hp ?? scratch.hp[i]) > 0 &&
            Math.hypot(p.x - scratch.ox[i], p.y - scratch.oy[i]) < 90
          ) {
            edit(room, x, y, i, 0);
            p.health = Math.min(100, p.health + MEDKIT_HEAL);
          }
      }
  }
  /** Caches are point pickups (no healing); in battle royale they are loot chests. */
  function openCache(room: Room, p: Actor, x: number, y: number, i: number) {
    edit(room, x, y, i, 0);
    p.supplies += scratch.drop[i] + 3;
    if (room.mode !== "br") return;
    const ox = scratch.ox[i],
      oy = scratch.oy[i],
      seed = seedHash(room.seed),
      weapon = chestWeapon(hash(seed, x * 64 + i, y * 64 + 991));
    const drop = (dx: number, gun: boolean, ammo: number, heal: number) => {
      if (room.loots.length >= 96) room.loots.shift();
      room.loots.push({
        id: ++room.lootSerial,
        x: ox + dx,
        y: oy + 26,
        weapon: room.weapons & (1 << weapon) ? weapon : firstWeapon(room.weapons),
        ammo,
        gun,
        heal,
      });
    };
    drop(-22, true, chestAmmo(weapon), 0);
    if (hash(seed, x * 64 + i, y * 64 + 997) < CHEST_MEDKIT_CHANCE)
      drop(22, false, 0, MEDKIT_HEAL);
  }

  function fillBots(room: Room): void {
    if (room.botsEnabled) room.hasOpposition = true;
    let humans0 = 0,
      humans1 = 0;
    for (const p of room.players.values()) p.team === 0 ? humans0++ : humans1++;
    for (let i = 0; i < MAX_PARTICIPANTS; i++) {
      const bot = room.bots[i],
        needed = TEAM_SIZE - (bot.team === 0 ? humans0 : humans1);
      const active = room.botsEnabled && i % TEAM_SIZE < needed;
      if (active && !bot.active) {
        spawn(bot);
      }
      bot.active = active;
    }
  }
  function welcome(p: Player, resumed = false): void {
    const room = p.room!;
    send(p, {
      t: "welcome",
      id: p.id,
      resume: p.resume,
      resumed,
      team: p.team,
      mode: room.mode,
      public: room.public,
      maxParticipants: MAX_PARTICIPANTS,
      bots: room.botsEnabled,
      botDifficulty: room.botDifficulty,
      infiniteAmmo: room.infiniteAmmo,
      weapons: room.weapons,
      weapon: p.weapon,
      room: room.name,
      seed: room.seed,
      relief: room.relief,
      density: room.density,
      x: p.x,
      y: p.y,
      edits: [...room.edits.values()],
      round: room.round,
      host: room.hostId === p.id,
    });
  }
  function restartRound(p: Player): void {
    const room = p.room!;
    if (room.public) {
      error(p, "Use Play Again to find a fresh public match.");
      return;
    }
    if (room.hostId !== p.id) {
      error(p, "Only the party host can start the next round.");
      return;
    }
    let livingHumans = 0;
    for (const member of room.players.values())
      if (member.ready && member.health > 0) livingHumans++;
    if (
      room.winner === -1 &&
      room.startedAt &&
      livingHumans > 0 &&
      room.players.size > 1
    ) {
      error(p, "The round is still live. Wait for your teammates to finish.");
      return;
    }
    room.hasOpposition = false;
    room.eliminationSerial = 0;
    room.seed = hexId();
    room.round++;
    room.edits.clear();
    room.loots.length = 0;
    room.lootSerial = 0;
    room.startedAt = 0;
    room.winner = -1;
    room.winnerId = 0;
    resetFlags(room);
    room.elapsed = 0;
    room.radius = STORM_START_RADIUS;
    for (const bot of room.bots) bot.active = false;
    for (const member of room.players.values()) {
      member.ready = false;
      member.weapon = member.startingWeapon;
      member.inventory = room.mode === "br" ? 0 : 1 << member.weapon;
      member.kills = 0;
      member.supplies = 0;
      member.lastShot = 0;
      member.hidden = false;
      spawn(member);
    }
    for (const bot of room.bots) {
      randomLoadout(bot, room);
      bot.inventory = room.weapons;
      bot.kills = 0;
      bot.supplies = 0;
      bot.lastShot = 0;
      bot.hidden = false;
    }
    fillBots(room);
    for (const member of room.players.values()) welcome(member);
  }
  /** Each round, bots wear a random outfit and carry a random allowed firearm. */
  function randomLoadout(bot: Actor, room: Room): void {
    const weapons = room.weapons;
    bot.skin = randInt(SKINS.length);
    bot.name = randomPlayerName();
    if (room.mode === "br") {
      // Battle royale: everyone, bots included, starts with only the axe.
      bot.weapon = bot.startingWeapon = UNARMED;
      return;
    }
    let allowed = 0;
    for (const id of FIREARM_IDS) if (weapons & (1 << id)) allowed++;
    let pick = allowed > 0 ? randInt(allowed) : -1;
    bot.weapon = firstWeapon(weapons);
    for (const id of FIREARM_IDS)
      if (weapons & (1 << id) && pick-- === 0) {
        bot.weapon = id;
        break;
      }
    bot.startingWeapon = bot.weapon;
  }
  /** CTF bot goals: carriers run home, even slots attack the enemy flag, odd slots defend. */
  function flagObjective(
    room: Room,
    bot: Actor,
  ): { x: number; y: number; carrying: boolean } {
    const enemyFlag = room.flags[1 - bot.team],
      ownFlag = room.flags[bot.team];
    if (enemyFlag.carrier === bot.id)
      return { x: baseX(bot.team), y: 0, carrying: true };
    if (bot.id % 2 === 0) {
      const escort = enemyFlag.carrier
        ? actorById(room, enemyFlag.carrier)
        : undefined;
      return escort && escort.team === bot.team
        ? { x: escort.x, y: escort.y, carrying: false }
        : { x: enemyFlag.x, y: enemyFlag.y, carrying: false };
    }
    return { x: ownFlag.x, y: ownFlag.y, carrying: false };
  }
  /** Nearest unopened chest within the surrounding chunks, cached per bot. */
  function chestObjective(room: Room, bot: Bot, now: number) {
    const cached = bot.chest;
    if (
      cached &&
      now - cached.at < 2000 &&
      (room.edits.get(`${cached.cx},${cached.cy},${cached.i}`)?.hp ?? 1) > 0
    )
      return cached;
    bot.chest = undefined;
    const seed = seedHash(room.seed),
      cx = Math.floor(bot.x / CHUNK),
      cy = Math.floor(bot.y / CHUNK);
    let best = Infinity;
    for (let y = cy - 1; y <= cy + 1; y++)
      for (let x = cx - 1; x <= cx + 1; x++) {
        scratch = chunkAt(seed, x, y, room.relief, room.density);
        for (let i = 0; i < scratch.count; i++)
          if (
            scratch.kind[i] === 2 &&
            scratch.chest[i] &&
            (room.edits.get(`${x},${y},${i}`)?.hp ?? scratch.hp[i]) > 0
          ) {
            const d = Math.hypot(scratch.ox[i] - bot.x, scratch.oy[i] - bot.y);
            if (d < best) {
              best = d;
              bot.chest = { cx: x, cy: y, i, x: scratch.ox[i], y: scratch.oy[i], at: now };
            }
          }
      }
    return bot.chest;
  }
  function simulateBots(room: Room, now: number): void {
    let anchor: Player | undefined;
    for (const p of room.players.values())
      if (p.ready && p.health > 0) {
        anchor = p;
        break;
      }
    if (!anchor || !room.startedAt || !room.botsEnabled) return;
    for (const bot of room.bots) {
      if (!bot.active) continue;
      if (bot.health <= 0) {
        continue;
      }
      if (!nearHuman(room, bot)) continue;
      let target: Actor | undefined,
        distance = 620;
      const consider = (actor: Actor) => {
        if (
          actor.ready &&
          actor.health > 0 &&
          enemies(room, bot, actor) &&
          (!actor.hidden || Math.hypot(actor.x - bot.x, actor.y - bot.y) < 140)
        ) {
          const d = Math.hypot(actor.x - bot.x, actor.y - bot.y);
          // Leave a human teammate's fight alone unless it comes close.
          if (
            actor.lastHitBy &&
            now - actor.lastHitAt < 3000 &&
            !soloMode(room.mode) &&
            room.players.get(actor.lastHitBy)?.team === bot.team &&
            d > 220
          )
            return;
          if (d < distance) {
            target = actor;
            distance = d;
          }
        }
      };
      for (const p of room.players.values()) consider(p);
      for (const other of room.bots) if (other.active) consider(other);
      const goal = target as Actor | undefined,
        patrolAngle = bot.id * 2.39996 + (now - room.startedAt) / 28000,
        patrolRadius = Math.min(
          500 + hash(seedHash(room.seed), bot.id, 82) * 1400,
          stormRadius((now - room.startedAt) / 1000, room.mode === "br") * 0.65,
        ),
        unarmed = bot.weapon === UNARMED,
        chest =
          unarmed && room.mode === "br" ? chestObjective(room, bot, now) : undefined,
        objective =
          room.mode === "ctf"
            ? flagObjective(room, bot)
            : chest
              ? { x: chest.x, y: chest.y, carrying: false }
              : undefined,
        // Unarmed bots only brawl when an opponent is right on top of them.
        chase =
          goal &&
          !(objective && objective.carrying) &&
          !(chest && distance > 200),
        tx = chase
          ? goal!.x
          : objective
            ? objective.x
            : Math.cos(patrolAngle) * patrolRadius,
        ty = chase
          ? goal!.y
          : objective
            ? objective.y
            : Math.sin(patrolAngle) * patrolRadius;
      const dx = tx - bot.x,
        dy = ty - bot.y,
        d = Math.hypot(dx, dy);
      bot.angle = Math.atan2(dy, dx);
      if (chest && !chase && d < 70) {
        scratch = chunkAt(seedHash(room.seed), chest.cx, chest.cy, room.relief, room.density);
        openCache(room, bot, chest.cx, chest.cy, chest.i);
        bot.chest = undefined;
      }
      if (d > (chase ? (unarmed ? 40 : 210) : 60)) {
        const stride =
          terrainHeight(seedHash(room.seed), bot.x, bot.y, room.relief) < -0.24
            ? 5.6
            : 9;
        bot.x += (dx / d) * stride * room.botDifficulty;
        bot.y += (dy / d) * stride * room.botDifficulty;
      }
      // Separation prevents a squad from collapsing into one position.
      for (const other of room.bots)
        if (other !== bot && other.active && other.health > 0) {
          const sx = bot.x - other.x,
            sy = bot.y - other.y,
            d = Math.hypot(sx, sy);
          if (d > 0 && d < 75) {
            bot.x += (sx / d) * 4;
            bot.y += (sy / d) * 4;
          }
        }
      // Resolve trunks and rocks near the proposed position; no full-world AI processing.
      const cx = Math.floor(bot.x / CHUNK),
        cy = Math.floor(bot.y / CHUNK);
      scratch = chunkAt(seedHash(room.seed), cx, cy, room.relief, room.density);
      for (let i = 0; i < scratch.count; i++)
        if (
          (scratch.kind[i] < 2 || scratch.kind[i] === STRUCTURE) &&
          (room.edits.get(`${cx},${cy},${i}`)?.hp ?? scratch.hp[i]) > 0
        ) {
          const dx = bot.x - scratch.ox[i],
            dy = bot.y - scratch.oy[i],
            r =
              scratch.kind[i] === STRUCTURE
                ? STRUCTURE_RADIUS + 18
                : scratch.kind[i] === 0
                  ? 25
                  : 32,
            d = Math.hypot(dx, dy);
          if (d > 0 && d < r) {
            bot.x += (dx / d) * (r - d);
            bot.y += (dy / d) * (r - d);
          }
        }
      if (bot.magazine === 0) reload(bot);
      if (
        goal &&
        distance < Math.min(WEAPONS[bot.weapon].range, 700) &&
        now - bot.lastShot >
          Math.max(
            1100 / room.botDifficulty,
            WEAPONS[bot.weapon].cooldown * 1000,
          )
      )
        attack(
          bot,
          bot.angle +
            Math.sin(bot.id + now / 600) * (0.12 / room.botDifficulty),
          bot.weapon,
        );
    }
  }
  const ignore: ConnHandlers = {
    message: () => {},
    closed: () => {},
    pong: () => {},
  };
  function connect(ws: Conn): ConnHandlers {
    if (clients.size >= 512) {
      ws.close(1013, "Server full");
      return ignore;
    }
    const p: Player = {
      id: serial++,
      ws,
      x: 0,
      y: 0,
      angle: 0,
      health: 100,
      supplies: 0,
      name: "Pathfinder",
      room: null,
      lastMove: Date.now(),
      lastShot: 0,
      deadUntil: 0,
      budget: 0,
      budgetAt: Date.now(),
      alive: true,
      ready: false,
      team: 0,
      bot: false,
      skin: 0,
      weapon: 0,
      startingWeapon: 0,
      magazine: 24,
      reserve: 72,
      reloading: 0,
      inventory: 1,
      kills: 0,
      hidden: false,
      lastHitBy: 0,
      lastHitAt: 0,
      lastHitWeapon: 0,
      stamina: 100,
      resume: hexId() + hexId(),
    };
    clients.add(p);
    const joinTimeout = setTimeout(() => {
      if (!p.room) ws.close(1008, "Join timed out");
    }, 5000);
    const pong = () => {
      p.alive = true;
    };
    const message = (data: Uint8Array | string, binary: boolean): void => {
      try {
        const now = Date.now();
        if (now - p.budgetAt >= 1000) {
          p.budget = 0;
          p.budgetAt = now;
        }
        if (++p.budget > 70) {
          ws.close(1008, "Rate limit");
          return;
        }
        if (binary) {
          if (!p.room) return;
          if (typeof data === "string" || data.byteLength !== 32) return;
          const packet = new DataView(data.buffer, data.byteOffset, 32);
          const t = packet.getFloat64(0, true),
            a = packet.getFloat64(8, true),
            b = packet.getFloat64(16, true),
            c = packet.getFloat64(24, true);
          if (!finite(a) || !finite(b) || !finite(c)) return;
          if (t === 1 && p.ready && p.health > 0 && p.room.winner === -1) {
            const elapsed = Math.min(1, (now - p.lastMove) / 1000),
              distance = Math.hypot(a - p.x, b - p.y),
              // Sprinting (up to 1.45 × 235) is allowed only while stamina lasts.
              limit = elapsed * (p.stamina > 0 ? 360 : 260) + 3;
            if (distance <= limit && Math.abs(a) < 1e8 && Math.abs(b) < 1e8) {
              if (distance > elapsed * 250)
                p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * elapsed);
              else
                p.stamina = Math.min(100, p.stamina + STAMINA_REGEN * elapsed);
              p.x = a;
              p.y = b;
              p.angle = c;
              p.lastMove = now;
            }
          }
          if (t === 8) {
            restartRound(p);
            return;
          }
          if (t === 5 && !p.ready && p.room.winner === -1) {
            p.ready = true;
            spawn(p);
            if (!p.room.startedAt) p.room.startedAt = now;
            for (const other of p.room.players.values())
              if (other.ready && enemies(p.room, other, p))
                p.room.hasOpposition = true;
          }
          if (
            t === 6 &&
            validWeapon(a) &&
            p.inventory & (1 << a) &&
            p.room.weapons & (1 << a)
          ) {
            p.weapon = a;
            p.magazine = 0;
            p.reloading = 0;
            reload(p);
          }
          if (t === 7) reload(p);
          if (t === 2 && (b === 1 || validWeapon(b))) attack(p, a, b);
          if (t === 3 && p.health === 0)
            error(
              p,
              "You were eliminated. Leave this party to start a new match.",
            );
          if (t === 4 && p.ready && p.health > 0) collect(p, a !== 1);
          return;
        }
        if (p.room) return;
        const msg = JSON.parse(
          typeof data === "string" ? data : decoder.decode(data),
        );
        if (
          msg.t !== "join" ||
          typeof msg.room !== "string" ||
          !/^[-\w]{1,24}$/.test(msg.room)
        ) {
          error(
            p,
            "Use a room name with 1–24 letters, numbers, dashes or underscores.",
          );
          return;
        }
        if (typeof msg.resume === "string") {
          const entry = pending.get(msg.resume);
          if (!entry || entry.room.name !== msg.room || rooms.get(msg.room) !== entry.room) {
            error(p, "This match could not be resumed.");
            return;
          }
          pending.delete(msg.resume);
          Object.assign(p, entry.data);
          p.ws = ws;
          p.room = entry.room;
          p.alive = true;
          p.budget = 0;
          p.budgetAt = now;
          p.lastMove = now;
          entry.room.players.set(p.id, p);
          if (!entry.room.players.has(entry.room.hostId)) entry.room.hostId = p.id;
          clearTimeout(joinTimeout);
          welcome(p, true);
          return;
        }
        if (msg.matchmaking === true) {
          let found: Room | undefined;
          const tier = Number.isInteger(msg.tier)
            ? Math.max(0, Math.min(3, msg.tier))
            : 0;
          for (const candidate of rooms.values())
            if (
              candidate.public &&
              Math.abs(candidate.tier - tier) <= 1 &&
              candidate.name !== msg.excludeRoom &&
              candidate.winner === -1 &&
              (!candidate.startedAt ||
                Date.now() - candidate.startedAt < 30000) &&
              candidate.players.size < MAX_PARTICIPANTS &&
              (!found ||
                Math.abs(candidate.tier - tier) < Math.abs(found.tier - tier) ||
                (Math.abs(candidate.tier - tier) === Math.abs(found.tier - tier) &&
                  candidate.players.size > found.players.size))
            )
              found = candidate;
          msg.room = found
            ? found.name
            : "PUBLIC_" + p.id.toString(36).toUpperCase();
          msg.create = !found;
          msg.public = true;
        }
        let room = rooms.get(msg.room);
        if (!room && msg.create === false) {
          error(p, "Party not found. Check the code or create a new party.");
          return;
        }
        if (room && msg.create === true) {
          error(p, "Party code already exists. Create another party.");
          return;
        }
        if (!room) {
          if (rooms.size >= 64) {
            error(p, "Server room limit reached.");
            ws.close();
            return;
          }
          const mode: GameMode =
            msg.public === true ? "teams" : validMode(msg.mode);
          const tier = Number.isInteger(msg.tier)
            ? Math.max(0, Math.min(3, msg.tier))
            : 0;
          room = {
            name: msg.room,
            tier,
            mode,
            winnerId: 0,
            flags: [
              { x: baseX(0), y: 0, carrier: 0, home: true },
              { x: baseX(1), y: 0, carrier: 0, home: true },
            ],
            captures: [0, 0],
            seed:
              msg.public === true
                ? hexId()
                : typeof msg.seed === "string" && msg.seed.trim()
                  ? msg.seed.slice(0, 64)
                  : hexId(),
            relief:
              msg.public === true
                ? 1
                : [0, 1, 1.9].includes(msg.relief)
                  ? msg.relief
                  : 1,
            density:
              msg.public === true
                ? 0.04
                : [0, 0.04, 0.12].includes(msg.density)
                  ? msg.density
                  : 0.04,
            players: new Map(),
            edits: new Map(),
            public: msg.public === true,
            infiniteAmmo: msg.public !== true && msg.infiniteAmmo === true,
            weapons:
              msg.public === true
                ? FIREARM_MASK
                : (Number.isInteger(msg.weapons) ? msg.weapons : FIREARM_MASK) &
                    FIREARM_MASK || 1,
            botsEnabled: msg.public === true || msg.bots !== false,
            // Public bots scale with the bracket; private rooms use the host's choice.
            botDifficulty:
              msg.public === true
                ? TIER_DIFFICULTY[tier]
                : [0.65, 1, 1.35].includes(msg.botDifficulty)
                  ? msg.botDifficulty
                  : 1,
            hasOpposition: false,
            eliminationSerial: 0,
            hostId: p.id,
            round: 1,
            startedAt: 0,
            winner: -1,
            elapsed: 0,
            radius: STORM_START_RADIUS,
            loots: [],
            lootSerial: 0,
            bots: [],
          };
          for (let i = 0; i < MAX_PARTICIPANTS; i++)
            room.bots.push({
              id: -i - 1,
              x: 0,
              y: 0,
              angle: 0,
              health: 100,
              supplies: 0,
              name: randomPlayerName(),
              room,
              lastMove: 0,
              lastShot: 0,
              deadUntil: 0,
              ready: true,
              team: i < TEAM_SIZE ? 0 : 1,
              bot: true,
              skin: 0,
              weapon: 0,
              startingWeapon: 0,
              magazine: 24,
              reserve: 120,
              reloading: 0,
              inventory: room.weapons,
              kills: 0,
              hidden: false,
              lastHitBy: 0,
              lastHitAt: 0,
              lastHitWeapon: 0,
              stamina: 100,
              active: false,
            });
          for (const bot of room.bots) randomLoadout(bot, room);
          rooms.set(room.name, room);
        }
        if (room.players.size >= MAX_PARTICIPANTS) {
          error(p, "This match is full (30 participants).");
          ws.close();
          return;
        }
        if (room.winner !== -1) {
          error(
            p,
            "This match has finished. Find a new public match or create a party.",
          );
          return;
        }
        p.skin =
          Number.isInteger(msg.skin) && msg.skin >= 0 && msg.skin < SKINS.length
            ? msg.skin
            : 0;
        p.room = room;
        // Battle royale ignores Locker weapons: only the outfit carries over.
        p.weapon =
          room.mode === "br"
            ? UNARMED
            : validWeapon(msg.loadout) && room.weapons & (1 << msg.loadout)
              ? msg.loadout
              : firstWeapon(room.weapons);
        p.startingWeapon = p.weapon;
        p.inventory = room.mode === "br" ? 0 : 1 << p.weapon;
        p.name =
          typeof msg.name === "string" ? msg.name.slice(0, 16) : "Pathfinder";
        let count0 = 0,
          count1 = 0;
        for (const human of room.players.values())
          human.team === 0 ? count0++ : count1++;
        p.team =
          msg.matchmaking === true || !room.botsEnabled
            ? count0 <= count1
              ? 0
              : 1
            : count0 < TEAM_SIZE
              ? 0
              : 1;
        room.players.set(p.id, p);
        fillBots(room);
        spawn(p);
        clearTimeout(joinTimeout);
        welcome(p);
      } catch {
        error(p, "Invalid network message.");
      }
    };
    const closed = () => {
      clearTimeout(joinTimeout);
      clients.delete(p);
      if (p.room) {
        p.room.players.delete(p.id);
        if (!p.room.players.size) rooms.delete(p.room.name);
        else {
          if (p.room.hostId === p.id)
            p.room.hostId = p.room.players.keys().next().value!;
          if (p.room.winner === -1) fillBots(p.room);
        }
      }
    };
    return { message, closed, pong };
  }
  const botSimulation = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      matchTick(room, now);
      if (room.winner === -1) simulateBots(room, now);
    }
  }, 100);
  const snapshots = setInterval(() => {
    for (const room of rooms.values()) {
      // Compact snapshot: rounded numbers; private ammo fields only for humans;
      // static fields once a second or when the roster changes.
      const roster = room.players.size * 100 + room.bots.filter((b) => b.active).length,
        count = room.snapshotCount ?? 0,
        full = count % 20 === 0 || roster !== room.lastRoster;
      room.snapshotCount = count + 1;
      room.lastRoster = roster;
      const encode = (p: Actor) => {
        const out: Record<string, unknown> = {
          id: p.id,
          x: Math.round(p.x),
          y: Math.round(p.y),
          angle: Math.round(p.angle * 100) / 100,
          health: Math.round(p.health * 10) / 10,
          ready: p.ready,
          weapon: p.weapon,
          kills: p.kills,
          hidden: p.hidden,
        };
        if (!p.bot) {
          out.supplies = p.supplies;
          out.magazine = p.magazine;
          out.reserve = p.reserve;
          out.reloading =
            Math.round(Math.max(0, (p.reloading - Date.now()) / 1000) * 100) / 100;
        }
        if (full) {
          out.name = p.name;
          out.team = p.team;
          out.bot = p.bot;
          out.skin = p.skin;
        }
        return out;
      };
      const lootText = JSON.stringify(room.loots),
        sendLoots = full || lootText !== room.lastLoots;
      room.lastLoots = lootText;
      broadcast(room, {
        t: "state",
        mode: room.mode,
        winnerId: room.winnerId,
        captures: room.captures,
        flags: room.mode === "ctf" ? room.flags : undefined,
        public: room.public,
        hostId: room.hostId,
        round: room.round,
        elapsed: room.elapsed,
        radius: room.radius,
        winner: room.winner,
        loots: sendLoots ? room.loots : undefined,
        playersLeft:
          [...room.players.values()].filter((p) => p.ready && p.health > 0)
            .length + room.bots.filter((b) => b.active && b.health > 0).length,
        players: [...room.players.values()]
          .map(encode)
          .concat(room.bots.filter((b) => b.active).map(encode)),
      });
    }
  }, 50);
  const heartbeat = setInterval(() => {
    for (const p of clients) {
      if (!p.alive) {
        p.ws.terminate();
        continue;
      }
      if (!p.ws.ping) continue;
      p.alive = false;
      p.ws.ping();
    }
  }, 15000);
  /** Portable room state for host migration (map edits travel separately). */
  function serializeRoom(room: Room, now = Date.now()) {
    // Snapshot bookkeeping is per host and stays out of backups.
    const { players, bots, edits, snapshotCount, lastRoster, lastLoots, ...rest } = room;
    void edits;
    void snapshotCount;
    void lastRoster;
    void lastLoots;
    return {
      v: 1,
      token: backupToken,
      room: { ...rest, startedAt: room.startedAt ? room.startedAt - now : 0 },
      players: [...players.values()].map((p) => actorState(p, now)),
      bots: bots.map((b) => actorState(b, now)),
    };
  }
  /** Rebuild a room from a backup; humans become pending until they resume. */
  function restore(
    state: ReturnType<typeof serializeRoom>,
    edits: { x: number; y: number; i: number; hp: number }[] = [],
  ): Room {
    const now = Date.now(),
      saved = state.room as unknown as Room;
    const room: Room = {
      ...saved,
      startedAt: saved.startedAt ? saved.startedAt + now : 0,
      flags: [{ ...saved.flags[0] }, { ...saved.flags[1] }],
      captures: [saved.captures[0], saved.captures[1]],
      loots: saved.loots.map((l) => ({ ...l })),
      players: new Map(),
      edits: new Map(),
      bots: [],
    };
    for (const e of edits) room.edits.set(`${e.x},${e.y},${e.i}`, { ...e });
    for (const b of state.bots)
      room.bots.push(absolute({ ...(b as unknown as Bot), room }, now));
    for (const p of state.players) {
      const data = absolute({ ...p }, now);
      if (typeof data.resume === "string")
        pending.set(data.resume, { data, room, until: now + 30000 });
      if (typeof data.id === "number") serial = Math.max(serial, data.id + 1);
    }
    rooms.set(room.name, room);
    if (typeof state.token === "string") backupToken = state.token;
    return room;
  }
  const backups = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of pending)
      if (entry.until < now) {
        // A player who never came back after migration: their slot returns to a bot.
        pending.delete(token);
        if (entry.room.winner === -1) fillBots(entry.room);
      }
    if (!options.backups) return;
    for (const room of rooms.values())
      for (const p of room.players.values())
        if (!p.ws.local) {
          send(p, { t: "backup", state: serializeRoom(room, now) });
          break;
        }
  }, 1000);
  return {
    rooms,
    clients,
    connect,
    serializeRoom,
    restore,
    /** Shared secret that lets a successor reclaim the signaling listing. */
    setBackupToken(token: string) {
      backupToken = token;
    },
    close(): void {
      clearInterval(backups);
      clearInterval(snapshots);
      clearInterval(botSimulation);
      clearInterval(heartbeat);
      for (const p of clients) p.ws.terminate();
    },
  };
}
export type Authority = ReturnType<typeof createAuthority>;
