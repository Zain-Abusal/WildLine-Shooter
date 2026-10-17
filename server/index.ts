import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createAuthority, type Conn } from "../src/authority";

const bytes = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : data;

/** Dedicated Node host: the same authority behind an HTTP health check and `ws`. */
export function createGameServer(port = 8787, host = "0.0.0.0") {
  const authority = createAuthority();
  const http = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        rooms: authority.rooms.size,
        players: authority.clients.size,
      }),
    );
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 2048 });
  wss.on("connection", (ws) => {
    const conn: Conn = {
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      get buffered() {
        return ws.bufferedAmount;
      },
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      terminate: () => ws.terminate(),
      ping: () => ws.ping(),
    };
    const handlers = authority.connect(conn);
    ws.on("pong", handlers.pong);
    ws.on("message", (data, binary) =>
      handlers.message(binary ? bytes(data) : data.toString(), binary),
    );
    ws.on("error", () => {});
    ws.on("close", handlers.closed);
  });
  http.listen(port, host);
  return {
    http,
    wss,
    rooms: authority.rooms,
    close: async () => {
      authority.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT) || 8787;
  const server = createGameServer(port);
  const failed = (error: NodeJS.ErrnoException) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use — a multiplayer server is probably already running ` +
            `(check with: curl localhost:${port}). Stop it or set PORT=<other> npm run multiplayer.`
        : "Multiplayer server failed: " + error.message,
    );
    process.exit(1);
  };
  server.http.on("error", failed);
  server.wss.on("error", failed);
  server.http.on("listening", () =>
    console.log(
      "WILDLINE multiplayer listening on port " +
        (Number(process.env.PORT) || 8787),
    ),
  );
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
