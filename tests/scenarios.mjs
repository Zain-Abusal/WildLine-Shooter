import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { once } from "node:events";
import { createGameServer } from "../server/index.ts";
/** Polls an async page callback until truthy; Playwright's waitForFunction does not await returned promises. */
async function waitAsync(page, fn, arg, options = {}) {
  const end = Date.now() + (options.timeout ?? 20000);
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return;
    await page.waitForTimeout(100);
  }
  throw new Error("Timed out waiting for " + fn.toString().slice(0, 120));
}
const realtime = createGameServer(0, "127.0.0.1");
await once(realtime.http, "listening");
const wsURL = "ws://127.0.0.1:" + realtime.http.address().port;
const server = await createServer({
  define: { "import.meta.env.VITE_MULTIPLAYER_URL": JSON.stringify(wsURL) },
  server: { host: "127.0.0.1", port: 4182, strictPort: true },
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.routeWebSocket(wsURL, (ws) => {
    let entered = false;
    ws.onMessage((raw) => {
      if (typeof raw === "string") {
        ws.send(
          JSON.stringify({
            t: "welcome",
            id: 1,
            team: 0,
            public: true,
            room: "LEGACY",
            seed: "legacy-seed",
            x: 0,
            y: 0,
          }),
        );
      } else {
        const packet = new Float64Array(raw.buffer, raw.byteOffset, 4);
        if (packet[0] === 5) entered = true;
        if (entered)
          ws.send(
            JSON.stringify({
              t: "state",
              players: [
                { id: 1, x: 0, y: 0, health: 100, ready: true, name: "Legacy" },
              ],
            }),
          );
      }
    });
  });
  await page.goto("http://127.0.0.1:4182");
  assert.ok(await page.locator(".seed-bar").isHidden());
  await page.locator("#play-public").click();
  assert.ok(
    await page.locator("#party-screen").isHidden(),
    "Public never opens party onboarding",
  );
  await waitAsync(page,async () => {
    const e = (await import("/src/main.ts")).engine;
    return e.started && e.network.connected;
  });
  await page.waitForTimeout(600);
  assert.ok(
    await page.locator("#result-screen").isHidden(),
    "incomplete public snapshots cannot cause instant elimination",
  );
  assert.equal(
    await page.evaluate(
      async () => (await import("/src/main.ts")).engine.player.kills,
    ),
    0,
  );
  assert.equal(
    await page.evaluate(
      async () => (await import("/src/main.ts")).engine.player.gun,
    ),
    0,
  );
  await page.screenshot({ path: "artifacts/legacy-public-fixed.png" });
  await page.close();

  const host = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  host.on("pageerror", (e) => errors.push(e.message));
  await host.goto("http://127.0.0.1:4182");
  await host.locator("#start-party").click();
  await host.locator("#choose-create").click();
  await host.locator("#private-bots").uncheck();
  assert.ok(await host.locator("#bot-difficulty").isDisabled());
  await host.locator("#private-bots").check();
  await host.locator("#bot-difficulty").selectOption("1.35");
  await host.locator("#create-party").click();
  await waitAsync(host,
    async () => (await import("/src/main.ts")).engine.network.connected,
  );
  const code = await host.locator("#party-code").textContent();
  assert.ok(!code.includes("undefined"));
  await host.locator("#party-play").click();
  await waitAsync(host,
    async () => (await import("/src/main.ts")).engine.network.botCount === 29,
  );
  assert.ok(await host.locator("#result-screen").isHidden());
  const room = realtime.rooms.get(code),
    seed = room.seed;
  assert.equal(room.botDifficulty, 1.35);
  await host.locator("#leaderboard-open").click();
  assert.equal(await host.locator(".leaderboard-row:visible").count(), 30);
  await host.screenshot({ path: "artifacts/leaderboard.png" });
  await host.locator("#leaderboard-screen").click({ position: { x: 3, y: 3 } });
  assert.ok(await host.locator("#leaderboard-screen").isHidden());
  const participant = [...room.players.values()][0];
  for (const bot of room.bots) {
    bot.x = 5000;
    bot.y = 5000;
  }
  const victim = room.bots.find(
    (bot) => bot.active && bot.team !== participant.team,
  );
  victim.x = 60;
  victim.y = 0;
  victim.health = 15;
  participant.x = participant.y = 0;
  participant.lastShot = 0;
  await host.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.player.x = e.player.y = e.cameraX = e.cameraY = 0;
    e.network.attack(0, 0);
  });
  await waitAsync(host,
    async () => (await import("/src/main.ts")).engine.network.kills === 1,
  );
  await host.waitForFunction(
    () => document.getElementById("kills-count").textContent === "1",
  );
  assert.ok(
    (await host.locator("#kill-feed").textContent()).includes(victim.name),
  );
  assert.equal(
    await host.evaluate(
      async () => (await import("/src/main.ts")).engine.profile.coins,
    ),
    25,
    "kill reward credited exactly once",
  );
  await host.screenshot({ path: "artifacts/kill-feed.png" });
  room.edits.set("0,0,0", { x: 0, y: 0, i: 0, hp: 0 });
  await host.locator("#leaderboard-open").click();
  room.winner = 0;
  await host.waitForFunction(
    () => !document.getElementById("result-screen").hidden,
  );
  assert.equal(await host.locator("#result-title").textContent(), "VICTORY");
  assert.ok(
    await host.locator("#leaderboard-screen").isHidden(),
    "round result closes the live leaderboard",
  );
  assert.ok(
    !(await host.locator("#result-stats").textContent()).includes("undefined"),
  );
  await host.locator("#result-again").click();
  await waitAsync(host,async () => {
    const e = (await import("/src/main.ts")).engine;
    return (
      e.network.round === 2 && document.getElementById("result-screen").hidden
    );
  });
  assert.notEqual(room.seed, seed);
  assert.equal(room.players.size, 1);
  assert.equal(room.edits.size, 0);
  assert.equal(
    await host.evaluate(
      async () => (await import("/src/main.ts")).engine.network.room,
    ),
    code,
  );
  assert.equal(
    await host.evaluate(
      async () => (await import("/src/main.ts")).engine.player.kills,
    ),
    0,
  );
  await host.screenshot({ path: "artifacts/private-rematch.png" });
  await host.keyboard.press("Escape");
  await host.locator("#back-to-lobby").click();
  await host.locator("#start-party").click();
  await host.locator("#choose-join").click();
  await host.locator("#room").fill("NOT-A-ROOM");
  await host.locator("#join-room").click();
  await host.waitForFunction(() =>
    document
      .getElementById("connection-status")
      .textContent.includes("not found"),
  );
  assert.ok(await host.locator("#join-room").isEnabled());
  await host.locator("#party-back").click();
  await host.locator("#choose-create").click();
  await host.locator("#practice-game").click();
  await waitAsync(host,
    async () => (await import("/src/main.ts")).engine.enemies.count === 26,
  );
  assert.ok(
    await host.evaluate(async () => {
      const e = (await import("/src/main.ts")).engine;
      // Measure creation positions before simulation can move fighters into engagements.
      e.enemies.clear();
      e.enemySpawned = 0;
      e.syncEnemies();
      for (let n = 0; n < 26; n++)
        for (let k = n + 1; k < 26; k++)
          if (
            Math.hypot(
              e.enemies.x[n] - e.enemies.x[k],
              e.enemies.y[n] - e.enemies.y[k],
            ) < 120
          )
            return false;
      return true;
    }),
    "offline enemies start spread apart",
  );
  assert.equal(
    await host.locator("#world").evaluate((el) => getComputedStyle(el).cursor),
    "crosshair",
  );
  assert.ok(await host.locator(".center-mark").isHidden());
  await host.keyboard.press("Tab");
  assert.ok(await host.locator("#leaderboard-screen").isVisible());
  await host.keyboard.press("Escape");
  assert.ok(await host.locator("#leaderboard-screen").isHidden());
  const result = await host.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.paused = true;
    e.world.reset("axe", 0, 0);
    e.world.sync(0, 0, e.viewW, e.viewH);
    for (const c of e.world.chunks) if (c.active) c.hp.fill(0);
    const c = e.world.chunks.find((c) => c.active && c.x === 0 && c.y === 0);
    c.count = 1;
    c.ox[0] = 75;
    c.oy[0] = 35;
    c.kind[0] = 0;
    c.hp[0] = 60;
    c.drop[0] = 1;
    e.player.x = e.player.y = e.player.angle = 0;
    e.input.pointerAim = false;
    e.input.weapon = 1;
    e.input.shoot = true;
    e.player.cooldown = 0;
    e.enemies.clear();
    e.enemySpawned = 0;
    e.update(1 / 60);
    const first = c.hp[0];
    e.player.cooldown = 0;
    e.update(1 / 60);
    e.input.shoot = false;
    return { first, hp: c.hp[0], supplies: e.player.supplies };
  });
  assert.equal(result.first, 25);
  assert.equal(result.hp, 0);
  assert.ok(result.supplies >= 3);
  await host.close();
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await mobile.goto("http://127.0.0.1:4182");
  await mobile.screenshot({ path: "artifacts/readable-start.png" });
  assert.ok(await mobile.locator("#credits-link").isVisible());
  await mobile.locator("#shop-open").tap();
  assert.equal(await mobile.locator("#shop-items .shop-item").count(), 12);
  assert.ok(
    /STANDARD|RARE|EPIC/.test(
      await mobile.locator(".item-type").first().textContent(),
    ),
  );
  await mobile.screenshot({ path: "artifacts/readable-shop.png" });
  assert.ok(
    await mobile
      .locator(".item-description")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 13),
  );
  assert.ok(
    await mobile
      .locator(".item-stats span")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 12),
  );
  assert.ok(
    await mobile
      .locator(".item-footer button")
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize) >= 13),
  );
  await mobile.locator("#shop-screen").tap({ position: { x: 3, y: 3 } });
  assert.ok(await mobile.locator("#shop-screen").isHidden());
  await mobile.goto("http://127.0.0.1:4182/about.html");
  assert.equal(
    (await mobile.locator("#creator-name").textContent()).trim(),
    "Zain AbusalDeveloper. Builder. Explorer.",
  );
  assert.ok(
    await mobile.getByRole("link", { name: "VISIT MY PORTFOLIO" }).isVisible(),
  );
  assert.ok(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await mobile.screenshot({
    path: "artifacts/about-mobile.png",
    fullPage: true,
  });
  await mobile.setViewportSize({ width: 1440, height: 900 });
  await mobile.screenshot({
    path: "artifacts/about-desktop.png",
    fullPage: true,
  });
  // Game modes and private spectating.
  const createMode = async (mode) => {
    const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    pg.on("pageerror", (e) => errors.push(e.message));
    await pg.goto("http://127.0.0.1:4182");
    await pg.locator("#start-party").click();
    await pg.locator("#choose-create").click();
    await pg.locator("#game-mode").selectOption(mode);
    await pg.locator("#create-party").click();
    await waitAsync(pg,
      async () => (await import("/src/main.ts")).engine.network.connected,
    );
    const roomCode = await pg.locator("#party-code").textContent();
    await pg.locator("#party-play").click();
    await waitAsync(pg,
      async () => (await import("/src/main.ts")).engine.network.botCount === 29,
    );
    return { pg, r: realtime.rooms.get(roomCode) };
  };
  const ctf = await createMode("ctf");
  assert.equal(ctf.r.mode, "ctf");
  await ctf.pg.waitForFunction(() =>
    document.querySelector("#storm-status").textContent.startsWith("CTF"),
  );
  const ctfPlayer = [...ctf.r.players.values()][0];
  ctfPlayer.x = ctfPlayer.team === 0 ? -1350 : 1350;
  ctfPlayer.y = 0;
  await ctf.pg.evaluate(async (pos) => {
    const e = (await import("/src/main.ts")).engine;
    e.player.x = pos.x;
    e.player.y = 0;
  }, { x: ctfPlayer.x });
  await ctf.pg.waitForTimeout(400);
  await ctf.pg.screenshot({ path: "artifacts/mode-ctf.png" });
  await ctf.pg.close();

  const ffa = await createMode("ffa");
  const ffaPlayer = [...ffa.r.players.values()][0];
  ffaPlayer.health = 0;
  ffaPlayer.deadUntil = Date.now() + 2500;
  await ffa.pg.waitForSelector("#respawn-banner", { state: "visible" });
  assert.ok(await ffa.pg.locator("#result-screen").isHidden());
  await ffa.pg.screenshot({ path: "artifacts/mode-ffa-respawn.png" });
  await ffa.pg.waitForSelector("#respawn-banner", { state: "hidden" });
  assert.equal(ffaPlayer.health, 100);
  await ffa.pg.close();

  const spec = await createMode("teams");
  const specPlayer = [...spec.r.players.values()][0];
  specPlayer.health = 0;
  specPlayer.deadUntil = Number.MAX_SAFE_INTEGER;
  await spec.pg.waitForSelector("#spectate-bar", { state: "visible" });
  assert.ok(
    await spec.pg.locator("#result-screen").isHidden(),
    "private elimination spectates instead of ending",
  );
  const firstName = await spec.pg.locator("#spectate-name").textContent();
  assert.ok(firstName.includes("ALLY"), "spectating starts on a teammate");
  await spec.pg.locator("#spectate-next").click();
  await spec.pg.screenshot({ path: "artifacts/spectate.png" });
  await spec.pg.locator("#spectate-leave").click();
  assert.ok(await spec.pg.locator("#result-screen").isVisible());
  assert.equal(
    await spec.pg.locator("#result-title").textContent(),
    "ELIMINATED",
  );
  await spec.pg.close();

  assert.deepEqual(errors, []);
  console.log(
    "PASS: capture the flag HUD/flags, free-for-all respawn, private spectating; legacy Public snapshots without Party flash, private solo entry/rematch, new map state, actual kill credit/rewards/feed, 30-slot leaderboard and backdrop close, distributed spawns, native cursor, private bot controls, axe hits, 12 unowned tagged shop items and creator credits.",
  );
} finally {
  await browser?.close();
  await server.close();
  await realtime.close();
}
