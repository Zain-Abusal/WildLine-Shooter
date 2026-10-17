import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSignal, MemoryStore } from "../src/signal";

test("signaling registers rooms, rejects duplicate codes and relays one offer/answer", async () => {
  const store = new MemoryStore();
  const host = await handleSignal(store, {
    action: "host",
    create: true,
    code: "ABC123",
    public: false,
    mode: "ctf",
  });
  assert.equal(host.status, 200);
  const taken = await handleSignal(store, {
    action: "host",
    create: true,
    code: "ABC123",
  });
  assert.equal(taken.status, 409);
  const room = await handleSignal(store, { action: "room", code: "ABC123" });
  assert.equal((room.body as any).mode, "ctf");
  assert.equal(
    (await handleSignal(store, { action: "offer", code: "NOPE", id: "peer01", sdp: "x" }))
      .status,
    404,
  );
  await handleSignal(store, { action: "offer", code: "ABC123", id: "peer01", sdp: "offer-sdp" });
  const offers = await handleSignal(store, { action: "offers", code: "ABC123" });
  assert.deepEqual((offers.body as any).offers, [{ id: "peer01", sdp: "offer-sdp" }]);
  assert.deepEqual(
    ((await handleSignal(store, { action: "offers", code: "ABC123" })).body as any).offers,
    [],
    "offers are consumed once",
  );
  assert.equal(
    ((await handleSignal(store, { action: "poll", code: "ABC123", id: "peer01" })).body as any)
      .sdp,
    null,
  );
  await handleSignal(store, { action: "answer", code: "ABC123", id: "peer01", sdp: "answer-sdp" });
  const answer = await handleSignal(store, { action: "poll", code: "ABC123", id: "peer01" });
  assert.equal((answer.body as any).sdp, "answer-sdp");
  await handleSignal(store, { action: "close", code: "ABC123" });
  assert.equal((await handleSignal(store, { action: "room", code: "ABC123" })).status, 404);
});

test("public matchmaking picks the busiest joinable public room and skips private/excluded ones", async () => {
  const store = new MemoryStore();
  await handleSignal(store, { action: "host", create: true, code: "PRIV", public: false, humans: 9 });
  await handleSignal(store, { action: "host", create: true, code: "PUB1", public: true, humans: 2 });
  await handleSignal(store, { action: "host", create: true, code: "PUB2", public: true, humans: 5 });
  await handleSignal(store, {
    action: "host",
    create: true,
    code: "PUB3",
    public: true,
    humans: 8,
    joinable: false,
  });
  const find = (exclude = "") =>
    handleSignal(store, { action: "find", exclude }).then((r) => (r.body as any).room?.code);
  assert.equal(await find(), "PUB2");
  assert.equal(await find("PUB2"), "PUB1");
});

test("signaling validates codes, ids and payload sizes", async () => {
  const store = new MemoryStore();
  for (const body of [
    null,
    { action: "nope" },
    { action: "host", code: "bad code!" },
    { action: "offer", code: "OK", id: "X", sdp: "s" },
    { action: "answer", code: "OK", id: "peer01", sdp: "x".repeat(30000) },
  ])
    assert.ok((await handleSignal(store, body)).status >= 400);
});

test("matchmaking prefers the same bracket and never pairs brackets more than one apart", async () => {
  const store = new MemoryStore();
  await handleSignal(store, { action: "host", create: true, code: "ROOK", public: true, humans: 3, tier: 0 });
  await handleSignal(store, { action: "host", create: true, code: "REGU", public: true, humans: 9, tier: 1 });
  await handleSignal(store, { action: "host", create: true, code: "ELIT", public: true, humans: 20, tier: 3 });
  const find = (tier: number) =>
    handleSignal(store, { action: "find", tier }).then((r) => (r.body as any).room?.code ?? null);
  assert.equal(await find(0), "ROOK", "same bracket beats a busier neighbour");
  assert.equal(await find(1), "REGU");
  assert.equal(await find(2), "ELIT", "one bracket apart is allowed");
  await handleSignal(store, { action: "close", code: "ELIT" });
  assert.equal(await find(3), null, "elite never lands in a rookie/regular lobby two brackets away");
});
