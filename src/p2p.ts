/**
 * Peer-to-peer hosted matches for static/serverless hosting (Vercel).
 *
 * The host's browser runs the authority in a Worker; other players connect to
 * it over WebRTC data channels. /api/signal (src/signal.ts) only exchanges the
 * one-time connection offers/answers. Both sides expose a minimal WebSocket-like
 * surface (Socketish) so src/network.ts is transport-agnostic.
 */
import type { FromWorker, ToWorker } from "./authority.worker";

export interface Socketish {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBufferView): void;
  close(): void;
}
const CONNECTING = 0,
  OPEN = 1,
  CLOSED = 3;

const SIGNAL_URL = "/api/signal";
/**
 * Public STUN lets browsers discover their public address. Strict networks may
 * also need a TURN relay, configured with VITE_TURN_URL/USERNAME/CREDENTIAL.
 */
function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const turn = import.meta.env.VITE_TURN_URL;
  if (turn)
    servers.push({
      urls: turn,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  return servers;
}

export class SignalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function signal<T = Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SignalError("Online play is unavailable right now.", 0);
  }
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok)
    throw new SignalError(
      data.error || "Online play is unavailable right now.",
      response.status,
    );
  return data;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function peerId(): string {
  const v = crypto.getRandomValues(new Uint32Array(2));
  return v[0].toString(36) + v[1].toString(36);
}
/** Non-trickle ICE: one offer/answer round trip carries every candidate. */
function gathered(pc: RTCPeerConnection, ms = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

export async function findPublicRoom(
  exclude: string[] = [],
  tier = 0,
): Promise<string | null> {
  const data = await signal<{ room: { code: string } | null }>({
    action: "find",
    exclude,
    tier,
  });
  return data.room?.code ?? null;
}

/** WebSocket-like wrapper around an RTCDataChannel (joiner side). */
class ChannelSocket implements Socketish {
  readyState = CONNECTING;
  private openHandler: (() => void) | null = null;
  /** connectRoom hands over an already-open socket; a late handler still fires once. */
  get onopen() {
    return this.openHandler;
  }
  set onopen(handler: (() => void) | null) {
    this.openHandler = handler;
    if (handler && this.readyState === OPEN) queueMicrotask(() => handler());
  }
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private channel: RTCDataChannel | null = null;
  private pc: RTCPeerConnection | null = null;
  get bufferedAmount() {
    return this.channel?.bufferedAmount ?? 0;
  }
  attach(pc: RTCPeerConnection, channel: RTCDataChannel) {
    this.pc = pc;
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.();
    };
    channel.onmessage = (e) => this.onmessage?.({ data: e.data });
    channel.onclose = () => this.fail(false);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        this.fail(this.readyState === CONNECTING);
    };
  }
  fail(error: boolean) {
    if (this.readyState === CLOSED) return;
    const wasConnecting = this.readyState === CONNECTING;
    this.readyState = CLOSED;
    if (error || wasConnecting) this.onerror?.();
    this.onclose?.();
    this.pc?.close();
  }
  send(data: string | ArrayBufferView) {
    if (this.readyState === OPEN && this.channel?.readyState === "open")
      this.channel.send(data as string);
  }
  close() {
    this.fail(false);
  }
}

/**
 * Resolves with an open connection to a hosted room, or rejects (404 when the
 * room is gone, otherwise a connection failure) so callers can try another.
 */
export function connectRoom(code: string, timeout = 12000): Promise<Socketish> {
  return new Promise((resolve, reject) => {
    const socket = joinRoom(code, (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new SignalError("The host did not answer.", 0));
    }, timeout);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new SignalError("Could not reach the host.", 0));
    };
  });
}
/** Connect to a hosted room by party code. */
export function joinRoom(
  code: string,
  failed?: (error: SignalError) => void,
): Socketish {
  const socket = new ChannelSocket();
  void (async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const channel = pc.createDataChannel("wildline", { ordered: true });
      socket.attach(pc, channel);
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const id = peerId();
      await signal({
        action: "offer",
        code,
        id,
        sdp: pc.localDescription!.sdp,
      });
      for (let attempt = 0; attempt < 20; attempt++) {
        if (socket.readyState === CLOSED) return;
        await delay(500);
        const { sdp } = await signal<{ sdp: string | null }>({
          action: "poll",
          code,
          id,
        });
        if (sdp) {
          await pc.setRemoteDescription({ type: "answer", sdp });
          return;
        }
      }
      socket.fail(true);
    } catch (error) {
      if (failed && error instanceof SignalError) failed(error);
      socket.fail(true);
    }
  })();
  return socket;
}

/** The host's own in-tab connection to its Worker authority. */
class LoopbackSocket implements Socketish {
  readyState = CONNECTING;
  bufferedAmount = 0;
  private openHandler: (() => void) | null = null;
  /** Opens before network.ts attaches handlers, so a late handler still fires once. */
  get onopen() {
    return this.openHandler;
  }
  set onopen(handler: (() => void) | null) {
    this.openHandler = handler;
    if (handler && this.readyState === OPEN) queueMicrotask(() => handler());
  }
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(private host: HostSession) {}
  send(data: string | ArrayBufferView) {
    if (this.readyState === OPEN) this.host.fromPeer(0, data);
  }
  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.host.stop();
    this.onclose?.();
  }
}

/**
 * Hosts a room: registers the code, runs the authority Worker, answers offers
 * and keeps the listing fresh. Stops when the host's loopback socket closes.
 */
