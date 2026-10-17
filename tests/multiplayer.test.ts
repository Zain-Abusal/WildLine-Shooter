import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import {
  FIREARM_MASK,
  STORM_END,
  FIREARM_IDS,
  WEAPONS,
} from "../src/combat";
import { createGameServer } from "../server/index";
import { Chunk, seedHash } from "../src/world";
import { TIER_DIFFICULTY } from "../src/profile";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function join(
  url: string,
  room: string,
  seed = "shared",
  enter = true,
  options: Record<string, unknown> = {},
) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  const welcome = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Welcome timeout")), 3000);
    ws.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.t === "error") {
        clearTimeout(timer);
        reject(new Error(data.message));
      }
      if (data.t === "welcome") {
        clearTimeout(timer);
        resolve(data);
      }
    });
  });
  ws.send(
    JSON.stringify({
      t: "join",
      room,
      name: "Test",
      seed,
      relief: 1.9,
      density: 0.04,
      ...options,
    }),
  );
  const result = await welcome;
  if (enter) send(ws, 5);
  await delay(20);
  return { ws, welcome: result };
}
function send(ws: WebSocket, t: number, a = 0, b = 0, c = 0) {
  ws.send(new Float64Array([t, a, b, c]));
}
test("multiplayer shares seed, isolates rooms, validates movement, applies combat and syncs edits to late joiners", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const address = server.http.address() as { port: number };
  const url = "ws://127.0.0.1:" + address.port;
  try {
    const a = await join(url, "squad"),
      b = await join(url, "squad", "ignored-seed"),
      c = await join(url, "other");
    assert.equal(b.welcome.seed, "shared");
    assert.equal(b.welcome.relief, 1.9);
    assert.notEqual(a.welcome.id, b.welcome.id);
    const lobby = await join(url, "squad", "ignored", false);
    const room = server.rooms.get("squad")!,
      pa = room.players.get(a.welcome.id)!,
      pb = room.players.get(b.welcome.id)!;
    const waiting = room.players.get(lobby.welcome.id)!;
    assert.equal(waiting.ready, false);
    waiting.x = 0;
    waiting.y = 0;
    pb.team = 1;
    pa.x = -30;
    pa.y = 0;
    pb.x = 30;
    pb.y = 0;
    send(a.ws, 1, 999999, 999999, 0);
    await delay(70);
    assert.equal(pa.x, -30);
    send(a.ws, 2, 0, 0);
    await delay(70);
    assert.equal(pb.health, 100 - WEAPONS[0].damage);
    assert.equal(
      waiting.health,
      100,
      "lobby party members are not combat targets",
    );
    assert.equal(
      server.rooms.get("other")!.players.get(c.welcome.id)!.health,
      100,
    );
    send(a.ws, 2, 0, 0);
    await delay(30);
    assert.equal(
      pb.health,
      100 - WEAPONS[0].damage,
      "fire cooldown rejects spam",
    );
    const chunk = new Chunk();
    chunk.generate(seedHash("shared"), 4, 4, 1.9, 0.04);
    const index = chunk.kind.findIndex((k) => k === 0);
    assert.ok(index >= 0);
    pa.x = chunk.ox[index] - 45;
    pa.y = chunk.oy[index];
    pa.lastShot = 0;
    send(a.ws, 2, 0, 1);
    await delay(70);
    assert.ok(room.edits.size > 0);
    const late = await join(url, "squad");
    assert.ok(late.welcome.edits.length > 0);
    pb.health = 0;
    pb.deadUntil = Date.now() + 1000;
    send(b.ws, 3);
    await delay(50);
    assert.equal(pb.health, 0);
    pb.deadUntil = 0;
    send(b.ws, 3);
    await delay(70);
    assert.equal(
      pb.health,
      0,
      "eliminated players cannot respawn into a live match",
    );
  } finally {
    await server.close();
  }
});

