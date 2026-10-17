import { test } from "node:test";
import assert from "node:assert/strict";
import { Profile, tierFor, KILL_EFFECTS, DANCES } from "../src/profile";
import {
  WEAPONS,
  stormRadius,
  stormDamage,
  STORM_START_RADIUS,
  STORM_END,
} from "../src/combat";
test("device progression saves coins, purchases and equipped loadouts without allowing overspending", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  const p = new Profile(storage);
  assert.equal(p.buyWeapon(2), false);
  p.reward(650, 1000);
  assert.equal(p.buyWeapon(2), true);
  assert.equal(p.coins, 300);
  assert.equal(p.buySkin(1), true);
  p.save();
  const restored = new Profile(storage);
  assert.equal(restored.weapon, 2);
  assert.equal(restored.skin, 1);
  assert.equal(restored.coins, 150);
  assert.equal(restored.xp, 1000);
  assert.equal(restored.buyWeapon(3), false);
  assert.equal(restored.coins, 150);
});
test("corrupt or blocked storage falls back without breaking the game", () => {
  const p = new Profile({
    getItem: () => "{broken",
    setItem: () => {
      throw new Error("blocked");
    },
  });
  assert.equal(p.coins, 0);
  p.reward(25, 100);
  p.save();
  assert.equal(p.storageAvailable, false);
  assert.equal(p.coins, 25);
});
test("storm contracts monotonically to zero and firearms have finite reach and ammo", () => {
  let previous = STORM_START_RADIUS;
  for (let t = 0; t <= STORM_END + 30; t++) {
    const radius = stormRadius(t);
    assert.ok(radius >= 0 && radius <= previous);
    previous = radius;
  }
  assert.equal(stormRadius(0), STORM_START_RADIUS);
  assert.ok(STORM_START_RADIUS > 1900, "match area is larger than the original");
  assert.equal(stormRadius(STORM_END), 0);
  assert.ok(stormDamage(STORM_END - 10) > stormDamage(50));
  for (const id of [0, 2, 3, 4, 5, 6, 7]) {
    assert.ok(WEAPONS[id].magazine > 0);
    assert.ok(Number.isFinite(WEAPONS[id].range));
    assert.ok(WEAPONS[id].range < 2000);
  }
});

test("new guns and outfits can be unlocked, equipped and restored", () => {
  let value = "";
  const storage = {
    getItem: () => value,
    setItem: (_: string, v: string) => {
      value = v;
    },
  };
  const p = new Profile(storage);
  p.reward(2000, 0);
  assert.equal(p.buyWeapon(4), true);
  assert.equal(p.buyWeapon(5), true);
  assert.equal(p.buySkin(3), true);
  assert.equal(p.buySkin(4), true);
  const restored = new Profile(storage);
  assert.equal(restored.weapon, 5);
  assert.equal(restored.skin, 4);
  assert.equal(restored.coins, 550);
  assert.equal(restored.buyWeapon(8), false);
  assert.equal(restored.buySkin(7), false);
});

test("games played drive the matchmaking bracket and persist", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  const p = new Profile(storage);
  assert.equal(p.tier, 0);
  for (let n = 0; n < 5; n++) p.recordGame(n === 0);
  p.save();
  const again = new Profile(storage);
  assert.equal(again.games, 5);
  assert.equal(again.wins, 1);
  assert.equal(again.tier, 1);
  assert.equal(tierFor(20), 2);
  assert.equal(tierFor(60), 3);
});

test("kill effects and victory dances unlock, equip, persist and never overdraw coins", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  const p = new Profile(storage);
  assert.equal(p.effect, 0);
  assert.equal(p.dance, 0);
  assert.equal(p.buyCosmetic("effect", 4), false, "cannot afford");
  assert.equal(p.coins, 0);
  p.reward(KILL_EFFECTS[2].cost + DANCES[3].cost, 0);
  assert.ok(p.buyCosmetic("effect", 2));
  assert.ok(p.buyCosmetic("dance", 3));
  assert.equal(p.coins, 0);
  assert.equal(p.buyCosmetic("dance", 99), false);
  const again = new Profile(storage);
  assert.equal(again.effect, 2);
  assert.equal(again.dance, 3);
  assert.ok(again.effects & (1 << 2));
  data.set("wildline.profile.v1", JSON.stringify({ effect: 4, effects: 1, dance: -2 }));
  const tampered = new Profile(storage);
  assert.equal(tampered.effect, 0, "unowned equipped effect falls back");
  assert.equal(tampered.dance, 0);
});
