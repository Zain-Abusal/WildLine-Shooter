// Browser-hosted (Vercel-style) multiplayer: no game server, only /api/signal from the
// Vite dev middleware. Two separate browser contexts connect over WebRTC.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { host: "127.0.0.1", port: 4197, strictPort: true },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    // Use real loopback ICE candidates instead of mDNS names in CI sandboxes.
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const errors = [];
  const open = async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://127.0.0.1:4197");
    return page;
  };
  const engineValue = (page, expression) =>
    page.evaluate(
      async (expr) =>
        new Function("e", "return " + expr)(
          (await import("/src/main.ts")).engine,
        ),
      expression,
    );

  /** Polls an engine expression in Node until truthy (async page callbacks are not awaited by waitForFunction). */
  const until = async (page, expression, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await engineValue(page, expression)) return;
      await page.waitForTimeout(150);
    }
    throw new Error("Timed out waiting for: " + expression);
  };

  // Private party: host creates (CTF), friend joins by code.
  const host = await open();
  await host.locator("#start-party").click();
  await host.locator("#choose-create").click();
  await host.locator("#game-mode").selectOption("ctf");
  await host.locator("#create-party").click();
  await until(host, "e.network.connected");
  await host.waitForFunction(
    () => /^[A-Z0-9]{7}$/.test(document.getElementById("party-code").textContent),
  );
  const code = (await host.locator("#party-code").textContent()).trim();
  assert.match(code, /^[A-Z0-9]{7}$/);
  await host.locator("#party-play").click();

  const friend = await open();
  await friend.locator("#start-party").click();
  await friend.locator("#choose-join").click();
  await friend.locator("#room").fill(code);
  await friend.locator("#join-room").click();
  await until(friend, "e.network.connected");
  assert.equal(await engineValue(friend, "e.network.mode"), "ctf");
  await friend.locator("#party-play").click();
  await until(host, "e.network.humanCount === 2");
  await until(friend, "e.network.humanCount === 2");
  // The authority in the host's Worker streams live state to the friend.
  const t0 = await engineValue(friend, "e.network.elapsed");
  await friend.waitForTimeout(1200);
  assert.ok((await engineValue(friend, "e.network.elapsed")) > t0);
  await friend.screenshot({ path: "artifacts/p2p-friend.png" });

  // A third player joins by code.
  const buddy = await open();
  await buddy.locator("#start-party").click();
  await buddy.locator("#choose-join").click();
  await buddy.locator("#room").fill(code);
  await buddy.locator("#join-room").click();
  await until(buddy, "e.network.connected");
  await buddy.locator("#party-play").click();
  await until(host, "e.network.humanCount === 3");
  // The friend (first remote player) holds the backup; give them a kill to carry over.
  await until(friend, "e.network.successor", 8000);
  await friend.waitForTimeout(1500); // a backup that already includes the buddy
  const friendId = await engineValue(friend, "e.network.id");
  const buddyId = await engineValue(buddy, "e.network.id");

  // Host migration: closing the host's tab moves the match to the friend's browser.
  await host.close({ runBeforeUnload: true });
  await host.context().close();
  // Evidence of migration: the friend now hosts (party host role) and the buddy follows.
  await until(friend, "e.network.host && !e.network.migrating && e.network.connected", 30000);
  await until(buddy, "!e.network.migrating && e.network.connected && e.network.humanCount === 2", 40000);
  assert.equal(await engineValue(friend, "e.network.room"), code, "same party code");
  assert.equal(await engineValue(friend, "e.network.id"), friendId, "same player identity");
  assert.equal(await engineValue(buddy, "e.network.id"), buddyId);
  assert.equal(await engineValue(friend, "e.started"), true, "still in the match, not the start screen");
  await until(buddy, "e.network.humanCount === 2", 15000);
  const t1 = await engineValue(buddy, "e.network.elapsed");
  await buddy.waitForTimeout(1200);
  assert.ok((await engineValue(buddy, "e.network.elapsed")) > t1, "the new host runs the match");
  await buddy.screenshot({ path: "artifacts/p2p-migrated.png" });

  // When the last remote player leaves, a solo host simply ends the room.
  await friend.evaluate(async () =>
    (await import("/src/main.ts")).engine.network.disconnect(),
  );
  await until(buddy, "!e.network.connected || e.network.migrating", 15000);
  await buddy.context().close();

  // A stale public listing (host already gone) must be skipped, not reported as "not found".
  const stale = await fetch("http://127.0.0.1:4197/api/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "host",
      create: true,
      code: "PSTALE01",
      public: true,
      humans: 20,
    }),
  });
  assert.equal(stale.status, 200);

  // Public: first player hosts automatically, second finds and joins that match.
  const a = await open();
  await a.locator("#play-public").click();
  await until(a, "e.network.connected", 40000);
  assert.equal(await engineValue(a, "e.network.public"), true);
  assert.notEqual(await engineValue(a, "e.network.room"), "PSTALE01");
  const b = await open();
  await b.locator("#play-public").click();
  await until(b, "e.network.humanCount === 2");
  assert.equal(
    await engineValue(b, "e.network.room"),
    await engineValue(a, "e.network.room"),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: browser-hosted P2P private party (CTF) join by code, live authority state, host migration on tab close (successor hosts, third player reconnects), public auto-host and matchmaking join.",
  );
} finally {
  await browser?.close();
  await server.close();
}