test("public matchmaking excludes private rooms, replaces bots, balances teams and caps matches at 30", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    await join(url, "PRIVATE", "private", false, {
      create: true,
      public: false,
    });
    const host = await join(url, "OPEN", "public", false, {
      create: true,
      public: true,
    });
    const found = await join(url, "PUBLIC", "ignored", false, {
      matchmaking: true,
    });
    assert.equal(found.welcome.room, "OPEN");
    assert.equal(found.welcome.public, true);
    assert.notEqual(host.welcome.team, found.welcome.team);
    const room = server.rooms.get("OPEN")!;
    assert.equal(
      room.players.size + room.bots.filter((b) => b.active).length,
      30,
    );
    for (let i = 0; i < 28; i++)
      await join(url, "OPEN", "ignored", false, { create: false });
    assert.equal(room.players.size, 30);
    assert.equal(room.bots.filter((b) => b.active).length, 0);
    assert.equal(
      [...room.players.values()].filter((p) => p.team === 0).length,
      15,
    );
    await assert.rejects(
      join(url, "OPEN", "ignored", false, { create: false }),
      /full/,
    );
    const next = await join(url, "PUBLIC", "ignored", false, {
      matchmaking: true,
    });
    assert.notEqual(next.welcome.room, "OPEN");
    assert.notEqual(next.welcome.room, "PRIVATE");
    assert.equal(
      server.rooms.get(next.welcome.room)!.bots.filter((b) => b.active).length,
      29,
    );
  } finally {
    await server.close();
  }
});
test("server bots fight opponents and support teammates without friendly fire", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const client = await join(url, "BOTS");
    const room = server.rooms.get("BOTS")!,
      human = room.players.get(client.welcome.id)!;
    for (const bot of room.bots) {
      bot.x = 5000;
      bot.y = 5000;
      bot.lastShot = Date.now() + 100000;
    }
    const ally = room.bots.find((b) => b.active && b.team === human.team)!,
      enemy = room.bots.find((b) => b.active && b.team !== human.team)!;
    human.x = 0;
    human.y = 0;
    ally.x = 60;
    ally.y = 0;
    human.lastShot = 0;
    send(client.ws, 2, 0, 0);
    await delay(70);
    assert.equal(ally.health, 100, "friendly fire is disabled");
    human.x = -60;
    ally.x = -90;
    enemy.x = 60;
    enemy.y = 0;
    ally.lastShot = enemy.lastShot = 0;
    await delay(250);
    assert.ok(enemy.health < 100, "teammate bot attacks opponent");
    assert.ok(human.health < 100, "enemy bot attacks human");
  } finally {
    await server.close();
  }
});

test("private weapon rules, finite ammo, reloads, drops and elimination authority are enforced", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "GEAR", "gear", true, {
      create: true,
      weapons: 4,
      infiniteAmmo: false,
      loadout: 0,
    });
    const b = await join(url, "GEAR", "gear", true, { create: false });
    const r = server.rooms.get("GEAR")!,
      pa = r.players.get(a.welcome.id)!,
      pb = r.players.get(b.welcome.id)!;
    assert.equal(
      pa.weapon,
      2,
      "disallowed starting gun is replaced with allowed gun",
    );
    pa.x = 0;
    pa.y = 0;
    pb.x = 60;
    pb.y = 0;
    pb.team = 1;
    pa.lastShot = 0;
    send(a.ws, 2, 0, 0);
    await delay(25);
    assert.equal(pa.magazine, 6);
    assert.equal(pb.health, 100, "disallowed gun cannot deal damage");
    pa.lastShot = 0;
    send(a.ws, 2, 0, 2);
    await delay(25);
    assert.equal(pa.magazine, 5);
    assert.equal(pb.health, 100 - WEAPONS[2].damage);
    pa.lastShot = 0;
    send(a.ws, 2, 0, 2);
    await delay(25);
    assert.equal(pb.health, 0);
    assert.equal(pa.kills, 1);
    assert.ok(r.loots.some((l) => l.weapon === 2 && l.gun));
    pa.magazine = 0;
    pa.reserve = 12;
    send(a.ws, 7);
    await delay(25);
    assert.ok(pa.reloading > 0);
    pa.reloading = Date.now() - 1;
    await delay(125);
    assert.equal(pa.magazine, 6);
    assert.ok(pa.reserve >= 6);
    const infinite = await join(url, "INFINITE", "gear", true, {
      create: true,
      infiniteAmmo: true,
    });
    const ir = server.rooms.get("INFINITE")!,
      ip = ir.players.get(infinite.welcome.id)!;
    ip.lastShot = 0;
    send(infinite.ws, 2, 0, 0);
    await delay(25);
    assert.equal(ip.magazine, 24);
    const publicRoom = await join(url, "FAIR", "gear", false, {
      create: true,
      public: true,
      infiniteAmmo: true,
      weapons: 4,
    });
    assert.equal(server.rooms.get("FAIR")!.infiniteAmmo, false);
    assert.equal(server.rooms.get("FAIR")!.weapons, FIREARM_MASK);
  } finally {
    await server.close();
  }
});
test("storm damage ends matches and ready participants are spread across the map", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "STORM");
    const r = server.rooms.get("STORM")!,
      p = r.players.get(a.welcome.id)!;
    const actors = [p, ...r.bots.filter((b) => b.active)];
    for (let i = 0; i < actors.length; i++)
      for (let j = i + 1; j < actors.length; j++)
        assert.ok(
          Math.hypot(actors[i].x - actors[j].x, actors[i].y - actors[j].y) >=
            175,
        );
    for (const b of r.bots)
      if (b.active && b.team !== p.team) {
        b.health = 0;
        b.deadUntil = Number.MAX_SAFE_INTEGER;
      }
    await delay(125);
    assert.equal(r.winner, p.team, "last surviving team wins");
    const c = await join(url, "DANGER");
    const danger = server.rooms.get("DANGER")!,
      victim = danger.players.get(c.welcome.id)!;
    danger.startedAt = Date.now() - (STORM_END - 15) * 1000;
    victim.x = 500;
    victim.y = 500;
    const health = victim.health;
    await delay(125);
    assert.ok(victim.health < health);
    assert.ok(danger.radius < 150);
  } finally {
    await server.close();
  }
});

