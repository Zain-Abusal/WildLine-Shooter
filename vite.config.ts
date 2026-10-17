import { defineConfig, type Plugin } from "vite";
import { handleSignal, MemoryStore } from "./src/signal";

/**
 * Serves /api/signal from memory during `npm run dev`, mirroring the Vercel
 * Function in api/signal.ts so hosted peer-to-peer matches work locally.
 * `vite preview` deliberately has no signaling (it models a static-only host).
 */
function devSignal(): Plugin {
  const store = new MemoryStore();
  return {
    name: "wildline-dev-signal",
    configureServer(server) {
      server.middlewares.use("/api/signal", (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET") {
          reply(200, { status: "ok", store: "memory" });
          return;
        }
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 65536) req.destroy();
        });
        req.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            reply(400, { error: "Invalid JSON." });
            return;
          }
          void handleSignal(store, body).then((result) =>
            reply(result.status, result.body),
          );
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [devSignal()],
});
