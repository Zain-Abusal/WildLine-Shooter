import { test } from "node:test";
import assert from "node:assert/strict";
import { Chunk, World, seedHash, simplex, CHUNK } from "../src/world";
import { Pool, Player } from "../src/entities";

test("same text seed and coordinates reproduce heights, objects and drops", () => {
  for (const seed of ["wildline", "iPad battle 2026", "雪山"])
    for (const x of [-200, -1, 0, 81]) {
      const a = new Chunk(),
        b = new Chunk();
      a.generate(seedHash(seed), x, -31);
      b.generate(seedHash(seed), x, -31);
      assert.deepEqual(a.heights, b.heights);
      assert.deepEqual(a.terrain, b.terrain);
      assert.deepEqual(a.ox, b.ox);
      assert.deepEqual(a.oy, b.oy);
      assert.deepEqual(a.kind, b.kind);
      assert.deepEqual(a.drop, b.drop);
    }
  const a = new Chunk(),
    b = new Chunk();
  a.generate(seedHash("alpha"), 0, 0);
  b.generate(seedHash("beta"), 0, 0);
  assert.notDeepEqual(a.heights, b.heights);
  assert.notDeepEqual(a.ox, b.ox);
});
test("simplex is finite, deterministic, and continuous across a chunk edge", () => {
  for (let n = -10; n < 10; n++) {
    const left = simplex(123, (CHUNK - 0.001) / 1300, n / 10),
      right = simplex(123, (CHUNK + 0.001) / 1300, n / 10);
    assert.ok(Number.isFinite(left));
    assert.ok(Math.abs(left - right) < 0.001);
    assert.equal(simplex(123, n, n / 3), simplex(123, n, n / 3));
  }
});
test("travel reuses chunk storage, evicts distant chunks, and stays within padded bounds", () => {
  const w = new World("test");
  const slots = w.chunks.slice();
  const arrays = w.chunks.map((c) => c.ox);
  for (let step = 0; step < 250; step++) {
    w.sync(step * CHUNK, -step * CHUNK, 1800, 1100);
    assert.ok(w.activeCount > 0 && w.activeCount <= 49);
    for (let n = 0; n < w.capacity; n++) {
      const c = w.chunks[n];
      assert.equal(c, slots[n]);
      assert.equal(c.ox, arrays[n]);
      if (c.active)
        assert.ok(
          c.x >= w.minX && c.x <= w.maxX && c.y >= w.minY && c.y <= w.maxY,
        );
    }
  }
});
test("damage survives eviction and seed reset restores the pristine world", () => {
  const w = new World("edit");
  w.sync(0, 0, 1000, 700);
  const c = w.chunks.find((c) => c.active && c.x === 0 && c.y === 0)!;
  w.damage(c, 5, 99);
  assert.equal(c.hp[5], 0);
  w.sync(100000, 100000, 1000, 700);
  w.sync(0, 0, 1000, 700);
  assert.equal(
    w.chunks.find((c) => c.active && c.x === 0 && c.y === 0)!.hp[5],
    0,
  );
  w.reset("edit");
  w.sync(0, 0, 1000, 700);
  assert.ok(
    w.chunks.find((c) => c.active && c.x === 0 && c.y === 0)!.hp[5] > 0,
  );
});
test("projectile/particle/entity pools saturate, recycle, and never expand", () => {
  const pool = new Pool(3),
    storage = pool.x;
  assert.equal(pool.spawn(1, 2, 3, 4, 1), 0);
  pool.spawn(0, 0, 0, 0, 1);
  pool.spawn(0, 0, 0, 0, 1);
  assert.equal(pool.spawn(0, 0, 0, 0, 1), -1);
  assert.equal(pool.count, 3);
  pool.release(1);
  pool.release(1);
  assert.equal(pool.count, 2);
  assert.equal(pool.spawn(5, 6, 0, 0, 1), 1);
  assert.equal(pool.x[1], 5);
  assert.equal(pool.x, storage);
  pool.clear();
  assert.equal(pool.count, 0);
  assert.equal(
    pool.active.reduce((a, b) => a + b, 0),
    0,
  );
});
test("momentum caps diagonal speed and decays smoothly on release", () => {
  const p = new Player();
  for (let n = 0; n < 600; n++) p.update(1 / 60, 1, 1);
  assert.ok(Math.hypot(p.vx, p.vy) <= 235.001);
  const before = p.x;
  p.update(1 / 60, 0, 0);
  assert.ok(p.x > before);
  for (let n = 0; n < 120; n++) p.update(1 / 60, 0, 0);
  assert.ok(Math.hypot(p.vx, p.vy) < 0.001);
  p.health = 20;
  p.reset();
  assert.equal(p.health, 100);
  assert.equal(p.x, 0);
});