test("private solo rooms enforce every weapon mask, support all guns and axe harvesting", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    for (const gun of [0, 2, 3, 4, 5, 6, 7]) {
      const a = await join(url, "MASK" + gun, "solo", true, {
        create: true,
        weapons: 1 << gun,
        loadout: gun,
      });
      const r = server.rooms.get("MASK" + gun)!,
        p = r.players.get(a.welcome.id)!;
      assert.equal(p.weapon, gun);
      assert.equal(r.bots.filter((b) => b.active).length, 29);
      assert.ok(
        r.bots.every((b) => b.weapon === gun),
        "private bots obey the actual selected weapon",
      );
      assert.equal(a.welcome.host, true);
      p.x = 0;
      p.y = 0;
      p.lastShot = 0;
      const before = p.magazine;
      send(a.ws, 2, 0, gun);
      await delay(20);
      assert.equal(p.magazine, before - 1);
      const chunk = new Chunk();
      chunk.generate(seedHash(r.seed), 0, 0, r.relief, r.density);
      const object = Array.from(chunk.kind).findIndex(
        (k, i) => k < 2 && chunk.hp[i] > 0,
      );
      assert.ok(object >= 0);
      p.x = chunk.ox[object] - 65;
      p.y = chunk.oy[object] - 35;
      p.lastShot = 0;
      // Isolate the target so another nearby prop cannot correctly intercept the swing.
      r.edits.clear();
      for (let cy = -1; cy <= 1; cy++)
        for (let cx = -1; cx <= 1; cx++) {
          const other = new Chunk();
          other.generate(seedHash(r.seed), cx, cy, r.relief, r.density);
          for (let j = 0; j < other.count; j++)
            if (!(cx === 0 && cy === 0 && j === object) && other.kind[j] < 2)
              r.edits.set(`${cx},${cy},${j}`, { x: cx, y: cy, i: j, hp: 0 });
        }
      send(a.ws, 2, 0, 1);
      await delay(20);
      const edit = r.edits.get(`0,0,${object}`);
      assert.ok(
        edit && edit.hp < 60,
        "axe hits off-center props with a forward arc: " +
          JSON.stringify({
            object,
            x: p.x,
            y: p.y,
            edits: [...r.edits.values()],
          }),
      );
      a.ws.close();
    }
  } finally {
    await server.close();
  }
});

