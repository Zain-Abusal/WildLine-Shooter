import { GameEngine } from "./engine";
const canvas = document.getElementById("world") as HTMLCanvasElement;
canvas.tabIndex = 0;
const devMode = new URLSearchParams(location.search).get("dev-mode") === "true";
document.body.classList.toggle("dev-mode", devMode);
export const engine = new GameEngine(canvas);
// Only a diagnostics flag is accepted; gameplay query parameters are discarded.
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
