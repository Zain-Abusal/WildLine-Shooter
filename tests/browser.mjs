import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { createGameServer } from "../server/index.ts";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
/** Finish the end-of-round finale (victory dance / podium) and land on the results screen. */
async function toResults(page) {
  for (let n = 0; n < 200; n++) {
    if (await page.locator("#result-screen").isVisible()) return;
    if (await page.locator("#finale-screen").isVisible())
      await page.locator("#finale-skip").click();
    await page.waitForTimeout(50);
  }
  throw new Error("Results screen never appeared");
}
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
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
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
  const errors = [];
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const response = await page.goto(
    "http://127.0.0.1:4173/?dev-mode=true&seed=hacked&relief=999&health=999",
  );
  assert.equal(response.status(), 200);
  await page.waitForFunction(
    () => Number(document.getElementById("chunks").textContent) > 0,
  );
  await page.waitForTimeout(350);
  assert.equal(await page.locator("#world").evaluate((c) => c.width), 2880);
  assert.equal(new URL(page.url()).search, "?dev-mode=true");
  assert.equal(await page.locator("#seed").inputValue(), "wildline");
  assert.ok(await page.locator("#start-screen").isVisible());
  assert.equal(await page.locator("#server-url").count(), 0);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/start.png" });
  assert.equal(await page.locator(".start-actions button:visible").count(), 2);
  await page.locator("#play-game").evaluate((el) => el.click());
  assert.ok(await page.locator("#start-screen").isHidden());
  await waitAsync(page,
    async () => (await import("/src/main.ts")).engine.allies.count === 3,
  );
  assert.ok(
    await page.evaluate(async () => {
      const e = (await import("/src/main.ts")).engine;
      return 1 + e.allies.count + e.enemies.count <= 30;
    }),
  );

  assert.equal(await page.locator(".mission h1").count(), 0);
  assert.ok(await page.locator(".telemetry").isVisible());
  assert.ok(await page.locator(".seed-bar").isHidden());
  await page.getByRole("button", { name: "Toggle diagnostics" }).click();
  assert.ok(await page.locator(".telemetry").isHidden());
  await page.getByRole("button", { name: "Toggle diagnostics" }).click();
  const start = await page.locator("#coordinates").textContent();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(650);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(350);
  const moved = await page.locator("#coordinates").textContent();
  assert.notEqual(start, moved);
  await page.keyboard.press("Digit2");
  await page.waitForTimeout(300);
  assert.ok(
    await page
      .locator('[data-weapon="1"]')
      .evaluate((e) => e.classList.contains("selected")),
  );
  await page.keyboard.press("Digit1");
  await page.mouse.move(800, 420);
  await page.mouse.down();
  await page.waitForTimeout(450);
  assert.ok(
    await page.evaluate(async () => {
      const engine = (await import("/src/main.ts")).engine;
      return engine.input.shoot && engine.player.cooldown > 0;
    }),
  );
  await page.mouse.up();
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#pause-screen").isVisible());
  const paused = await page.locator("#coordinates").textContent();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyD");
  assert.equal(await page.locator("#coordinates").textContent(), paused);
  await page.getByRole("button", { name: "BACK TO THE FIELD" }).click();
  assert.ok(await page.locator("#pause-screen").isHidden());
  await page.locator("#seed").evaluate((el) => (el.value = "browser-seed"));
  await page.locator("#seed-form").evaluate((f) => f.requestSubmit());
  await page.waitForTimeout(350);
  assert.match(await page.locator("#coordinates").textContent(), /^0 E/);
  const signature = () =>
    page.evaluate(async () => {
      const w = (await import("/src/main.ts")).engine.world;
      const c = w.chunks.find((c) => c.active && c.x === 0 && c.y === 0);
      return JSON.stringify([
        Array.from(c.heights),
        Array.from(c.ox),
        Array.from(c.kind),
        Array.from(c.variant),
      ]);
    });
  const first = await signature();
  await page.locator("#relief").evaluate((el) => (el.value = "1.9"));
  await page.locator("#enemy-density").evaluate((el) => (el.value = "0"));
  await page.locator("#seed-form").evaluate((f) => f.requestSubmit());
  await page.waitForTimeout(350);
  assert.notEqual(await signature(), first);
  assert.equal(
    await page.evaluate(
      async () => (await import("/src/main.ts")).engine.enemies.count,
    ),
    0,
  );
  const custom = await signature();
  assert.equal(new URL(page.url()).search, "?dev-mode=true");
  await page.locator("#seed-form").evaluate((f) => f.requestSubmit());
  await page.waitForTimeout(300);
  assert.equal(await signature(), custom);
  await page.locator("#random-seed").evaluate((el) => el.click());
  await page.waitForTimeout(350);
  assert.notEqual(await signature(), custom);
  assert.notEqual(await page.locator("#seed").inputValue(), "browser-seed");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/desktop.png" });
  const mobile = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  const touch = await mobile.newPage();
  touch.on("pageerror", (e) => errors.push(e.message));
  await touch.goto("http://127.0.0.1:4173/?dev-mode=true");
  await touch.waitForFunction(() => document.body.classList.contains("touch"));
  assert.ok(await touch.locator("#start-screen").isVisible());
  await touch.locator("#play-game").evaluate((el) => el.click());
  assert.equal(await touch.locator(".mission h1").count(), 0);
  assert.ok(await touch.locator(".telemetry").isVisible());
  assert.ok(await touch.locator("#seed").isHidden());
  assert.ok(await touch.locator("#move-stick").isVisible());
  assert.ok(await touch.locator("#attack").isVisible());
  const move = await touch.locator("#move-stick").boundingBox(),
    aim = await touch.locator("#aim-stick").boundingBox(),
    attack = await touch.locator("#attack").boundingBox();
  const cdp = await mobile.newCDPSession(touch);
  const points = [
    { x: move.x + 52, y: move.y + 52, id: 1 },
    { x: aim.x + 52, y: aim.y + 52, id: 2 },
    { x: attack.x + 35, y: attack.y + 35, id: 3 },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: points,
  });
  points[0].x += 35;
  points[1].y -= 35;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: points,
  });
  await touch.waitForTimeout(750);
  assert.ok(
    await touch.evaluate(async () => {
      const engine = (await import("/src/main.ts")).engine;
      return engine.input.shoot && engine.player.cooldown > 0;
    }),
  );
  assert.ok(
    await touch
      .locator("#move-stick span")
      .evaluate((e) => e.style.transform.includes("translate")),
  );
  assert.notEqual(
    await touch.locator("#coordinates").textContent(),
    "0 E · 0 N",
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await touch.waitForTimeout(250);
  assert.equal(
    await touch.locator("#move-stick span").evaluate((e) => e.style.transform),
    "",
  );
  assert.equal(
    await touch.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.equal(
    await touch.evaluate(() => {
      const event = new Event("gesturestart", { cancelable: true });
      return document.dispatchEvent(event);
    }),
    false,
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: move.x + 80, y: move.y + 52, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  assert.ok(
    await touch.evaluate(async () => {
      const i = (await import("/src/main.ts")).engine.input;
      return i.mx === 0 && i.my === 0 && !i.shoot;
    }),
  );
  await touch.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.player.reserve = 0;
    e.loot.spawn(e.player.x, e.player.y, 20, 1, 1, 2);
  });
  // Ammo is automatic; guns are never auto-picked or auto-equipped.
  await waitAsync(touch,
    async () => (await import("/src/main.ts")).engine.player.reserve === 20,
  );
  await touch.waitForTimeout(700);
  const before = await touch.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.input.weapon = 1; // holding the axe
    return e.player.gun;
  });
  assert.notEqual(before, 2, "walking over a gun does not pick it up");
  // COLLECT press (the button sets input.collect through Pointer Events).
  await touch.evaluate(async () => {
    (await import("/src/main.ts")).engine.input.collect = true;
  });
  await waitAsync(touch,
    async () => (await import("/src/main.ts")).engine.player.gun === 2,
  );
  assert.equal(
    await touch.evaluate(async () => (await import("/src/main.ts")).engine.input.weapon),
    1,
    "taking a gun keeps the selected slot",
  );
  assert.ok(await touch.locator("#fullscreen").isVisible());
  await touch.screenshot({ path: "artifacts/ipad.png" });
  await touch.setViewportSize({ width: 390, height: 844 });
  await touch.waitForTimeout(300);
  assert.equal(
    await touch.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await touch.screenshot({ path: "artifacts/phone.png" });
  await mobile.close();
  await page.keyboard.press("Escape");
  await page.locator("#back-to-lobby").click();
  await page.locator("#start-party").click();
  assert.ok(await page.locator("#party-screen").isVisible());
  assert.ok(await page.locator("#pause-screen").isHidden());
  assert.equal(await page.locator("#party-choices button").count(), 2);
  assert.ok(await page.locator("#multiplayer-form").isHidden());
  await page.locator("#choose-create").click();
  assert.ok(await page.locator("#party-join-fields").isHidden());
  await page.locator("#party-visibility").selectOption("public");
  await page.locator("#callsign").fill("Host");
  await page
    .getByRole("button", { name: "CREATE PARTY", exact: false })
    .click();
  await waitAsync(page,
    async () => (await import("/src/main.ts")).engine.network.connected,
  );
  const partyCode = await page.locator("#party-code").textContent();
  assert.match(partyCode, /^[A-Z0-9]{7}$/);
  await page.getByRole("button", { name: "Close party menu" }).click();
  assert.ok(await page.locator("#start-screen").isVisible());
  assert.ok(await page.locator("#pause-screen").isHidden());
  const guest = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto("http://127.0.0.1:4173");
  await guest.locator("#start-party").click();
  await guest.locator("#choose-join").click();
  assert.ok(await guest.locator("#party-create-fields").isHidden());
  await guest.locator("#room").fill(partyCode);
  await guest.locator("#callsign").fill("Guest");
  await guest.locator("#join-room").click();
  await waitAsync(guest,async () => {
    const n = (await import("/src/main.ts")).engine.network;
    return n.humanCount === 2 && n.botCount === 28 && n.peers.count === 29;
  });
  assert.ok(await guest.locator("#start-screen").isVisible());
  assert.ok(await guest.locator("#pause-screen").isHidden());
  assert.equal(
    await guest.locator("#seed").inputValue(),
    await page.locator("#seed").inputValue(),
  );
  assert.ok(await guest.locator("#seed").isDisabled());
  await guest.locator("#party-play").click();
  assert.ok(await guest.locator("#start-screen").isHidden());
  await guest.screenshot({ path: "artifacts/multiplayer.png" });
  await guest
    .getByRole("button", { name: "PARTY ONLINE", exact: true })
    .click();
  await guest.locator("#leave-party").click();
  await waitAsync(page,async () => {
    const n = (await import("/src/main.ts")).engine.network;
    return n.humanCount === 1 && n.botCount === 29;
  });
  assert.ok(await guest.locator("#seed").isEnabled());
  await guest.locator("#choose-join").click();
  await guest.locator("#room").fill("");
  await guest.locator("#find-public").click();
  await waitAsync(guest,
    async () => (await import("/src/main.ts")).engine.network.connected,
  );
  assert.equal(await guest.locator("#party-code").textContent(), partyCode);
  await waitAsync(guest,async () => {
    const n = (await import("/src/main.ts")).engine.network;
    return n.public && n.humanCount === 2 && n.botCount === 28;
  });
  await guest.screenshot({ path: "artifacts/party-public.png" });
  await guest.locator("#leave-party").click();
  await guest.keyboard.press("Escape");
  assert.ok(await guest.locator("#party-screen").isHidden());
  assert.ok(await guest.locator("#pause-screen").isHidden());
  await guest.close();
  await page.getByRole("button", { name: "PARTY ONLINE", exact: true }).click();
  await page.locator("#leave-party").click();
  await page.locator("#close-party").click();
  await page.locator("#play-game").evaluate((el) => el.click());
  await page.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.player.health = 0;
    e.update(1 / 60);
  });
  // Losses skip the dance: podium first, then results.
  assert.ok(await page.locator("#finale-podium").isVisible());
  await toResults(page);
  assert.ok(await page.locator("#result-screen").isVisible());
  assert.equal(await page.locator("#result-title").textContent(), "ELIMINATED");
  await page.screenshot({ path: "artifacts/loss.png" });
  await page.locator("#result-again").click();
  await page.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.enemySpawned = 26;
    e.enemies.clear();
    e.update(1 / 60);
  });
  assert.equal(await page.locator("#result-title").textContent(), "VICTORY");
  // Win finale: dance stage → podium (top 3 with you) → results.
  assert.ok(await page.locator("#finale-dance").isVisible());
  assert.ok(await page.locator("#result-screen").isHidden(), "results wait for the dance");
  await page.locator("#finale-skip").click();
  assert.ok(await page.locator("#finale-podium").isVisible());
  assert.ok((await page.locator(".podium").textContent()).includes("YOU"));
  await page.screenshot({ path: "artifacts/podium.png" });
  await toResults(page);
  await page.locator("#result-home").click();
  await page.evaluate(async () => {
    const e = (await import("/src/main.ts")).engine;
    e.profile.reward(1000, 1000);
    e.profile.save();
  });
  await page.locator("#shop-open").click();
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll("#shop-items img"));
    return (
      images.length === 20 &&
      images.every((img) => img.complete && img.naturalWidth > 0)
    );
  });
  // The shop sells only unowned items; counts match what is listed.
  assert.equal(await page.locator("#shop-count").textContent(), "20");
  assert.equal(await page.locator("#shop-count-effects").textContent(), "4");
  assert.equal(await page.locator("#shop-count-dances").textContent(), "4");
  await page.locator('[data-shop-filter="weapons"]').click();
  assert.equal(await page.locator("#shop-items .shop-item").count(), 6);
  assert.equal(await page.locator("#shop-count-weapons").textContent(), "6");
  await page.locator('[data-shop-filter="outfits"]').click();
  assert.equal(await page.locator("#shop-items .shop-item").count(), 6);
  await page.locator('[data-shop-filter="all"]').click();

  await page
    .locator(".shop-row")
    .filter({ hasText: "BREACH SHOTGUN" })
    .getByRole("button")
    .click();
  await page
    .locator(".shop-row")
    .filter({ hasText: "AZURE OUTFIT" })
    .getByRole("button")
    .click();
  await page.screenshot({ path: "artifacts/shop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.ok(
    await page
      .locator(".shop-card")
      .evaluate(
        (el) =>
          el.getBoundingClientRect().width <= innerWidth &&
          el.scrollWidth <= el.clientWidth + 1,
      ),
  );
  await page.screenshot({ path: "artifacts/shop-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.locator("#shop-close").click();
  await page.locator("#locker-open").click();
  // Carbine, Ranger, shotgun, Azure + free Gold Burst effect and Victory Spin dance.
  assert.equal(await page.locator("#shop-items .shop-item").count(), 6);
  assert.equal(await page.locator("#shop-count").textContent(), "6");
  await page.locator("#shop-close").click();
  await page.locator("#shop-open").click();
  assert.equal(await page.locator("#shop-items .shop-item").count(), 18);
  assert.equal(
    await page.locator(".shop-row").filter({ hasText: "BREACH SHOTGUN" }).count(),
    0,
  );
  await page.locator("#shop-close").click();
  await page.locator("#locker-open").click();
  assert.equal(
    await page.locator(".item-state").filter({ hasText: "UNLOCK" }).count(),
    0,
  );
  await page.locator("#shop-close").click();
  const saved = await page.evaluate(async () => {
    const p = (await import("/src/main.ts")).engine.profile;
    return { coins: p.coins, xp: p.xp, weapon: p.weapon, skin: p.skin };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => Number(document.getElementById("chunks").textContent) > 0,
  );
  assert.deepEqual(
    await page.evaluate(async () => {
      const p = (await import("/src/main.ts")).engine.profile;
      return { coins: p.coins, xp: p.xp, weapon: p.weapon, skin: p.skin };
    }),
    saved,
  );
  assert.equal(saved.weapon, 2);
  assert.equal(saved.skin, 1);
  assert.ok(await page.locator("#play-public").isVisible());
  await page.locator("#play-public").click();
  await waitAsync(page,async () => {
    const e = (await import("/src/main.ts")).engine;
    return e.network.connected && e.started && e.network.humanCount === 1;
  });
  assert.ok(await page.locator("#start-screen").isHidden());
  assert.ok(await page.locator("#party-screen").isHidden());

  await page.locator("#map-toggle").click();
  assert.equal(
    await page.locator("#map-toggle").getAttribute("aria-expanded"),
    "true",
  );
  await page.screenshot({ path: "artifacts/map-expanded.png" });
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#map-toggle").getAttribute("aria-expanded"),
    "false",
  );
  await page.goto("http://127.0.0.1:4173/?dev-mode=false&health=999");
  assert.equal(new URL(page.url()).search, "");
  assert.ok(await page.locator(".telemetry").isHidden());
  assert.ok(await page.locator(".seed-bar").isHidden());
  assert.ok(await page.locator("#fps-corner").isVisible());
  await page.setViewportSize({ width: 390, height: 844 });
  for (const id of [
    "shop-open",
    "locker-open",
    "sound-toggle",
    "online",
    "play-public",
    "start-party",
  ]) {
    assert.ok(await page.locator("#" + id).isVisible());
    const box = await page.locator("#" + id).boundingBox();
    assert.ok(
      box.x >= 0 &&
        box.x + box.width <= 390 &&
        box.y >= 0 &&
        box.y + box.height <= 844,
    );
  }
  await page.locator("#sound-toggle").click();
  assert.equal(
    await page.locator("#sound-toggle").getAttribute("aria-pressed"),
    "true",
  );
  await page.screenshot({ path: "artifacts/start-mobile.png" });
  await page.locator("#play-public").click();
  await waitAsync(page,
    async () => (await import("/src/main.ts")).engine.started,
  );
  await waitAsync(page,
    async () => (await import("/src/main.ts")).engine.network.botCount === 29,
  );
  const ammo = await page.locator("#ammo-count").boundingBox();
  assert.ok(
    ammo.x >= 0 && ammo.x + ammo.width <= 390 && ammo.y + ammo.height <= 844,
  );
  assert.ok(
    await page
      .locator("#ammo-count")
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await page.screenshot({ path: "artifacts/game-mobile.png" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: restored HUD without intro title, custom seed/relief/density, clean URL with ignored parameters and reproducible in-app generation, random generation, desktop movement, aim/attack, weapon switching, pause/resume, seed reset, DPR, iPad three-touch input, touch release, responsive layouts; guided Create/Join onboarding, public matchmaking, 30-slot bot fill, solo companion bots, and two-browser parties with separate start, pause and party screens, shared generation, remote players, leave/rejoin controls; touch cancellation/gesture prevention/auto ammo with manual gun pickup, loss/victory screens, ten local item illustrations, owned-only locker, dev-mode gating, two-button start, visible mobile actions, expanded team map and audio mute, category filtering, mobile shop layout, shop purchases and localStorage restoration; no browser runtime errors.",
  );
} finally {
  await browser?.close();
  await server.close();
  await realtime.close();
}
