import { test } from "node:test";
import assert from "node:assert/strict";
import { Multiplayer } from "../src/network";
import { roundOutcome, finiteValue } from "../src/session";
import { axeReach } from "../src/combat";

test("only explicit winners or zero health end an entered round", () => {
  for (const missing of [undefined, null, NaN, "0", {}, -1, 99])
    assert.equal(roundOutcome(true, 100, missing, 0), "");
  assert.equal(roundOutcome(false, 0, 1, 0), "");
  assert.equal(roundOutcome(true, 100, 0, 0), "won");
  assert.equal(roundOutcome(true, 100, 1, 0), "lost");
  assert.equal(roundOutcome(true, 0, -1, 0), "lost");
  assert.equal(roundOutcome(true, 0, 2, 0), "draw");
  assert.equal(finiteValue(undefined, 0), 0);
});

test("legacy/incomplete snapshots preserve playable defaults without false loss or undefined stats", () => {
  const previousSocket = globalThis.WebSocket,
    previousLocation = (globalThis as any).location;
  let socket: any;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: any) => void) | null = null;
    close() {}
    send() {}
    constructor() {
      socket = this;
    }
  }
  (globalThis as any).WebSocket = FakeSocket;
  (globalThis as any).location = { protocol: "http:" };
  const network = new Multiplayer(),
    results: string[] = [],
    status: string[] = [];
  network.onResult = (r) => results.push(r);
  network.onStatus = (s) => status.push(s);
  const emit = (data: unknown) =>
    socket.onmessage({ data: JSON.stringify(data) });
  try {
    network.connect("ws://localhost", "LEGACY", "Test", "seed", 1, 0.04);
    emit({ t: "welcome", id: 1, room: "LEGACY", seed: "seed", x: 0, y: 0 });
    network.enterMatch();
    for (let i = 0; i < 3; i++)
      emit({
        t: "state",
        players: [{ id: 1, x: 0, y: 0, health: 100, ready: true }],
      });
    assert.deepEqual(results, []);
    assert.equal(network.health, 100);
    assert.equal(network.kills, 0);
    assert.equal(network.gun, 0);
    assert.equal(network.magazine, 24);
    assert.equal(network.reserve, 72);
    emit({
      t: "state",
      winner: null,
      players: [{ id: 1, x: 0, y: 0, health: null, weapon: 500, kills: null }],
    });
    assert.deepEqual(results, []);
    assert.equal(network.health, 100);
    assert.equal(network.kills, 0);
    emit({ t: "shot", id: 2, x: 0, y: 0, angle: 0, weapon: 500 });
    emit({
      t: "state",
      winner: 0,
      players: [{ id: 1, x: 0, y: 0, health: 100, ready: true, kills: 2 }],
    });
    assert.deepEqual(results, ["won"]);
    assert.equal(network.kills, 2);
    let credited = 0,
      feed = 0;
    network.onKill = (n) => (credited += n);
    network.onElimination = () => feed++;
    const elimination = {
      t: "elimination",
      serial: 1,
      killerId: 1,
      killer: "Test",
      victim: "Raider",
      weapon: 6,
      kills: 3,
    };
    emit(elimination);
    emit(elimination);
    assert.equal(credited, 1);
    assert.equal(feed, 1);
    assert.equal(network.kills, 3);
    emit({
      t: "state",
      players: [{ id: 1, x: 0, y: 0, health: 100, kills: 2 }],
    });
    assert.equal(network.kills, 3);
    assert.ok(status.every((s) => !s.includes("undefined")));
  } finally {
    network.disconnect(false);
    (globalThis as any).WebSocket = previousSocket;
    (globalThis as any).location = previousLocation;
  }
});

test("axe connects through a forward arc and rejects targets behind or beyond reach", () => {
  assert.ok(Number.isFinite(axeReach(0, 0, 0, 80, 45, 18)));
  assert.ok(Number.isFinite(axeReach(0, 0, 0, 118, 0, 18)));
  assert.equal(axeReach(0, 0, 0, 150, 0, 18), Infinity);
  assert.equal(axeReach(0, 0, 0, -60, 0, 18), Infinity);
  assert.ok(Number.isFinite(axeReach(0, 0, Math.PI / 2, 35, 80, 19)));
});

test("spectating and respawn rooms wait for an explicit winner; individual winners resolve by id", () => {
  // Private/respawn rooms pass finalOnDeath=false: elimination alone is not a result.
  assert.equal(roundOutcome(true, 0, -1, 0, undefined, 7, false), "");
  assert.equal(roundOutcome(true, 0, 0, 0, undefined, 7, false), "won");
  assert.equal(roundOutcome(true, 0, 1, 0, undefined, 7, false), "lost");
  assert.equal(roundOutcome(true, 100, 3, 0, 7, 7), "won");
  assert.equal(roundOutcome(true, 100, 3, 0, 8, 7), "lost");
  assert.equal(roundOutcome(true, 100, 3, 0, undefined, 7), "", "missing id is no result");
  assert.equal(roundOutcome(true, 0, 3, 0, 7, 7, false), "won");
});

test("compact snapshots keep names, teams and the human/bot split between full updates", () => {
  const previousSocket = globalThis.WebSocket,
    previousLocation = (globalThis as any).location;
  let socket: any;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    onmessage: ((event: any) => void) | null = null;
    close() {}
    send() {}
    constructor() {
      socket = this;
    }
  }
  (globalThis as any).WebSocket = FakeSocket;
  (globalThis as any).location = { protocol: "http:" };
  const network = new Multiplayer();
  const emit = (data: unknown) => socket.onmessage({ data: JSON.stringify(data) });
  try {
    network.connect("ws://localhost", "COMPACT", "Test", "seed", 1, 0.04);
    emit({ t: "welcome", id: 1, room: "COMPACT", seed: "seed", x: 0, y: 0, team: 0 });
    const full = [
      { id: 1, x: 0, y: 0, health: 100, ready: true, name: "Me", team: 0, bot: false },
      { id: -1, x: 10, y: 0, health: 100, ready: true, name: "BotOne", team: 1, bot: true, skin: 3 },
      { id: 7, x: 20, y: 0, health: 100, ready: true, name: "Friend", team: 0, bot: false },
    ];
    emit({ t: "state", players: full, loots: [{ x: 5, y: 5, weapon: 2, ammo: 10, gun: true }] });
    assert.equal(network.humanCount, 2);
    assert.equal(network.botCount, 1);
    // Compact snapshot: no static fields, no loots.
    emit({
      t: "state",
      players: full.map(({ id, x, y, health, ready }) => ({ id, x: x + 1, y, health, ready })),
    });
    assert.equal(network.humanCount, 2, "bots are not counted as humans");
    assert.equal(network.botCount, 1);
    const slot = network.ids.indexOf(-1);
    assert.equal(network.names[slot], "BotOne", "name kept between full snapshots");
    assert.equal(network.outfits[slot], 3);
    assert.equal(network.teams[slot], 1);
    assert.equal(network.loot.count, 1, "loot kept when the snapshot omits it");
  } finally {
    network.disconnect(false);
    (globalThis as any).WebSocket = previousSocket;
    (globalThis as any).location = previousLocation;
  }
});