test("private rematches change the map, clear round state, keep members and transfer host", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "REMATCH", "old", true, { create: true });
    const b = await join(url, "REMATCH", "ignored", true, { create: false });
    const r = server.rooms.get("REMATCH")!,
      pa = r.players.get(a.welcome.id)!,
      pb = r.players.get(b.welcome.id)!;
    const seed = r.seed;
    send(b.ws, 8);
    await delay(20);
    assert.equal(r.round, 1, "guest cannot restart");
    send(a.ws, 8);
    await delay(20);
    assert.equal(r.round, 1, "host cannot erase a live teammate round");
    r.winner = 0;
    r.edits.set("0,0,1", { x: 0, y: 0, i: 1, hp: 0 });
    pa.kills = 5;
    pa.health = 0;
    r.loots.push({ id: 1, x: 0, y: 0, weapon: 0, ammo: 12, gun: true, heal: 0 });
    send(a.ws, 8);
    await delay(30);
    assert.notEqual(r.seed, seed);
    assert.equal(r.round, 2);
    assert.equal(r.players.size, 2);
    assert.equal(r.edits.size, 0);
    assert.equal(r.loots.length, 0);
    assert.equal(r.winner, -1);
    assert.equal(pa.health, 100);
    assert.equal(pa.kills, 0);
    assert.equal(pa.ready, false);
    assert.equal(pb.ready, false);
    assert.equal(r.bots.filter((bot) => bot.active).length, 28);
    a.ws.close();
    await delay(30);
    assert.equal(r.hostId, pb.id);
    send(b.ws, 8);
    await delay(20);
    assert.equal(r.round, 3, "new host retains round controls");
  } finally {
    await server.close();
  }
});

test("public replay excludes the previous room instead of reviving into that round", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const first = await join(url, "PUBLIC", "unused", false, {
      matchmaking: true,
    });
    const stay = await join(url, first.welcome.room, "ignored", false, {
      create: false,
    });
    const next = await join(url, "PUBLIC", "unused", false, {
      matchmaking: true,
      excludeRoom: first.welcome.room,
    });
    assert.notEqual(next.welcome.room, first.welcome.room);
    assert.notEqual(next.welcome.seed, first.welcome.seed);
    assert.equal(server.rooms.get(first.welcome.room)!.players.size, 2);
    assert.ok(stay.welcome.id);
  } finally {
    await server.close();
  }
});

test("private bot toggles and difficulty never leak into public games or cause an instant solo win", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "NO_BOTS", "solo", true, {
      create: true,
      bots: false,
      botDifficulty: 1.35,
    });
    const r = server.rooms.get("NO_BOTS")!;
    await delay(120);
    assert.equal(r.bots.filter((b) => b.active).length, 0);
    assert.equal(r.winner, -1);
    assert.equal(r.botDifficulty, 1.35);
    const b = await join(url, "NO_BOTS", "ignored", true, { create: false });
    assert.notEqual(
      a.welcome.team,
      b.welcome.team,
      "no-bot parties balance human opponents",
    );
    const pa = r.players.get(a.welcome.id)!,
      pb = r.players.get(b.welcome.id)!;
    pb.health = 0;
    pb.deadUntil = Number.MAX_SAFE_INTEGER;
    await delay(120);
    assert.equal(r.winner, pa.team);
    const pub = await join(url, "PUB_CONFIG", "public", false, {
      create: true,
      public: true,
      bots: false,
      botDifficulty: 1.35,
    });
    const pr = server.rooms.get("PUB_CONFIG")!;
    assert.equal(pr.botsEnabled, true);
    // Public difficulty follows the matchmaking bracket (rookie by default), never the private request.
    assert.equal(pr.botDifficulty, TIER_DIFFICULTY[0]);
    assert.notEqual(pr.botDifficulty, 1.35);
    assert.equal(pr.bots.filter((b) => b.active).length, 29);
    assert.ok(pub.welcome.public);
  } finally {
    await server.close();
  }
});

