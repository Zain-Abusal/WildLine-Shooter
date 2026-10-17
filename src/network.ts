import { finiteValue, roundOutcome } from "./session";
import { SKINS } from "./profile";
import {
  FIREARM_MASK,
  WEAPONS,
  validWeapon,
  firstWeapon,
  STORM_START_RADIUS,
  BR_START_RADIUS,
  UNARMED,
} from "./combat";
import {
  MAX_PARTICIPANTS,
  type GameMode,
  validMode,
  soloMode,
  respawnMode,
  baseX,
} from "./match";
import { Pool } from "./entities";
import type { Socketish } from "./p2p";
export type Welcome = {
  t: "welcome";
  id: number;
  team: number;
  public: boolean;
  infiniteAmmo: boolean;
  weapons: number;
  room: string;
  seed: string;
  relief: number;
  density: number;
  x: number;
  y: number;
  round: number;
  host: boolean;
  bots?: boolean;
  botDifficulty?: number;
  weapon: number;
  edits: { x: number; y: number; i: number; hp: number }[];
};
export class Multiplayer {
  readonly peers = new Pool(MAX_PARTICIPANTS);
  readonly ids = new Int32Array(MAX_PARTICIPANTS);
  readonly targetsX = new Float64Array(MAX_PARTICIPANTS);
  readonly targetsY = new Float64Array(MAX_PARTICIPANTS);
  readonly names: string[] = Array(MAX_PARTICIPANTS).fill("");
  private seen = new Uint8Array(MAX_PARTICIPANTS);
  private socket: Socketish | null = null;
  private packet = new Float64Array(4);
  private clock = 0;
  private entered = false;
  private joinTimer: ReturnType<typeof setTimeout> | undefined;
  host = false;
  round = 0;
  supportsRounds = false;
  connecting = false;
  readonly scores = new Uint16Array(MAX_PARTICIPANTS);
  private lastElimination = 0;
  onElimination: (
    killer: string,
    victim: string,
    weapon: number,
    local: boolean,
    x: number,
    y: number,
  ) => void = () => {};
  readonly outfits = new Uint8Array(MAX_PARTICIPANTS);
  readonly weapons = new Uint8Array(MAX_PARTICIPANTS);
  mode: GameMode = "teams";
  winnerId = 0;
  /** Matchmaking bracket sent with join requests (device games played). */
  tier = 0;
  /** Host migration (browser-hosted rooms only). */
  p2p = false;
  migrating = false;
  resumeToken = "";
  backup: Record<string, unknown> | null = null;
  backupAt = 0;
  private joinPayload: Record<string, unknown> = {};
  onHostLost: () => void = () => {};
  /** This client holds a fresh authority backup, so it should take over hosting. */
  get successor(): boolean {
    return !!this.backup && Date.now() - this.backupAt < 3000;
  }
  /** CTF state: flag positions, carrier IDs (0 = none), home flags and captures per team. */
  readonly flagX = new Float64Array(2);
  readonly flagY = new Float64Array(2);
  readonly flagCarrier = new Int32Array(2);
  readonly flagHome = new Uint8Array(2);
  readonly captures = new Uint8Array(2);
  onCapture: (team: number, name: string) => void = () => {};
  readonly teams = new Uint8Array(MAX_PARTICIPANTS);
  readonly bots = new Uint8Array(MAX_PARTICIPANTS);
  readonly concealed = new Uint8Array(MAX_PARTICIPANTS);
  readonly loot = new Pool(96);
  gun = 0;
  magazine = 24;
  reserve = 72;
  reloading = 0;
  kills = 0;
  playersLeft = 30;
  radius = STORM_START_RADIUS;
  elapsed = 0;
  infiniteAmmo = false;
  allowedWeapons = FIREARM_MASK;
  result = "";
  team = 0;
  humanCount = 0;
  botCount = 0;
  public = false;
  id = 0;
  connected = false;
  health = 100;
  serverX = 0;
  serverY = 0;
  supplies = 0;
  room = "";
  onWelcome: (data: Welcome) => void = () => {};
  onEdit: (x: number, y: number, i: number, hp: number) => void = () => {};
  onShot: (x: number, y: number, angle: number, weapon: number) => void =
    () => {};
  onStatus: (text: string) => void = () => {};
  onPosition: (x: number, y: number) => void = () => {};
  onLeave: () => void = () => {};
  onHit: () => void = () => {};
  onKill: (count: number) => void = () => {};
  onResult: (result: string) => void = () => {};
  /** Peers on the local side; solo modes have no allies. */
  ally(n: number): boolean {
    return !soloMode(this.mode) && this.teams[n] === this.team;
  }
  /**
   * Public team/BR rounds end locally on elimination. Private rooms keep the
   * player spectating, and respawn modes bring them back, until a winner exists.
   */
  get eliminationFinal(): boolean {
    return this.public && !respawnMode(this.mode);
  }
  private resetFlags(): void {
    for (let t = 0; t < 2; t++) {
      this.flagX[t] = baseX(t);
      this.flagY[t] = 0;
      this.flagCarrier[t] = 0;
      this.flagHome[t] = 1;
    }
  }
  connect(
    url: string,
    room: string,
    name: string,
    seed: string,
    relief: number,
    density: number,
    create = false,
    isPublic = false,
    matchmaking = false,
    loadout = 0,
    infiniteAmmo = false,
    weapons = FIREARM_MASK,
    skin = 0,
    excludeRoom = "",
    bots = true,
    botDifficulty = 1,
    mode: GameMode = "teams",
    /** Peer-to-peer transport (src/p2p.ts); omitted for a dedicated ws server. */
    transport: (() => Socketish) | null = null,
  ): void {
    this.disconnect(false);
    if (!transport) {
      if (!/^wss?:$/.test(new URL(url).protocol))
        throw new Error("Use a ws:// or wss:// server URL.");
      if (location.protocol === "https:" && !url.startsWith("wss:"))
        throw new Error("HTTPS requires a secure wss:// multiplayer server.");
    }
    this.p2p = !!transport;
    this.joinPayload = {
      t: "join",
      room,
      name,
      seed,
      relief,
      density,
      create,
      public: isPublic,
      matchmaking,
      loadout,
      infiniteAmmo,
      weapons,
      skin,
      excludeRoom,
      bots,
      botDifficulty,
      mode,
      tier: this.tier,
    };
    this.wire(
      transport ? transport() : (new WebSocket(url) as unknown as Socketish),
      this.joinPayload,
      !!transport,
    );
  }
  /**
   * Browser-hosted rooms: after the host's tab closes, reconnect to the same
   * code (the successor now hosts it) and reclaim this player with the resume
   * token. Kills, health and the world stay as they were.
   */
  resume(transport: () => Socketish): void {
    this.wire(
      transport(),
      {
        ...this.joinPayload,
        create: false,
        matchmaking: false,
        resume: this.resumeToken,
      },
      true,
    );
  }
  private wire(
    socket: Socketish,
    payload: Record<string, unknown>,
    p2p: boolean,
  ): void {
    this.socket = socket;
    this.connecting = true;
    this.onStatus(this.migrating ? "Reconnecting to the new host…" : "Connecting…");
    const timeout = (this.joinTimer = setTimeout(() => {
      if ((!this.connected || this.migrating) && this.socket === socket) {
        const wasMigrating = this.migrating;
        this.disconnect(wasMigrating);
        this.onStatus("Connection timed out. Please try joining again.");
      }
    }, p2p ? 20000 : 6000));
    socket.onopen = () => socket.send(JSON.stringify(payload));
    socket.onmessage = (e) => {
      if (this.socket !== socket) return;
      let data;
      try {
        data = JSON.parse(e.data as string);
      } catch {
        this.onStatus("Online play is unavailable right now.");
        return;
      }
      if (!data || typeof data.t !== "string") return;
      if (data.t === "welcome") {
        if (
          typeof data.seed !== "string" ||
          typeof data.room !== "string" ||
          !Number.isFinite(data.id)
        ) {
          this.disconnect(false);
          this.onStatus(
            "This match sent an incomplete welcome. Please try again.",
          );
          return;
        }
        clearTimeout(timeout);
        this.joinTimer = undefined;
        this.connecting = false;
        if (data.resumed === true && this.migrating) {
          // Same match on a new host: keep kills, entry state and the world.
          this.migrating = false;
          this.id = data.id;
          this.host = data.host === true;
          this.onWelcome(data);
          this.onStatus("Match moved to a new host · " + data.room);
          return;
        }
        this.resumeToken = typeof data.resume === "string" ? data.resume : "";
        this.backup = null;
        this.entered = false;
        data.relief = [0, 1, 1.9].includes(data.relief) ? data.relief : 1;
        data.density = [0, 0.04, 0.12].includes(data.density)
          ? data.density
          : 0.04;
        data.x = finiteValue(data.x, 0, -1e8, 1e8);
        data.y = finiteValue(data.y, 0, -1e8, 1e8);
        data.edits = Array.isArray(data.edits)
          ? data.edits
              .slice(0, 8192)
              .filter(
                (e: any) =>
                  e &&
                  Number.isInteger(e.x) &&
                  Number.isInteger(e.y) &&
                  Number.isInteger(e.i) &&
                  e.i >= 0 &&
                  e.i < 24 &&
                  Number.isFinite(e.hp),
              )
          : [];
        data.weapons = Number.isInteger(data.weapons)
          ? data.weapons & FIREARM_MASK || 1
          : FIREARM_MASK;
        data.weapon =
          validMode(data.mode) === "br" && data.weapon === UNARMED
            ? UNARMED
            : validWeapon(data.weapon) && data.weapons & (1 << data.weapon)
              ? data.weapon
              : firstWeapon(data.weapons);
        this.gun = data.weapon;
        this.magazine = WEAPONS[this.gun].magazine;
        this.reserve = WEAPONS[this.gun].reserve;
        this.reloading = 0;
        this.peers.clear();
        this.loot.clear();
        this.clock = 0;
        this.lastElimination = 0;
        this.scores.fill(0);
        this.supportsRounds = Number.isInteger(data.round);
        this.round = finiteValue(data.round, 1, 1);
        this.host = data.host === true;
        this.connected = true;
        this.id = data.id;
        this.team = data.team === 1 ? 1 : 0;
        this.mode = validMode(data.mode);
        this.winnerId = 0;
        this.captures.fill(0);
        this.resetFlags();
        this.infiniteAmmo = data.infiniteAmmo === true;
        this.allowedWeapons = data.weapons;
        this.result = "";
        this.kills = 0;
        this.public = data.public === true;
        this.room = data.room;
        this.health = 100;
        this.radius =
          validMode(data.mode) === "br" ? BR_START_RADIUS : STORM_START_RADIUS;
        this.elapsed = 0;
        this.playersLeft = data.bots === false ? 1 : 30;
        data.botDifficulty = [0.65, 1, 1.35].includes(data.botDifficulty)
          ? data.botDifficulty
          : 1;
        this.serverX = data.x;
        this.serverY = data.y;
        this.supplies = 0;
        this.onWelcome(data);
        this.onStatus("Party " + data.room + " · connected");
      }
      if (
        data.t === "state" &&
        Array.isArray(data.players) &&
        data.players.length <= MAX_PARTICIPANTS
      ) {
        this.radius = finiteValue(data.radius, this.radius, 0, BR_START_RADIUS);
        this.elapsed = finiteValue(data.elapsed, this.elapsed);
        if (data.mode !== undefined) this.mode = validMode(data.mode);
        this.winnerId = Number.isInteger(data.winnerId) ? data.winnerId : 0;
        if (Array.isArray(data.captures))
          for (let t = 0; t < 2; t++)
            this.captures[t] = finiteValue(data.captures[t], 0, 0, 99);
        if (Array.isArray(data.flags))
          for (let t = 0; t < 2; t++) {
            const f = data.flags[t];
            if (!f) continue;
            this.flagX[t] = finiteValue(f.x, baseX(t), -1e8, 1e8);
            this.flagY[t] = finiteValue(f.y, 0, -1e8, 1e8);
            this.flagCarrier[t] = Number.isInteger(f.carrier) ? f.carrier : 0;
            this.flagHome[t] = f.home === false ? 0 : 1;
          }
        this.playersLeft = finiteValue(
          data.playersLeft,
          this.playersLeft,
          0,
          30,
        );
        if (Number.isInteger(data.hostId)) this.host = data.hostId === this.id;
        this.loot.clear();
        for (const item of Array.isArray(data.loots)
          ? data.loots.slice(0, 96)
          : []) {
          if (
            !item ||
            !Number.isFinite(item.x) ||
            !Number.isFinite(item.y) ||
            !validWeapon(item.weapon)
          )
            continue;
          this.loot.spawn(
            item.x,
            item.y,
            finiteValue(item.ammo, 0, 0, 240),
            // vy: 1 gun, 2 medkit, 0 ammo only.
            item.gun ? 1 : finiteValue(item.heal, 0) > 0 ? 2 : 0,
            1,
            item.weapon,
          );
        }
        this.seen.fill(0);
        let total = 0;
        this.humanCount = 0;
        this.botCount = 0;
        for (const p of data.players) {
          if (
            !p ||
            !Number.isInteger(p.id) ||
            !Number.isFinite(p.x) ||
            !Number.isFinite(p.y)
          )
            continue;
          p.health = finiteValue(
            p.health,
            p.id === this.id ? this.health : 100,
            0,
            100,
          );
          p.angle = finiteValue(p.angle, 0, -1e8, 1e8);
          total++;
          if (p.bot) this.botCount++;
          else this.humanCount++;
          if (p.id === this.id) {
            const respawn = this.health === 0 && p.health > 0;
            this.serverX = p.x;
            this.serverY = p.y;
            this.health = p.health;
            this.gun =
              validWeapon(p.weapon) || p.weapon === UNARMED ? p.weapon : this.gun;
            this.magazine = finiteValue(
              p.magazine,
              this.magazine,
              0,
              WEAPONS[this.gun].magazine,
            );
            this.reserve = finiteValue(p.reserve, this.reserve, 0, 240);
            this.reloading = finiteValue(p.reloading, 0, 0, 10);
            const kills = Math.max(
              this.kills,
              Math.floor(finiteValue(p.kills, this.kills)),
            );
            if (kills > this.kills) this.onKill(kills - this.kills);
            this.kills = kills;
            const result = roundOutcome(
              this.entered && p.ready !== false,
              this.health,
              data.winner,
              this.team,
              data.winnerId,
              this.id,
              this.eliminationFinal,
            );
            if (result && !this.result) {
              this.result = result;
              this.onResult(result);
            }
            this.supplies = finiteValue(p.supplies, this.supplies);
            if (respawn) this.onPosition(p.x, p.y);
            continue;
          }
          let n = -1;
          for (let k = 0; k < MAX_PARTICIPANTS; k++)
            if (this.peers.active[k] && this.ids[k] === p.id) {
              n = k;
              break;
            }
          if (n < 0)
            n = this.peers.spawn(
              p.x,
              p.y,
              p.angle,
              0,
              p.ready === false ? 0 : p.health,
            );
          if (n >= 0) {
            this.seen[n] = 1;
            this.ids[n] = p.id;
            this.names[n] =
              typeof p.name === "string" ? p.name.slice(0, 32) : "Player";
            this.teams[n] = p.team === 1 ? 1 : 0;
            this.outfits[n] =
              Number.isInteger(p.skin) && p.skin >= 0 && p.skin < SKINS.length
                ? p.skin
                : 0;
            this.weapons[n] =
              validWeapon(p.weapon) || p.weapon === UNARMED ? p.weapon : 0;
            this.concealed[n] = p.hidden ? 1 : 0;
            this.bots[n] = p.bot ? 1 : 0;
            this.scores[n] = Math.floor(finiteValue(p.kills, 0, 0, 65535));
            this.targetsX[n] = p.x;
            this.targetsY[n] = p.y;
            this.peers.vx[n] = p.angle;
            this.peers.life[n] = p.ready === false ? 0 : p.health;
          }
        }
        for (let k = 0; k < MAX_PARTICIPANTS; k++)
          if (this.peers.active[k] && !this.seen[k]) this.peers.release(k);
        this.onStatus(
          (this.public ? "PUBLIC" : "PARTY") + " · " + total + "/30 PLAYERS",
        );
      }
      if (
        data.t === "shot" &&
        data.id !== this.id &&
        (data.weapon === 1 || validWeapon(data.weapon)) &&
        Number.isFinite(data.x) &&
        Number.isFinite(data.y) &&
        Number.isFinite(data.angle)
      )
        this.onShot(data.x, data.y, data.angle, data.weapon);
      if (
        data.t === "elimination" &&
        Number.isInteger(data.serial) &&
        data.serial > this.lastElimination
      ) {
        this.lastElimination = data.serial;
        const local = data.killerId === this.id;
        const kills = Math.floor(finiteValue(data.kills, this.kills));
        if (local && kills > this.kills) {
          this.onKill(kills - this.kills);
          this.kills = kills;
        }
        this.onElimination(
          typeof data.killer === "string" ? data.killer.slice(0, 32) : "Storm",
          typeof data.victim === "string"
            ? data.victim.slice(0, 32)
            : "Fighter",
          data.weapon === 1 || validWeapon(data.weapon) ? data.weapon : 0,
          local,
          finiteValue(data.x, NaN, -1e8, 1e8),
          finiteValue(data.y, NaN, -1e8, 1e8),
        );
      }
      if (data.t === "hit") this.onHit();
      // Successor only: latest authority state for host migration.
      if (data.t === "backup" && data.state && typeof data.state === "object") {
        this.backup = data.state;
        this.backupAt = Date.now();
      }
      if (data.t === "capture" && (data.team === 0 || data.team === 1)) {
        if (Array.isArray(data.captures))
          for (let t = 0; t < 2; t++)
            this.captures[t] = finiteValue(data.captures[t], 0, 0, 99);
        this.onCapture(
          data.team,
          typeof data.name === "string" ? data.name.slice(0, 32) : "Fighter",
        );
      }
      if (
        data.t === "edit" &&
        Number.isInteger(data.x) &&
        Number.isInteger(data.y) &&
        Number.isInteger(data.i) &&
        data.i >= 0 &&
        data.i < 24 &&
        Number.isFinite(data.hp)
      )
        this.onEdit(data.x, data.y, data.i, data.hp);
      if (data.t === "error") {
        if (!this.connected) this.disconnect(false);
        this.onStatus(
          typeof data.message === "string"
            ? data.message
            : "Could not join this match. Please try again.",
        );
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      if (!this.connected) this.disconnect(false);
      this.onStatus(
        "Online play is unavailable right now. Please try again shortly.",
      );
    };
    socket.onclose = () => {
      clearTimeout(timeout);
      if (this.socket !== socket) return;
      this.socket = null;
      this.connecting = false;
      if (this.connected && this.p2p && !this.migrating && this.resumeToken) {
        // The host's tab went away: keep the match on screen while it moves.
        this.migrating = true;
        this.onHostLost();
        return;
      }
      this.entered = false;
      const wasConnected = this.connected;
      this.connected = false;
      this.peers.clear();
      this.onStatus("Disconnected · solo mode");
      if (wasConnected) this.onLeave();
    };
  }
  /** Bumped by every disconnect so async P2P setup can detect cancellation. */
  generation = 0;
  disconnect(notify = true): void {
    this.generation++;
    this.migrating = false;
    this.backup = null;
    clearTimeout(this.joinTimer);
    this.joinTimer = undefined;
    this.connecting = false;
    this.entered = false;
    const socket = this.socket;
    this.socket = null;
    const wasConnected = this.connected;
    this.connected = false;
    this.peers.clear();
    this.loot.clear();
    this.room = "";
    this.host = false;
    this.result = "";
    socket?.close();
    if (wasConnected && notify) {
      this.onLeave();
      this.onStatus("Party left · solo mode");
    }
  }
  private send(type: number, a = 0, b = 0, c = 0): void {
    if (
      !this.connected ||
      this.socket?.readyState !== 1 ||
      this.socket.bufferedAmount > 4096
    )
      return;
    this.packet[0] = type;
    this.packet[1] = a;
    this.packet[2] = b;
    this.packet[3] = c;
    this.socket.send(this.packet);
  }
  update(dt: number, x: number, y: number, angle: number): void {
    for (let n = 0; n < MAX_PARTICIPANTS; n++)
      if (this.peers.active[n]) {
        const ease = 1 - Math.exp(-15 * dt);
        this.peers.x[n] += (this.targetsX[n] - this.peers.x[n]) * ease;
        this.peers.y[n] += (this.targetsY[n] - this.peers.y[n]) * ease;
      }
    this.clock += dt;
    if (this.clock >= 0.05) {
      this.clock = 0;
      this.send(1, x, y, angle);
    }
  }
  attack(angle: number, weapon: number): void {
    this.send(2, angle, weapon);
  }
  /** auto: periodic touch collection (caches/medkits only, never guns). */
  collect(auto = false): void {
    this.send(4, auto ? 1 : 0);
  }
  reload(): void {
    this.send(7);
  }
  restartRound(): void {
    this.send(8);
  }
  enterMatch(): void {
    this.entered = true;
    this.send(5);
  }
  respawn(): void {
    this.send(3);
  }
}