export class HostSession {
  readonly local = new LoopbackSocket(this);
  private worker: Worker | null = null;
  private peers = new Map<
    number,
    { pc: RTCPeerConnection; channel: RTCDataChannel | null }
  >();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private humans = 1;
  private joinable = true;
  constructor(
    readonly code: string,
    private isPublic: boolean,
    private mode: string,
    private tier = 0,
    /** Listing secret; a migration successor reuses the previous host's token. */
    readonly token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  ) {}
  private lastOffer = 0;
  private listed = true;
  /**
   * Reserve the code and start serving. Throws SignalError (409 when taken).
   * restore: a migration backup (plus this client's map edits) to continue a match.
   */
  async start(restore?: { state: unknown; edits: unknown[] }): Promise<void> {
    await signal({
      action: "host",
      create: true,
      code: this.code,
      public: this.isPublic,
      mode: this.mode,
      humans: 1,
      tier: this.tier,
      token: this.token,
    });
    if (this.stopped) return;
    this.worker = new Worker(
      new URL("./authority.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.fromWorker(e.data);
    this.post({ t: "token", token: this.token });
    if (restore) this.post({ t: "restore", state: restore.state, edits: restore.edits });
    this.post({ t: "open", id: 0 });
    this.local.readyState = OPEN;
    addEventListener("pagehide", this.unload);
    let tick = 0;
    this.lastOffer = Date.now();
    this.timer = setInterval(() => {
      tick++;
      const recent = Date.now() - this.lastOffer < 60000;
      // Closed to joins (public match under way) and quiet for a minute: stop
      // polling and unlist, so a running public match costs no signaling at all.
      if (!this.joinable && !recent) {
        if (this.listed) {
          this.listed = false;
          void signal({ action: "close", code: this.code, token: this.token }).catch(() => {});
        }
        return;
      }
      // Poll quickly while players are arriving, then back off to save Redis commands.
      if (recent || tick % 3 === 0) void this.acceptOffers();
      if (tick % 12 === 0 || !this.listed) {
        this.listed = true;
        void this.refresh();
      }
    }, 1250);
  }
  private post(message: ToWorker) {
    this.worker?.postMessage(message);
  }
  fromPeer(id: number, data: string | ArrayBufferView) {
    if (typeof data === "string") {
      this.post({ t: "msg", id, data, binary: false });
      return;
    }
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.post({ t: "msg", id, data: copy.buffer, binary: true });
  }
  private fromWorker(m: FromWorker) {
    if (m.t === "status") {
      this.humans = m.humans;
      this.joinable = m.joinable;
      return;
    }
    if (m.id === 0) {
      if (m.t === "send") this.local.onmessage?.({ data: m.data });
      else this.local.close();
      return;
    }
    const peer = this.peers.get(m.id);
    if (!peer) return;
    if (m.t === "send") {
      if (peer.channel?.readyState === "open" && peer.channel.bufferedAmount < 262144)
        peer.channel.send(m.data);
    } else this.dropPeer(m.id, false);
  }
  private refresh() {
    return signal({
      action: "host",
      code: this.code,
      public: this.isPublic,
      mode: this.mode,
      humans: this.humans,
      joinable: this.joinable,
      tier: this.tier,
      token: this.token,
    }).catch(() => {});
  }
  private async acceptOffers() {
    if (this.stopped) return;
    let offers: { id: string; sdp: string }[] = [];
    try {
      offers = (
        await signal<{ offers: { id: string; sdp: string }[] }>({
          action: "offers",
          code: this.code,
        })
      ).offers;
    } catch {
      return;
    }
    if (offers.length) this.lastOffer = Date.now();
    for (const offer of offers) void this.answer(offer);
  }
  private async answer(offer: { id: string; sdp: string }) {
    if (this.stopped || this.peers.size >= 29) return;
    const id = this.nextId++;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const peer = { pc, channel: null as RTCDataChannel | null };
    this.peers.set(id, peer);
    pc.ondatachannel = (event) => {
      const channel = (peer.channel = event.channel);
      channel.binaryType = "arraybuffer";
      channel.onopen = () => this.post({ t: "open", id });
      channel.onmessage = (e) =>
        this.fromPeer(
          id,
          typeof e.data === "string" ? e.data : new Uint8Array(e.data),
        );
      channel.onclose = () => this.dropPeer(id, true);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed")
        this.dropPeer(id, true);
    };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      await signal({
        action: "answer",
        code: this.code,
        id: offer.id,
        sdp: pc.localDescription!.sdp,
      });
    } catch {
      this.dropPeer(id, true);
    }
  }
  private dropPeer(id: number, notifyWorker: boolean) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    if (notifyWorker) this.post({ t: "close", id });
    peer.channel?.close();
    peer.pc.close();
  }
  /** Closing the tab unregisters the listing immediately instead of waiting for expiry. */
  private unload = () => {
    navigator.sendBeacon?.(
      SIGNAL_URL,
      JSON.stringify({ action: "close", code: this.code, token: this.token }),
    );
    // Close channels now so peers start host migration immediately.
    this.stop();
  };
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    removeEventListener("pagehide", this.unload);
    clearInterval(this.timer);
    for (const id of [...this.peers.keys()]) this.dropPeer(id, false);
    this.worker?.terminate();
    this.worker = null;
    void signal({ action: "close", code: this.code, token: this.token }).catch(() => {});
    if (this.local.readyState !== CLOSED) this.local.close();
  }
}
