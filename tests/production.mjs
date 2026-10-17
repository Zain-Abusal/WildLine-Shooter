import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";
const server = await preview({
  preview: { host: "127.0.0.1", port: 4181, strictPort: true },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  });
  await context.addInitScript(() => {
    const Native = window.AudioContext;
    window.__voiceCount = 0;
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        window.__audio = this;
      }
      createOscillator() {
        window.__voiceCount++;
        return super.createOscillator();
      }
    };
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4181/?health=999");
  assert.equal(new URL(page.url()).search, "");
  assert.ok(await page.locator(".telemetry").isHidden());
  assert.equal(await page.locator(".start-actions button:visible").count(), 2);
  await page.locator("#play-public").tap();
  await page.waitForFunction(() => document.body.classList.contains("playing"));
  assert.match(
    await page.locator("#multiplayer-status").textContent(),
    /BOT PRACTICE/,
  );
  assert.equal(await page.locator("#start-screen").isVisible(), false);
  const ammo = await page.locator("#ammo-panel").boundingBox(),
    fullscreen = await page.locator("#fullscreen").boundingBox();
  assert.ok(ammo.x + ammo.width <= 390 && ammo.y + ammo.height <= 844);
  assert.ok(
    fullscreen.x + fullscreen.width <= ammo.x ||
      fullscreen.y + fullscreen.height <= ammo.y ||
      fullscreen.y >= ammo.y + ammo.height,
  );
  const headerButtons = [];
  for (const id of [
    "shop-open",
    "locker-open",
    "sound-toggle",
    "online",
    "fullscreen",
    "pause",
  ])
    headerButtons.push({ id, ...(await page.locator("#" + id).boundingBox()) });
  for (let i = 0; i < headerButtons.length; i++)
    for (let j = i + 1; j < headerButtons.length; j++) {
      const a = headerButtons[i],
        b = headerButtons[j];
      assert.ok(
        a.x + a.width <= b.x + 1 ||
          b.x + b.width <= a.x + 1 ||
          a.y + a.height <= b.y + 1 ||
          b.y + b.height <= a.y + 1,
        a.id + " overlaps " + b.id,
      );
    }
  // Fixed bank: 6 tone voices + gust LFO + bird + storm rumble (src/audio.ts).
  assert.equal(await page.evaluate(() => window.__voiceCount), 9);
  const attack = await page.locator("#attack").boundingBox();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      {
        x: attack.x + attack.width / 2,
        y: attack.y + attack.height / 2,
        id: 1,
      },
    ],
  });
  await page.waitForTimeout(200);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  assert.equal(
    await page.evaluate(() => window.__voiceCount),
    9,
    "firing reuses the audio voice bank",
  );
  assert.equal(await page.evaluate(() => window.__audio.state), "running");
  await page.locator("#sound-toggle").tap();
  assert.equal(
    await page.locator("#sound-toggle").getAttribute("aria-pressed"),
    "true",
  );
  await page.screenshot({ path: "artifacts/production-touch.png" });
  await page.locator("#map-toggle").tap();
  assert.equal(
    await page.locator("#map-toggle").getAttribute("aria-expanded"),
    "true",
  );
  await page.locator("#map-toggle").tap();
  assert.equal(
    await page.locator("#map-toggle").getAttribute("aria-expanded"),
    "false",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: production static build, public-to-offline bot fallback, touch play, non-overlapping ammo/fullscreen, fixed reusable audio bank (9 oscillators + noise voices), mute and expandable map.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.httpServer.close((e) => (e ? reject(e) : resolve())),
  );
}