test("custom generation changes relief and enemy density reproducibly", () => {
  const flat = new Chunk(),
    alpine = new Chunk(),
    repeat = new Chunk(),
    peaceful = new Chunk();
  const seed = seedHash("custom");
  flat.generate(seed, 2, 3, 0, 0.04);
  alpine.generate(seed, 2, 3, 1.9, 0.12);
  repeat.generate(seed, 2, 3, 1.9, 0.12);
  peaceful.generate(seed, 2, 3, 1, 0);
  assert.ok(flat.heights.every((h) => h === 0));
  assert.ok(alpine.heights.some((h) => Math.abs(h) > 0.2));
  assert.deepEqual(alpine.heights, repeat.heights);
  assert.deepEqual(alpine.kind, repeat.kind);
  assert.deepEqual(alpine.variant, repeat.variant);
  assert.ok(peaceful.kind.every((k) => k !== 3));
  const w = new World("custom");
  w.reset("custom", 1.9, 0.12);
  w.sync(0, 0, 1200, 900);
  let enemies = 0;
  for (const c of w.chunks)
    if (c.active)
      for (let j = 0; j < c.count; j++)
        if (c.kind[j] === 3 && c.hp[j] > 0) enemies++;
  assert.ok(enemies > 0);
  const other = new Chunk();
  other.generate(seedHash("other"), 0, 0);
  const first = new Chunk();
  first.generate(seed, 0, 0);
  assert.notEqual(first.heights[0], other.heights[0]);
});

test("land speed is direction independent and water slows movement", async () => {
  const { movementSpeed } = await import("../src/entities");
  for (const height of [-0.2, 0, 0.5, 1]) {
    const a = new Player(),
      b = new Player();
    for (let i = 0; i < 120; i++) {
      a.update(1 / 60, 1, 0, movementSpeed(height));
      b.update(1 / 60, Math.SQRT1_2, Math.SQRT1_2, movementSpeed(height));
    }
    assert.ok(
      Math.abs(Math.hypot(a.vx, a.vy) - Math.hypot(b.vx, b.vy)) < 0.001,
    );
    assert.ok(Math.hypot(a.vx, a.vy) > 234);
  }
  assert.equal(movementSpeed(-0.3), 145);
});

test("unchanged chunk bounds skip streaming scans and reset invalidates the cache", () => {
  const w = new World("cached");
  w.sync(0, 0, 800, 600);
  const counts = w.activeCount;
  const c = w.chunks.find((c) => c.active)!;
  const generate = c.generate;
  let calls = 0;
  c.generate = function (...args: Parameters<typeof generate>) {
    calls++;
    return generate.apply(this, args);
  };
  for (let i = 0; i < 100; i++) w.sync(0, 0, 800, 600);
  assert.equal(calls, 0);
  assert.equal(w.activeCount, counts);
  w.reset("new-seed");
  w.sync(0, 0, 800, 600);
  assert.ok(calls > 0);
  assert.equal(w.activeCount, counts);
});
