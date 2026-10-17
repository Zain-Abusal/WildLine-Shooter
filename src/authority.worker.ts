/// <reference lib="webworker" />
/**
 * Runs the match authority inside the hosting player's browser. A Worker keeps
 * the 10 Hz simulation and 20 Hz snapshots off the render thread and is not
 * subject to the heavy timer throttling applied to background tab main threads.
 * The main thread (src/p2p.ts) bridges WebRTC data channels and the host's own
 * loopback connection to it.
 */
import { createAuthority, type Conn, type ConnHandlers } from "./authority";

export type ToWorker =
  | { t: "token"; token: string }
  | { t: "restore"; state: unknown; edits: unknown[] }
  | { t: "open"; id: number }
  | { t: "msg"; id: number; data: string | ArrayBuffer; binary: boolean }
  | { t: "close"; id: number };
export type FromWorker =
  | { t: "send"; id: number; data: string }
  | { t: "close"; id: number }
  | { t: "status"; humans: number; joinable: boolean; mode: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const authority = createAuthority({ backups: true });
const conns = new Map<number, { handlers: ConnHandlers; state: { open: boolean } }>();
const post = (message: FromWorker) => scope.postMessage(message);

scope.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  if (m.t === "token") {
    authority.setBackupToken(m.token);
    return;
  }
  if (m.t === "restore") {
    try {
      authority.restore(
        m.state as Parameters<typeof authority.restore>[0],
        m.edits as Parameters<typeof authority.restore>[1],
      );
    } catch {
      // A malformed backup simply means no migration; the loopback join will fail cleanly.
    }
    return;
  }
  if (m.t === "open") {
    const state = { open: true };
    const shut = () => {
      if (!state.open) return;
      state.open = false;
      post({ t: "close", id: m.id });
    };
    const conn: Conn = {
      // Connection 0 is the hosting browser's own player.
      local: m.id === 0,
      get open() {
        return state.open;
      },
      buffered: 0,
      send: (data) => {
        if (state.open) post({ t: "send", id: m.id, data });
      },
      close: shut,
      terminate: shut,
    };
    conns.set(m.id, { handlers: authority.connect(conn), state });
  } else if (m.t === "msg") {
    const entry = conns.get(m.id);
    if (!entry) return;
    entry.handlers.message(
      typeof m.data === "string" ? m.data : new Uint8Array(m.data),
      m.binary,
    );
  } else if (m.t === "close") {
    const entry = conns.get(m.id);
    if (!entry) return;
    entry.state.open = false;
    entry.handlers.closed();
    conns.delete(m.id);
  }
};

// Listing refresh for public matchmaking: humans present and whether joining is still allowed.
setInterval(() => {
  const now = Date.now();
  for (const room of authority.rooms.values()) {
    post({
      t: "status",
      humans: room.players.size,
      mode: room.mode,
      joinable:
        room.winner === -1 &&
        room.players.size < 30 &&
        (!room.public || !room.startedAt || now - room.startedAt < 30000),
    });
    break;
  }
}, 2000);