test("bots get random allowed loadouts and recent human hits own bot or storm finishes", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "ASSIST");
    const r = server.rooms.get("ASSIST")!,
      p = r.players.get(a.welcome.id)!;
    const weapons = new Set<number>(),
      skins = new Set<number>();
    for (const b of r.bots) {
      assert.ok((FIREARM_IDS as readonly number[]).includes(b.weapon));
      assert.ok(r.weapons & (1 << b.weapon));
      assert.equal(b.startingWeapon, b.weapon);
      weapons.add(b.weapon);
      skins.add(b.skin);
    }
    assert.ok(weapons.size > 1, "bot weapons vary");
    assert.ok(skins.size > 1, "bot outfits vary");
    if (!r.startedAt) r.startedAt = Date.now() - 1000;
    const enemy = r.bots.find((b) => b.active && b.team !== p.team)!;
    // Outside the zone but near a human, so the storm (not the off-screen pull-in) applies.
    p.x = 6100;
    p.y = 0;
    enemy.x = 6000;
    enemy.y = 0;
    enemy.health = 0.1;
    enemy.lastHitBy = p.id;
    enemy.lastHitAt = Date.now();
    enemy.lastHitWeapon = p.weapon;
    await delay(150);
    assert.equal(enemy.health, 0);
    assert.equal(p.kills, 1, "player keeps credit for a storm finish");
    const stale = r.bots.find(
      (b) => b.active && b.team !== p.team && b.health > 0,
    )!;
    r.loots.length = 0; // a 15% medkit drop from the first kill must not heal the next target
    stale.x = 6050;
    stale.y = 40;
    stale.health = 0.1;
    stale.lastHitBy = p.id;
    stale.lastHitAt = Date.now() - 60000;
    await delay(150);
    assert.equal(stale.health, 0);
    assert.equal(p.kills, 1, "old hits do not steal credit");
  } finally {
    await server.close();
  }
});

test("private rooms keep random bot loadouts inside the weapon mask", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    await join(url, "MASKRAND", "solo", true, {
      create: true,
      weapons: (1 << 2) | (1 << 4),
    });
    const r = server.rooms.get("MASKRAND")!;
    for (const b of r.bots) assert.ok(b.weapon === 2 || b.weapon === 4);
  } finally {
    await server.close();
  }
});

test("battle royale makes everyone hostile and ends with one individual winner", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "BR1", "solo", true, { create: true, mode: "br" });
    assert.equal(a.welcome.mode, "br");
    const r = server.rooms.get("BR1")!,
      p = r.players.get(a.welcome.id)!;
    // A same-team bot is still an opponent in battle royale.
    const mate = r.bots.find((b) => b.active && b.team === p.team)!;
    p.x = 0;
    p.y = 0;
    mate.x = 60;
    mate.y = 0;
    p.lastShot = 0;
    const before = mate.health;
    send(a.ws, 2, 0, p.weapon);
    await delay(60);
    assert.ok(mate.health < before, "solo modes have no friendly side");
    await delay(120);
    assert.ok(r.hasOpposition);
    for (const b of r.bots) {
      b.health = 0;
      b.deadUntil = Number.MAX_SAFE_INTEGER;
    }
    await delay(150);
    assert.equal(r.winner, 3);
    assert.equal(r.winnerId, p.id);
  } finally {
    await server.close();
  }
});

test("free-for-all respawns eliminated players and ends at the kill target", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "FFA1", "solo", true, { create: true, mode: "ffa" });
    const r = server.rooms.get("FFA1")!,
      p = r.players.get(a.welcome.id)!;
    p.health = 0;
    p.deadUntil = Date.now() - 1;
    await delay(150);
    assert.equal(p.health, 100, "respawned after the delay");
    assert.equal(p.deadUntil, 0);
    assert.equal(r.winner, -1);
    p.kills = 15;
    await delay(150);
    assert.equal(r.winner, 3);
    assert.equal(r.winnerId, p.id);
  } finally {
    await server.close();
  }
});

test("capture the flag picks up, captures and wins at three", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "CTF1", "solo", true, { create: true, mode: "ctf" });
    const r = server.rooms.get("CTF1")!,
      p = r.players.get(a.welcome.id)!;
    const captured = new Promise<any>((resolve) =>
      a.ws.on("message", (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.t === "capture") resolve(data);
      }),
    );
    // Keep bots away from both flags so the test controls the objective.
    for (const b of r.bots) {
      b.health = 0;
      b.deadUntil = Number.MAX_SAFE_INTEGER;
    }
    const enemyFlag = r.flags[1 - p.team];
    p.x = enemyFlag.x;
    p.y = enemyFlag.y;
    await delay(150);
    assert.equal(enemyFlag.carrier, p.id);
    p.x = p.team === 0 ? -1500 : 1500;
    p.y = 0;
    await delay(150);
    assert.equal(r.captures[p.team], 1);
    assert.equal(enemyFlag.carrier, 0);
    assert.ok(enemyFlag.home);
    assert.equal((await captured).team, p.team);
    r.captures[p.team] = 3;
    await delay(150);
    assert.equal(r.winner, p.team);
  } finally {
    await server.close();
  }
});

