import { GameEngine } from "./engine";
const canvas = document.getElementById("world") as HTMLCanvasElement;
canvas.tabIndex = 0;
const params = new URLSearchParams(location.search);
const devMode = params.get("dev-mode") === "true";
// Developer tools: hidden behind this flag, the L key and a password (src/god.ts).
const godMode = params.get("god-mode") === "zrax";
document.body.classList.toggle("dev-mode", devMode);
export const engine = new GameEngine(canvas);
if (godMode) engine.enableGod();
// Only the diagnostics flag stays in the URL; every other parameter (including god-mode) is removed.
if (location.search)
  history.replaceState(
    null,
    "",
    location.pathname + (devMode ? "?dev-mode=true" : "") + location.hash,
  );
engine.reset("wildline");
engine.start();
// Explicit teardown for Vite hot reload, so only one animation loop owns the canvas.
if (import.meta.hot) import.meta.hot.dispose(() => engine.stop());