test("public rooms ignore requested modes", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "PUBMODE", "x", true, {
      create: true,
      public: true,
      mode: "ffa",
    });
    assert.equal(a.welcome.mode, "teams");
  } finally {
    await server.close();
  }
});

test("battle royale starts everyone unarmed, spreads spawns, and chests drop guns and medkits", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "BRLOOT", "loot-seed", true, {
      create: true,
      mode: "br",
      loadout: 7,
    });
    assert.equal(a.welcome.weapon, 1, "Locker weapons do not carry into battle royale");
    const r = server.rooms.get("BRLOOT")!,
      p = r.players.get(a.welcome.id)!;
    assert.equal(p.weapon, 1);
    const actors = [p, ...r.bots.filter((b) => b.active)];
    for (const b of r.bots.filter((b) => b.active)) assert.equal(b.weapon, 1);
    let nearest = Infinity;
    for (let i = 0; i < actors.length; i++)
      for (let j = i + 1; j < actors.length; j++)
        nearest = Math.min(
          nearest,
          Math.hypot(actors[i].x - actors[j].x, actors[i].y - actors[j].y),
        );
    assert.ok(nearest > 400, "spawns are spread far apart (" + Math.round(nearest) + ")");
    // Keep bots from interfering, then stand on a chest and open it.
    // (Deactivating them would end the round with the player as last one standing.)
    for (const b of r.bots) {
      b.x = 50000;
      b.y = 50000;
    }
    const chunk = new Chunk();
    let chest: { x: number; y: number } | null = null;
    for (let cy = -2; cy <= 2 && !chest; cy++)
      for (let cx = -2; cx <= 2 && !chest; cx++) {
        chunk.generate(seedHash("loot-seed"), cx, cy, r.relief, r.density);
        const i = chunk.kind.findIndex(
          (k, n) => k === 2 && chunk.hp[n] > 0 && chunk.chest[n] === 1,
        );
        if (i >= 0) chest = { x: chunk.ox[i], y: chunk.oy[i] };
      }
    assert.ok(chest, "a chest exists near the origin");
    p.x = chest!.x;
    p.y = chest!.y;
    p.health = 40;
    send(a.ws, 4);
    await delay(60);
    const gun = r.loots.find((l) => l.gun);
    assert.ok(gun && gun.ammo > 0, "chest drops a gun with ammo");
    const med = r.loots.find((l) => l.heal > 0);
    if (med) {
      p.x = med.x;
      p.y = med.y;
      await delay(150);
      assert.ok(p.health >= 90 || p.health === 100, "medkit heals on pickup");
    }
    p.x = gun!.x;
    p.y = gun!.y;
    send(a.ws, 4);
    await delay(60);
    assert.notEqual(p.weapon, 1, "collected the chest gun");
  } finally {
    await server.close();
  }
});

test("authority allows sprint speed only while stamina lasts", async () => {
  const server = createGameServer(0, "127.0.0.1");
  await once(server.http, "listening");
  const url =
    "ws://127.0.0.1:" + (server.http.address() as { port: number }).port;
  try {
    const a = await join(url, "SPRINT", "solo", true, { create: true, bots: false });
    const r = server.rooms.get("SPRINT")!,
      p = r.players.get(a.welcome.id)!;
    p.x = 0;
    p.y = 0;
    p.lastMove = Date.now();
    await delay(50);
    send(a.ws, 1, 18, 0, 0); // ~360 u/s: only legal while sprinting
    await delay(20);
    assert.equal(p.x, 18, "sprint step accepted with stamina");
    assert.ok(p.stamina < 100, "sprinting drains stamina");
    p.stamina = 0;
    p.lastMove = Date.now();
    await delay(50);
    send(a.ws, 1, 36, 0, 0);
    await delay(20);
    assert.equal(p.x, 18, "sprint step rejected when exhausted");
  } finally {
    await server.close();
  }
});
