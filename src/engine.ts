import {
  World,
  CHUNK,
  CELLS,
  TILE,
  hash,
  terrainHeight,
  trailX,
  biomeAt,
  terrainIndex,
  BIOME_SNOW,
  BIOME_DESERT,
  STRUCTURE,
  STRUCTURE_RADIUS,
  MEDKIT,
  blockedSpot,
  Chunk,
} from "./world";
import { Player, Pool, movementSpeed } from "./entities";
import { freshSeed, finiteValue } from "./session";
import {
  FIREARM_IDS,
  WEAPON_ASSETS,
  WEAPON_TAGS,
  WEAPON_RARITY,
  WEAPONS,
  stormRadius,
  stormDamage,
  axeReach,
  ASSIST_CREDIT_SECONDS,
  KILL_POINTS,
  pointCoins,
  STORM_START_RADIUS,
  BR_START_RADIUS,
  BR_HOLD,
  UNARMED,
  MEDKIT_HEAL,
  CHEST_MEDKIT_CHANCE,
  MEDKIT_DROP_CHANCE,
  chestWeapon,
  chestAmmo,
  stormEnd,
} from "./combat";
import {
  loadProfile,
  SKINS,
  SKIN_ASSETS,
  TIERS,
  KILL_EFFECTS,
  DANCES,
} from "./profile";
import { Multiplayer } from "./network";
import { playerName, randomPlayerName } from "./names";
import {
  HostSession,
  SignalError,
  findPublicRoom,
  connectRoom,
  type Socketish,
} from "./p2p";
import {
  type GameMode,
  validMode,
  respawnMode,
  baseX,
  timeLimit,
  FFA_KILL_TARGET,
  CTF_CAPTURE_TARGET,
  MODE_LABELS,
} from "./match";
import { Sound, Sfx } from "./audio";
import { GodMode } from "./god";
import { Input } from "./input";
import { GroundCache, PropSprites, TERRAIN } from "./landscape";
const TREE = ["#3e6543", "#345b3c", "#4f7546"];
const MEDKIT_LABEL = "+" + MEDKIT_HEAL;
const $ = (id: string) => document.getElementById(id)!;
class Fighters extends Pool {
  homeX = new Int32Array(this.capacity);
  homeY = new Int32Array(this.capacity);
  object = new Uint8Array(this.capacity);
  gun = new Uint8Array(this.capacity);
  kills = new Uint8Array(this.capacity);
  skin = new Uint8Array(this.capacity);
  /** Match time of the local player's last hit; drives assist kill credit. */
  hitAt = new Float32Array(this.capacity).fill(-1e9);
  hitWeapon = new Uint8Array(this.capacity);
  /** Seconds left of walk animation / hit flash (render only). */
  walk = new Float32Array(this.capacity);
  flash = new Float32Array(this.capacity);
}
/** Damage-number labels precomputed so rendering never formats strings. */
const DAMAGE_TEXT = Array.from({ length: 201 }, (_, i) => String(i));
/** Held-gun silhouette per weapon ID: length, thickness and body colour. */
const GUN_LENGTH = [23, 0, 19, 34, 16, 29, 11, 26];
const GUN_WIDTH = [6, 0, 8, 5, 7, 5, 5, 7];
const GUN_COLOR = [
  "#263b32",
  "#263b32",
  "#6b4a32",
  "#2f3b46",
  "#3a3a3a",
  "#36402f",
  "#4a4f52",
  "#1f2a2c",
];
export class GameEngine {
  readonly player = new Player();
  readonly world = new World("wildline");
  readonly projectiles = new Pool(160);
  readonly particles = new Pool(384);
  readonly enemies = new Fighters(26);
  private ground = new GroundCache(this.world.capacity);
  private props = new PropSprites(
    (c, x, y, r) => this.drawTree(c, x, y, r),
    (c, x, y) => this.drawRock(c, x, y),
  );
  readonly loot = new Pool(96);
  readonly profile = loadProfile();
  private matchTime = 0;
  private outfit = 0;
  private matchFinished = false;
  private enemySpawned = 0;
  private autoClock = 0;
  private shopWasPaused = false;
  private shopFilter = "all";
  private lockerMode = false;
  private mapExpanded = false;
  private mapTerrain = document.createElement("canvas");
  private mapTerrainSeed = -1;
  private mapTerrainZoom = 0;
  private mapTerrainRelief = -1;
  private muzzle = 0;
  private hitMarker = 0;
  private previousHealth = 100;
  readonly sound = new Sound();
  private quickPublic = false;
  /** Set by public matchmaking from the Party menu: enter as soon as connected. */
  private autoEnter = false;
  private joinedRoom = "";
  private joinedRound = 0;
  private lastPublicRoom = "";
  private localBots = true;
  private botDifficulty = 1;
  /** Offline practice supports Team Battle and solo Battle Royale (no allies). */
  private practiceMode: GameMode = "teams";
  /** Remote slot followed while spectating a private round; -1 picks automatically. */
  private spectateTarget = -1;
  private boardWasPaused = false;
  private boardRows: HTMLElement[] = [];
  private feedRows: HTMLElement[] = [];
  private feedUntil = new Float64Array(4);
  private feedCursor = 0;
  private projectileOwner = new Int16Array(160);
  private allyKills = new Uint8Array(3);
  /** Offline roster callsigns, assigned once per round from the seed. */
  private enemyNames: string[] = Array(26).fill("Player");
  private allyNames: string[] = Array(3).fill("Player");
  private killsRewarded = 0;
  private revealUntil = 0;
  readonly allies = new Fighters(3);
  private alliesInitialized = false;
  readonly network = new Multiplayer();
  readonly input: Input;
  readonly ctx: CanvasRenderingContext2D;
  private mini = ($("minimap") as HTMLCanvasElement).getContext("2d")!;
  private graph = ($("graph") as HTMLCanvasElement).getContext("2d")!;
  private ui = {
    fps: $("fps"),
    entities: $("entities"),
    chunks: $("chunks"),
    frame: $("frame-time"),
    coords: $("coordinates"),
    sector: $("sector"),
    health: $("health"),
    healthFill: $("health-fill"),
    resources: $("resources"),
    toast: $("toast"),
  };
  private slots = document.querySelectorAll<HTMLButtonElement>(".slot");
  /** Local item illustrations reused for dropped guns and the weapon slot. */
  private gunIcons = WEAPON_ASSETS.map((asset) => {
    if (!asset) return null;
    const img = new Image();
    img.src = "/items/" + asset + ".svg";
    return img;
  });
  private slotIcon = document.createElement("img");
  /** Preallocated chunk for spawn checks (never touches the streamed world slots). */
  private probe = new Chunk();
  /** First-time tutorial: -1 inactive, else step index; progress anchors. */
  private tutorialStep = -1;
  private tutorialX = 0;
  private tutorialY = 0;
  private shotsFired = 0;
  /** Remote hit flashes (detected from health drops) and their last health. */
  private peerFlash = new Float32Array(30);
  private peerLife = new Float32Array(30);
  /** Floating damage numbers: fixed 16-slot pool. */
  private dnX = new Float64Array(16);
  private dnY = new Float64Array(16);
  private dnAge = new Float32Array(16).fill(9);
  private dnValue = new Uint8Array(16);
  private dnCursor = 0;
  /** Weapon kick (camera recoil) remaining. */
  private recoil = 0;
  private god: GodMode | null = null;
  private targetX = 0;
  private targetY = 0;
  /** ?dev-mode=true diagnostics (set in main.ts before construction). */
  private readonly devMode = document.body.classList.contains("dev-mode");
  private campWet = false;
  /** Fixed kill-effect slots: position, age (seconds) and whether it was the player's kill. */
  private fxX = new Float64Array(8);
  private fxY = new Float64Array(8);
  private fxAge = new Float32Array(8).fill(99);
  private fxLocal = new Uint8Array(8);
  /** Equipped kill effect style for the player's eliminations (KILL_EFFECTS index). */
  private fxStyle = new Uint8Array(8);
  private fxCursor = 0;
  /** Victory dance: active flag, clock and chosen move (0 spin, 1 bounce, 2 wave). */
  private dancing = false;
  private danceClock = 0;
  private danceMove = 0;
  private danceCtx: CanvasRenderingContext2D | null = null;
  private finaleCtx: CanvasRenderingContext2D | null = null;
  /** End-of-round sequence: 0 off, 1 victory dance stage, 2 podium, then results. */
  private finalePhase = 0;
  private finaleClock = 0;
  /** Seconds of camera shake left (local eliminations). */
  private shake = 0;
  private frameDt = 0;
  private slotIconGun = -1;
  private samples = new Float32Array(80);
  private sample = 0;
  private frames = 0;
  private elapsed = 0;
  private hudClock = 0;
  private toastClock = 5;
  private last = 0;
  private accumulator = 0;
  private running = false;
  private renderDirty = true;
  private raf = 0;
  private effectSerial = 0;
  private swing = 0;
  width = 0;
  height = 0;
  viewW = 0;
  viewH = 0;
  scale = 1;
  dpr = 1;
  cameraX = 0;
  cameraY = 0;
  paused = false;
  started = false;
  private partyWasPaused = false;
  private campX = 330;
  private campY = -180;
  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D is unavailable.");
    this.ctx = ctx;
    this.input = new Input(canvas, () => this.togglePause());
    this.input.onLeaderboard = () => this.toggleLeaderboard();
    this.projectileOwner.fill(-1);
    // Guests get a player-style callsign (kept on this device) instead of a shared default.
    const callsign = $("callsign") as HTMLInputElement;
    let saved = "";
    try {
      saved = localStorage.getItem("wildline.callsign") || "";
    } catch {
      // Storage blocked: a fresh name each visit is fine.
    }
    if (callsign.value === "Pathfinder")
      callsign.value = /^.{1,16}$/.test(saved) ? saved : randomPlayerName();
    const remember = () => {
      try {
        localStorage.setItem("wildline.callsign", callsign.value);
      } catch {
        // Ignore blocked storage.
      }
    };
    remember();
    callsign.addEventListener("change", () => {
      remember();
      this.showCallsign();
    });
    this.showCallsign();
    // Start-screen callsign editor (same value the Party form uses).
    const form = $("callsign-form") as HTMLFormElement,
      field = $("callsign-edit") as HTMLInputElement;
    $("edit-callsign").addEventListener("click", () => {
      form.hidden = false;
      field.value = callsign.value;
      $("callsign-status").textContent = "";
      field.focus();
      field.select();
    });
    $("callsign-cancel").addEventListener("click", () => (form.hidden = true));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = field.value.trim().replace(/\s+/g, " ");
      if (!/^[A-Za-z0-9 _-]{2,16}$/.test(name)) {
        $("callsign-status").textContent =
          "Use 2–16 letters, numbers, spaces, _ or -.";
        return;
      }
      callsign.value = name;
      remember();
      this.showCallsign();
      form.hidden = true;
      this.notify(
        this.network.connected
          ? "Callsign saved · used from your next match."
          : "Callsign saved.",
      );
    });
    // Fixed rows: 30 per side (offline practice can field 26 opponents).
    for (let n = 0; n < 60; n++) {
      const row = document.createElement("div");
      row.className = "leaderboard-row";
      row.append(
        document.createElement("b"),
        document.createElement("span"),
        document.createElement("em"),
      );
      $(n < 30 ? "board-home" : "board-away").append(row);
      this.boardRows.push(row);
    }
    for (let n = 0; n < 4; n++) {
      const row = document.createElement("div");
      row.hidden = true;
      $("kill-feed").append(row);
      this.feedRows.push(row);
    }
    $("leaderboard-open").addEventListener("click", () =>
      this.toggleLeaderboard(),
    );
    $("leaderboard-close").addEventListener("click", () =>
      this.toggleLeaderboard(),
    );
    $("cancel-matchmaking").addEventListener("click", () =>
      this.returnToStart(),
    );
    $("private-bots").addEventListener("change", () => {
      ($("bot-difficulty") as HTMLSelectElement).disabled = !(
        $("private-bots") as HTMLInputElement
      ).checked;
    });
    for (const [id, button] of [
      ["party-screen", "close-party"],
      ["shop-screen", "shop-close"],
      ["leaderboard-screen", "leaderboard-close"],
      ["matchmaking-screen", "cancel-matchmaking"],
      ["pause-screen", "resume"],
      ["result-screen", "result-home"],
    ]) {
      $(id).addEventListener("pointerdown", (e) => {
        if (e.target === $(id)) $(button).click();
      });
    }
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (this.mapExpanded && !$("map-panel").contains(e.target as Node)) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleMap();
          this.input.clear();
        }
      },
      true,
    );
    this.network.onElimination = (killer, victim, weapon, local, x, y) => {
      this.addKillMessage(killer, victim, weapon, local);
      if (Number.isFinite(x) && Number.isFinite(y)) this.killEffect(x, y, local);
    };
    this.network.onHit = (x, y, damage) => {
      this.hitMarker = 0.15;
      this.sound.play(Sfx.Hit);
      if (damage > 0 && Number.isFinite(x)) this.damageNumber(x, y, damage);
    };
    this.network.onKill = (count) => {
      // Respawn modes allow repeat kills of the same bots, so coins per kill are lower.
      const coins = respawnMode(this.network.mode) ? 10 : 25;
      this.profile.reward(count * coins, count * 100);
      this.hitMarker = 0.2;
      this.sound.play(Sfx.Elimination);
    };
    this.network.onCapture = (team, name) => {
      const ours = team === this.network.team;
      this.feedMessage(
        name + " captured the " + (ours ? "enemy" : "your") + " flag",
        ours,
      );
      this.notify(ours ? "Flag captured! +1 for your team." : "Your flag was captured.");
    };
    $("finale-screen").addEventListener("click", () => this.advanceFinale(0, true));
    $("tutorial-next").addEventListener("click", () => this.advanceTutorial());
    $("tutorial-skip").addEventListener("click", () => this.endTutorial());
    $("replay-tutorial").addEventListener("click", () => {
      this.setPaused(false);
      this.startTutorial();
    });
    $("spectate-prev").addEventListener("click", () => this.cycleSpectate(-1));
    $("spectate-next").addEventListener("click", () => this.cycleSpectate(1));
    $("spectate-leave").addEventListener("click", () => this.finishMatch(false));
    this.network.onResult = (result) =>
      this.finishMatch(result === "won", result === "draw");
    canvas.addEventListener("pointerdown", () => this.sound.unlock());
    document.addEventListener("pointerdown", () => this.sound.unlock(), {
      once: true,
    });
    $("sound-toggle").addEventListener("click", () => {
      this.sound.unlock();
      this.sound.toggle();
      $("sound-toggle").textContent = this.sound.muted
        ? "SOUND OFF"
        : "SOUND ON";
      $("sound-toggle").setAttribute("aria-pressed", String(this.sound.muted));
      $("sound-toggle").setAttribute(
        "aria-label",
        this.sound.muted ? "Unmute sound" : "Mute sound",
      );
    });
    $("map-toggle").addEventListener("click", () => this.toggleMap());
    $("practice-game").addEventListener("click", () => {
      this.network.disconnect();
      this.closeParty();
      this.localBots = ($("private-bots") as HTMLInputElement).checked;
      this.botDifficulty = Number(
        ($("bot-difficulty") as HTMLSelectElement).value,
      );
      const chosen = validMode(($("game-mode") as HTMLSelectElement).value);
      this.practiceMode = chosen === "br" ? "br" : "teams";
      this.reset(freshSeed());
      this.enterGame();
      this.notify(
        chosen === "br"
          ? "Solo battle royale practice · Everyone is an enemy."
          : chosen === "teams"
            ? "Bot practice · Teammates are blue. Enemies are orange."
            : MODE_LABELS[chosen] +
              " needs an online party · Starting Team Battle practice.",
      );
    });
    $("locker-open").addEventListener("click", () => this.openShop(true));
    $("play-public").addEventListener("click", () => this.playPublic());
    $("party-visibility").addEventListener("change", () => {
      $("private-rules").hidden =
        ($("party-visibility") as HTMLSelectElement).value === "public";
    });
    $("reload-touch").addEventListener("pointerdown", () => this.reload());
    $("fullscreen").addEventListener("click", () => {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      const request =
        el.requestFullscreen?.bind(el) || el.webkitRequestFullscreen?.bind(el);
      if (request)
        void Promise.resolve(request()).catch(() =>
          this.notify("Use Add to Home Screen for an edge-to-edge iPad view."),
        );
      else
        this.notify("Use Safari → Share → Add to Home Screen for fullscreen.");
    });
    $("shop-open").addEventListener("click", () => this.openShop(false));
    document
      .querySelectorAll<HTMLButtonElement>("[data-shop-filter]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          this.shopFilter = button.dataset.shopFilter!;
          this.renderShop();
        }),
      );
    $("shop-close").addEventListener("click", () => {
      $("shop-screen").hidden = true;
      this.setPaused(this.started && this.shopWasPaused);
    });
    $("result-home").addEventListener("click", () => this.returnToStart());
    $("result-again").addEventListener("click", () => {
      if (this.network.connected && !this.network.public) {
        if (!this.network.supportsRounds) {
          $("result-status").textContent =
            "This match service needs an update for party rematches. Create a new party to continue.";
          return;
        }
        $("result-status").textContent = "Preparing a new round…";
        this.network.restartRound();
      } else if (this.network.connected) this.playPublic();
      else {
        this.reset(freshSeed());
        this.enterGame();
      }
    });

    this.network.onStatus = (text) => {
      $("connection-status").textContent = text;
      if (this.quickPublic) $("matchmaking-status").textContent = text;
      for (const id of ["create-party", "join-room", "find-public"])
        ($(id) as HTMLButtonElement).disabled = this.network.connecting;
      if (!$("result-screen").hidden) $("result-status").textContent = text;
      if (
        this.quickPublic &&
        !this.network.connected &&
        (text.startsWith("Disconnected") ||
          text.includes("unavailable") ||
          text.includes("timed out"))
      ) {
        this.startBotFallback();
        return;
      }
      $("party-code").textContent = this.network.connected
        ? this.network.room
        : "—";
      $("party-members").textContent = this.network.connected
        ? "YOU · " +
          ($("callsign") as HTMLInputElement).value +
          "\n" +
          this.network.names
            .filter(
              (_, i) => this.network.peers.active[i] && !this.network.bots[i],
            )
            .join(" · ")
        : "No party yet.";
      $("multiplayer-status").textContent = this.network.connected
        ? text
        : "SOLO EXPLORATION";
    };
    this.network.onHostLost = () => void this.migrateHost();
    this.network.onResumeFailed = () => {
      // Not in the new host's backup: rejoin the same code as a fresh player.
      const code = this.network.room;
      this.network.disconnect(false);
      this.notify("Rejoining the match on its new host…");
      void this.connectPeer(code, false, false);
    };
    this.network.onWelcome = (data) => {
      if ((data as { resumed?: boolean }).resumed) {
        // Same match, new host: keep the world, position and HUD as they are.
        this.setOnlineControls(true);
        this.notify("The host left · match continues on a new host.");
        return;
      }
      ($("seed") as HTMLInputElement).value = data.seed;
      ($("relief") as HTMLSelectElement).value = String(data.relief);
      ($("enemy-density") as HTMLSelectElement).value = String(data.density);
      const rematch =
        this.joinedRoom === data.room &&
        this.network.round > this.joinedRound &&
        this.started;
      if (data.public) this.lastPublicRoom = data.room;
      this.joinedRoom = data.room;
      this.joinedRound = this.network.round;
      this.localBots = data.bots !== false;
      this.botDifficulty = data.botDifficulty ?? 1;
      this.reset(data.seed);
      this.player.gun = this.network.gun;
      this.player.magazine = this.network.magazine;
      this.player.reserve = this.network.reserve;
      this.player.x = data.x;
      this.player.y = data.y;
      this.cameraX = data.x;
      this.cameraY = data.y;
      for (const edit of data.edits)
        this.world.applyEdit(edit.x, edit.y, edit.i, edit.hp);
      this.enemies.clear();
      this.setOnlineControls(true);
      this.setPartyStep("connected");
      if (rematch) this.enterGame();
      else {
        this.started = false;
        document.body.classList.remove("playing");
        $("start-screen").hidden = false;
      }
      if (!$("party-screen").hidden) {
        this.paused = true;
        $("pause-screen").hidden = true;
      }
      this.notify(
        rematch
          ? "New round · Fresh map, loot and combatants."
          : "Party ready. Enter when you are ready; bots fill empty slots.",
      );
      // Keep the streamed world around the new camera even before entering (no blank half-screens).
      this.world.sync(this.cameraX, this.cameraY, this.viewW, this.viewH);
      this.renderDirty = true;
      // Public matches (main button or Party → Find Public Match) drop straight in.
      if (this.quickPublic || (this.autoEnter && data.public)) {
        this.quickPublic = false;
        this.autoEnter = false;
        $("party-screen").hidden = true;
        $("matchmaking-screen").hidden = true;
        this.enterGame();
      }
    };
    this.network.onEdit = (x, y, i, hp) => {
      // A chest/cache opened next to the player: play the opening sound.
      if (hp === 0 && this.started)
        for (const c of this.world.chunks)
          if (
            c.active &&
            c.x === x &&
            c.y === y &&
            c.kind[i] === 2 &&
            c.hp[i] > 0 &&
            Math.hypot(c.ox[i] - this.player.x, c.oy[i] - this.player.y) < 160
          )
            this.sound.play(Sfx.Chest);
      this.world.applyEdit(x, y, i, hp);
    };
    this.network.onShot = (x, y, angle, weapon) => {
      if (this.started) this.spatialShot(x, y, weapon);
      if (weapon !== 1) {
        const config = WEAPONS[weapon];
        const n = this.projectiles.spawn(
          x + Math.cos(angle) * 24,
          y + Math.sin(angle) * 24,
          Math.cos(angle) * config.speed,
          Math.sin(angle) * config.speed,
          Math.max(0, config.range - 24) / config.speed,
          1,
        );
        if (n >= 0) this.burst(x, y, 3, 1);
      } else
        this.burst(x + Math.cos(angle) * 40, y + Math.sin(angle) * 40, 5, 1);
    };
    this.network.onPosition = (x, y) => {
      this.player.x = x;
      this.player.y = y;
      this.player.vx = this.player.vy = 0;
      this.player.health = 100;
      if (this.started) this.setPaused(false);
    };
    this.network.onLeave = () => {
      const partyOpen = !$("party-screen").hidden;
      this.joinedRoom = "";
      this.joinedRound = 0;
      this.setOnlineControls(false);
      $("leaderboard-screen").hidden = true;
      $("matchmaking-screen").hidden = true;
      this.setPartyStep("choice");
      this.started = false;
      document.body.classList.remove("playing");
      $("start-screen").hidden = false;
      $("result-screen").hidden = true;
    this.finalePhase = 0;
    $("finale-screen").hidden = true;
      this.input.clear();
      this.setPaused(false);
      if (partyOpen) {
        this.paused = true;
        $("pause-screen").hidden = true;
      }
      this.notify(
        "Online session ended. Choose Public, Party or Bot Practice to play again.",
      );
    };
    $("online").addEventListener("click", () => this.openParty());
    $("start-party").addEventListener("click", () => this.openParty());
    $("close-party").addEventListener("click", () => this.closeParty());
    $("play-game").addEventListener("click", () => this.enterGame());
    $("party-play").addEventListener("click", () => {
      this.closeParty();
      this.enterGame();
    });
    $("choose-create").addEventListener("click", () =>
      this.setPartyStep("create"),
    );
    $("choose-join").addEventListener("click", () => this.setPartyStep("join"));
    $("party-back").addEventListener("click", () => {
      this.quickPublic = false;
      if (!this.network.connected) this.network.disconnect(false);
      this.setPartyStep("choice");
    });
    $("find-public").addEventListener("click", () =>
      this.connectParty("PUBLIC", false, true),
    );
    $("create-party").addEventListener("click", () => {
      if (this.network.connecting) return;
      if (!($("callsign") as HTMLInputElement).reportValidity()) return;
      if (
        ($("party-visibility") as HTMLSelectElement).value === "private" &&
        !document.querySelector('input[name="allowed-weapon"]:checked')
      ) {
        $("connection-status").textContent = "Choose at least one firearm.";
        return;
      }
      const random = new Uint32Array(1);
      crypto.getRandomValues(random);
      const code = random[0].toString(36).toUpperCase().padStart(7, "0");
      ($("room") as HTMLInputElement).value = code;
      this.connectParty(code, true);
    });
    $("multiplayer-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.connectParty(
        ($("room") as HTMLInputElement).value.trim().toUpperCase(),
      );
    });
    $("leave-party").addEventListener("click", () => this.network.disconnect());
    $("copy-party").addEventListener("click", () => {
      if (this.network.connected)
        navigator.clipboard
          ?.writeText(this.network.room)
          .then(() => this.notify("Party code copied."))
          .catch(() => this.notify("Your party code is " + this.network.room));
    });
    $("back-to-lobby").addEventListener("click", () => this.returnToStart());

    window.addEventListener("resize", () => this.resize());
    this.resize();
    document.addEventListener("visibilitychange", () => {
      if (
        document.hidden &&
        this.started &&
        $("party-screen").hidden &&
        $("shop-screen").hidden &&
        $("result-screen").hidden
      )
        this.setPaused(true);
    });
    $("perf").addEventListener("click", () => {
      const visible = !document.body.classList.toggle("debug-hidden");
      $("perf").setAttribute("aria-pressed", String(visible));
    });
    $("pause").addEventListener("click", () => this.togglePause());
    $("resume").addEventListener("click", () => {
      if (this.player.health <= 0 && this.network.connected) {
        this.network.respawn();
        return;
      }
      if (this.player.health <= 0)
        this.reset(($("seed") as HTMLInputElement).value);
      else this.setPaused(false);
    });
    $("restart").addEventListener("click", () => {
      if (this.network.connected) {
        if (!this.network.public && this.network.supportsRounds)
          this.network.restartRound();
        else if (this.player.health <= 0) this.playPublic();
        else
          this.notify(
            "Leave your party from the Party menu to start a solo expedition.",
          );
      } else {
        this.reset(freshSeed());
        this.enterGame();
      }
    });
    $("seed-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const value = ($("seed") as HTMLInputElement).value.trim() || "wildline";
      ($("seed") as HTMLInputElement).value = value;
      this.reset(value);
      ($("seed") as HTMLInputElement).blur();
      this.notify("New seed loaded. A new frontier awaits.");
    });
    $("random-seed").addEventListener("click", () => {
      const random = new Uint32Array(2);
      crypto.getRandomValues(random);
      const seed = random[0].toString(36) + random[1].toString(36);
      ($("seed") as HTMLInputElement).value = seed;
      this.reset(seed);
      this.notify("New frontier generated.");
    });
    this.slots.forEach((button, i) =>
      button.addEventListener("click", () => (this.input.weapon = i)),
    );
  }
  resize(): void {
    this.renderDirty = true;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.scale = Math.max(0.65, this.width / 1800, this.height / 1200);
    this.viewW = this.width / this.scale;
    this.viewH = this.height / this.scale;
    this.ctx.imageSmoothingEnabled = true;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.sound.dispose();
    this.network.disconnect();
  }
  private tick = (now: number): void => {
    if (!this.running) return;
    const realDt = Math.max(0, (now - this.last) / 1000);
    const dt = Math.min(realDt, 0.0833);
    this.last = now;
    if (this.started && !this.paused) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= 1 / 60 && steps < 5) {
        this.update(1 / 60);
        this.accumulator -= 1 / 60;
        steps++;
      }
      if (steps === 5) this.accumulator = 0;
    }
    this.frameDt = realDt;
    if (this.finalePhase) this.advanceFinale(realDt);
    if (this.dancing) this.drawDance(realDt);
    if ((this.started && !this.paused) || this.renderDirty) {
      this.render(this.ctx);
      this.renderDirty = false;
    }
    this.frames++;
    this.elapsed += realDt;
    this.hudClock += realDt;
    if (this.hudClock >= 0.25) {
      this.updateHUD();
      this.hudClock = 0;
    }
    this.raf = requestAnimationFrame(this.tick);
  };
  update(dt: number): void {
    const p = this.player,
      i = this.input;
    i.update();
    const height = terrainHeight(this.world.seed, p.x, p.y, this.world.relief);
    this.matchTime += dt;
    if (p.reloading > 0 && !this.network.connected) {
      p.reloading = Math.max(0, p.reloading - dt);
      if (p.reloading === 0) {
        const amount = Math.min(
          WEAPONS[p.gun].magazine - p.magazine,
          p.reserve,
        );
        p.magazine += amount;
        p.reserve -= amount;
      }
    }
    const down =
        this.network.connected && (p.health <= 0 || this.network.migrating),
      push = Math.hypot(i.mx, i.my),
      boost = p.sprint(
        dt,
        !down &&
          push > 0.2 &&
          (!!(i.keys.ShiftLeft || i.keys.ShiftRight) || (i.touch && push > 0.95)),
      );
    const god = this.god;
    if (god?.ammoOn) p.magazine = WEAPONS[p.gun].magazine;
    p.update(
      dt,
      down ? 0 : i.mx,
      down ? 0 : i.my,
      movementSpeed(height) * boost * (god?.speedOn ? 1.8 : 1),
    );
    this.muzzle = Math.max(0, this.muzzle - dt);
    this.hitMarker = Math.max(0, this.hitMarker - dt);
    if (i.pointerAim)
      p.angle = Math.atan2(
        (i.pointerY - this.height / 2) / this.scale + this.cameraY - p.y,
        (i.pointerX - this.width / 2) / this.scale + this.cameraX - p.x,
      );
    else if (Math.hypot(i.ax, i.ay) > 0.15) p.angle = Math.atan2(i.ay, i.ax);
    else if (Math.hypot(i.mx, i.my) > 0.1) p.angle = Math.atan2(i.my, i.mx);
    if (god?.aimOn && this.nearestHostile(god.rangeOn ? 6000 : WEAPONS[p.gun].range))
      p.angle = Math.atan2(this.targetY - p.y, this.targetX - p.x);
    // A small aim lead provides right-stick camera control while preserving predictable movement.
    const lead = i.touch && Math.hypot(i.ax, i.ay) > 0.15 ? 80 : 25;
    const ease = 1 - Math.exp(-8 * dt);
    let focusX = p.x + Math.cos(p.angle) * lead,
      focusY = p.y + Math.sin(p.angle) * lead;
    if (this.spectating()) {
      const n = this.spectateFocus();
      if (n >= 0) {
        focusX = this.network.peers.x[n];
        focusY = this.network.peers.y[n];
      }
    }
    this.cameraX += (focusX - this.cameraX) * ease;
    this.cameraY += (focusY - this.cameraY) * ease;
    this.world.sync(this.cameraX, this.cameraY, this.viewW, this.viewH);
    if (this.network.connected) {
      this.enemies.clear();
      this.allies.clear();
      if (
        Math.hypot(p.x - this.network.serverX, p.y - this.network.serverY) > 100
      ) {
        p.x = this.network.serverX;
        p.y = this.network.serverY;
        p.vx = p.vy = 0;
      }
      this.network.update(dt, p.x, p.y, p.angle);
      p.health = this.network.health;
      p.supplies = this.network.supplies;
      if (p.gun !== this.network.gun && this.network.gun !== UNARMED)
        this.sound.play(Sfx.Pickup);
      if (this.network.health - p.health >= 30 && p.health > 0)
        this.sound.play(Sfx.Heal);
      p.gun = this.network.gun;
      p.magazine = this.network.magazine;
      p.reserve = this.network.reserve;
      p.reloading = this.network.reloading;
      p.kills = this.network.kills;
    } else {
      this.syncEnemies();
      this.updateAllies(dt);
    }
    this.swing = Math.max(0, this.swing - dt);
    for (let n = 0; n < this.enemies.capacity; n++) {
      if (this.enemies.walk[n] > 0) this.enemies.walk[n] -= dt;
      if (this.enemies.flash[n] > 0) this.enemies.flash[n] -= dt;
    }
    for (let n = 0; n < this.allies.capacity; n++) {
      if (this.allies.walk[n] > 0) this.allies.walk[n] -= dt;
      if (this.allies.flash[n] > 0) this.allies.flash[n] -= dt;
    }
    const peers = this.network.peers;
    for (let n = 0; n < peers.capacity; n++) {
      if (peers.active[n] && peers.life[n] < this.peerLife[n] - 3) this.peerFlash[n] = 0.12;
      this.peerLife[n] = peers.active[n] ? peers.life[n] : 0;
      if (this.peerFlash[n] > 0) this.peerFlash[n] -= dt;
    }
    if (i.keys.KeyR) {
      i.keys.KeyR = false;
      this.reload();
    }
    const weapon = i.weapon === 1 ? 1 : p.gun,
      config = WEAPONS[weapon];
    if (
      i.shoot &&
      p.health > 0 &&
      p.cooldown === 0 &&
      (weapon === 1 ||
        (!p.reloading &&
          (p.magazine > 0 ||
            (this.network.connected && this.network.infiniteAmmo))))
    ) {
      p.cooldown = config.cooldown;
      this.shotsFired++;
      if (weapon !== 1) this.recoil = Math.min(1, 0.35 + config.damage / 110);
      this.sound.play(weapon === 1 ? Sfx.Swing : Sfx.Shot, 1, weapon);
      this.muzzle = weapon === 1 ? 0 : 0.075;
      this.revealUntil = this.matchTime + 1.2;
      if (this.network.connected) this.network.attack(p.angle, weapon);
      if (weapon !== 1) {
        if (!this.network.infiniteAmmo || !this.network.connected) p.magazine--;
        const shot = this.projectiles.spawn(
          p.x + Math.cos(p.angle) * 24,
          p.y + Math.sin(p.angle) * 24,
          Math.cos(p.angle) * config.speed,
          Math.sin(p.angle) * config.speed,
          Math.max(0, (this.god?.rangeOn ? 6000 : config.range) - 24) / config.speed,
          0,
        );
        if (shot >= 0) this.projectiles.kind[shot] = weapon + 3;
        this.burst(
          p.x + Math.cos(p.angle) * 30,
          p.y + Math.sin(p.angle) * 30,
          3,
          1,
        );
      } else {
        this.swing = 0.18;
        if (!this.network.connected) this.harvest();
      }
    }
    if (i.shoot && p.magazine === 0 && i.weapon !== 1 && !p.reloading)
      this.reload();
    this.updateProjectiles(dt);
    this.updateEnemies(dt);
    this.updateParticles(dt);
    this.autoClock += dt;
    if (this.autoClock >= 0.3) {
      this.autoClock = 0;
      // Ammo and medkits are automatic; guns are never picked up or equipped automatically.
      this.pickLoot(false);
      if (this.input.touch) {
        if (this.network.connected) this.network.collect(true);
        else this.collect(false, false);
      }
      this.gunHint();
    }
    if (i.collect) {
      if (this.network.connected) this.network.collect();
      else this.collect();
      i.collect = false;
      i.keys.KeyE = false;
    }
    this.collide();
    if (p.health < this.previousHealth) {
      p.hurt = 0.32;
      if (this.previousHealth - p.health >= 1) this.sound.play(Sfx.Damage);
    }
    this.previousHealth = p.health;
    this.toastClock -= dt;
    if (god?.godOn) p.health = 100;
    if (!this.network.connected) {
      const radius = stormRadius(this.matchTime, this.brMode),
        damage = stormDamage(this.matchTime, this.brMode) * dt;
      if (Math.hypot(p.x, p.y) > radius)
        p.health = Math.max(0, p.health - damage);
      for (let k = 0; k < this.enemies.capacity; k++)
        if (
          this.enemies.active[k] &&
          Math.hypot(this.enemies.x[k], this.enemies.y[k]) > radius
        ) {
          // Unsimulated off-screen fighters rotate inward instead of dying unseen.
          if (this.offscreen(this.enemies.x[k], this.enemies.y[k])) {
            this.pullInside(this.enemies, k, radius);
            continue;
          }
          this.enemies.life[k] -= damage;
          if (this.enemies.life[k] <= 0)
            this.defeat(
              k,
              this.assisted(k),
              "Storm",
              this.enemies.hitWeapon[k],
            );
        }
      for (let k = 0; k < this.allies.capacity; k++)
        if (
          this.allies.active[k] &&
          Math.hypot(this.allies.x[k], this.allies.y[k]) > radius
        ) {
          if (this.offscreen(this.allies.x[k], this.allies.y[k])) {
            this.pullInside(this.allies, k, radius);
            continue;
          }
          this.allies.life[k] -= damage;
          if (this.allies.life[k] <= 0) this.allies.release(k);
        }
      if (p.health <= 0) this.finishMatch(false);
      else if (this.enemySpawned > 0 && this.enemies.count === 0)
        this.finishMatch(true);
    }
  }

  private syncEnemies(): void {
    if (
      !this.localBots ||
      this.world.enemyDensity === 0 ||
      this.enemySpawned > 0
    )
      return;
    const e = this.enemies,
      w = this.world;
    for (let j = 0; j < e.capacity; j++) {
      const angle = (j / e.capacity + hash(w.seed, 91, 3)) * Math.PI * 2,
        variant = j % 3;
      let radius = this.brMode
          ? 1500 + hash(w.seed, j, 71) * 4800
          : 800 + (j % 3) * 550 + hash(w.seed, j, 69) * 150,
        x = Math.cos(angle) * radius,
        y = Math.sin(angle) * radius;
      // Step outward until the spot is dry land outside any building (seeded, order-independent).
      for (
        let step = 0;
        step < 10 && blockedSpot(w.seed, x, y, w.relief, w.enemyDensity, this.probe);
        step++
      ) {
        radius += 70;
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
      }
      const n = e.spawn(
        x,
        y,
        angle,
        0,
        variant === 0 ? 45 : variant === 1 ? 60 : 100,
        variant,
      );
      if (n >= 0) {
        e.homeX[n] = Math.floor(x / CHUNK);
        e.homeY[n] = Math.floor(y / CHUNK);
        e.object[n] = 255;
        e.gun[n] =
          FIREARM_IDS[Math.floor(hash(w.seed, j, 131) * FIREARM_IDS.length)];
        e.skin[n] = Math.floor(hash(w.seed, j, 137) * SKINS.length);
        this.enemyNames[n] = playerName(
          hash(w.seed, j, 211),
          hash(w.seed, j, 223),
          hash(w.seed, j, 227),
          hash(w.seed, j, 229),
        );
        e.hitAt[n] = -1e9;
        e.kills[n] = 0;
        this.enemySpawned++;
      }
    }
  }
  private updateAllies(dt: number): void {
    if (!this.localBots || this.practiceMode === "br") return;
    const a = this.allies,
      p = this.player,
      e = this.enemies;
    if (!this.alliesInitialized) {
      this.alliesInitialized = true;
      for (let n = 0; n < 3; n++) {
        const angle = (n * Math.PI * 2) / 3;
        let r = 360;
        while (
          r < 900 &&
          blockedSpot(
            this.world.seed,
            p.x + Math.cos(angle) * r,
            p.y + Math.sin(angle) * r,
            this.world.relief,
            this.world.enemyDensity,
            this.probe,
          )
        )
          r += 60;
        const k = a.spawn(
          p.x + Math.cos(angle) * r,
          p.y + Math.sin(angle) * r,
          0,
          0,
          100,
        );
        if (k >= 0) {
          const w = this.world.seed;
          a.gun[k] =
            FIREARM_IDS[Math.floor(hash(w, k, 151) * FIREARM_IDS.length)];
          a.skin[k] = Math.floor(hash(w, k, 157) * SKINS.length);
          this.allyNames[k] = playerName(
            hash(w, k + 40, 211),
            hash(w, k + 40, 223),
            hash(w, k + 40, 227),
            hash(w, k + 40, 229),
          );
        }
      }
    }
    for (let n = 0; n < a.capacity; n++)
      if (a.active[n]) {
        if (
          Math.abs(a.x[n] - this.cameraX) > this.viewW / 2 + CHUNK ||
          Math.abs(a.y[n] - this.cameraY) > this.viewH / 2 + CHUNK
        ) {
          continue;
        }
        let target = -1,
          range = 480;
        for (let k = 0; k < e.capacity; k++)
          if (e.active[k]) {
            const d = Math.hypot(e.x[k] - a.x[n], e.y[k] - a.y[n]);
            // Leave the player's fight alone unless the enemy comes close.
            if (this.matchTime - e.hitAt[k] < 3 && d > 220) continue;
            if (d < range) {
              range = d;
              target = k;
            }
          }
        const dx =
            (target >= 0
              ? e.x[target]
              : Math.cos(n * 2.1 + this.matchTime * 0.04) *
                Math.min(500 + n * 350, stormRadius(this.matchTime, this.brMode) * 0.7)) -
            a.x[n],
          dy =
            (target >= 0
              ? e.y[target]
              : Math.sin(n * 2.1 + this.matchTime * 0.04) *
                Math.min(500 + n * 350, stormRadius(this.matchTime, this.brMode) * 0.7)) -
            a.y[n],
          d = Math.hypot(dx, dy);
        a.vx[n] = Math.atan2(dy, dx);
        if (d > (target >= 0 ? 180 : 55)) {
          a.x[n] += (dx / d) * 180 * dt;
          a.y[n] += (dy / d) * 180 * dt;
          a.walk[n] = 0.2;
        }
        a.vy[n] = Math.max(0, a.vy[n] - dt);
        if (target >= 0 && a.vy[n] === 0) {
          a.vy[n] = 0.85;
          const shot = this.projectiles.spawn(
            a.x[n] + Math.cos(a.vx[n]) * 24,
            a.y[n] + Math.sin(a.vx[n]) * 24,
            Math.cos(a.vx[n]) * 780,
            Math.sin(a.vx[n]) * 780,
            (Math.min(WEAPONS[a.gun[n]].range, 650) - 24) / 780,
            2,
          );
          if (shot >= 0) this.projectileOwner[shot] = n;
        }
      }
  }
  private updateEnemies(dt: number): void {
    const e = this.enemies,
      p = this.player;
    const concealed =
      this.world.covered(p.x, p.y) && this.matchTime > this.revealUntil;
    for (let n = 0; n < e.capacity; n++)
      if (
        e.active[n] &&
        Math.abs(e.x[n] - this.cameraX) < this.viewW / 2 + CHUNK &&
        Math.abs(e.y[n] - this.cameraY) < this.viewH / 2 + CHUNK
      ) {
        if (concealed && Math.hypot(p.x - e.x[n], p.y - e.y[n]) > 140) continue;
        let target = -1,
          tx = p.x,
          ty = p.y,
          nearest = Math.hypot(p.x - e.x[n], p.y - e.y[n]);
        for (let k = 0; k < this.allies.capacity; k++)
          if (this.allies.active[k]) {
            const d = Math.hypot(
              this.allies.x[k] - e.x[n],
              this.allies.y[k] - e.y[n],
            );
            if (d < nearest) {
              nearest = d;
              target = k;
              tx = this.allies.x[k];
              ty = this.allies.y[k];
            }
          }
        const dx = tx - e.x[n],
          dy = ty - e.y[n],
          d = nearest;
        const speed = e.kind[n] === 0 ? 100 : e.kind[n] === 1 ? 66 : 43;
        if (d < 500 && d > 165) {
          e.x[n] += (dx / d) * speed * this.botDifficulty * dt;
          e.y[n] += (dy / d) * speed * this.botDifficulty * dt;
          e.walk[n] = 0.2;
        }
        for (let k = 0; k < e.capacity; k++)
          if (k !== n && e.active[k]) {
            const sx = e.x[n] - e.x[k],
              sy = e.y[n] - e.y[k],
              gap = Math.hypot(sx, sy);
            if (gap > 0 && gap < 65) {
              e.x[n] += (sx / gap) * 65 * dt;
              e.y[n] += (sy / gap) * 65 * dt;
            }
          }
        e.vx[n] = Math.atan2(dy, dx);
        e.vy[n] = Math.max(0, e.vy[n] - dt);
        if (
          d >= 32 &&
          d < 420 &&
          e.vy[n] === 0 &&
          !(this.brMode && this.matchTime < BR_HOLD)
        ) {
          e.vy[n] = (1.4 + e.kind[n] * 0.2) / this.botDifficulty;
          const a = e.vx[n] + Math.sin(n * 7 + this.matchTime * 3) * 0.16;
          const gun = WEAPONS[e.gun[n]];
          const shot = this.projectiles.spawn(
            e.x[n] + Math.cos(a) * 24,
            e.y[n] + Math.sin(a) * 24,
            Math.cos(a) * 600,
            Math.sin(a) * 600,
            (gun.range - 24) / 600,
            1,
          );
          if (shot >= 0) this.projectileOwner[shot] = n;
          this.burst(
            e.x[n] + Math.cos(a) * 28,
            e.y[n] + Math.sin(a) * 28,
            2,
            1,
          );
          this.spatialShot(e.x[n], e.y[n], e.gun[n]);
        }
        if (d < 32 && e.vy[n] === 0) {
          const damage = e.kind[n] === 2 ? 14 : e.kind[n] === 0 ? 5 : 8;
          if (target < 0) {
            p.health -= damage;
            p.hurt = 0.25;
          } else {
            this.allies.life[target] -= damage;
            if (this.allies.life[target] <= 0) this.allies.release(target);
          }
          e.vy[n] = 0.8;
          this.burst(p.x, p.y, 5, 2);
        }
      }
  }
  private updateProjectiles(dt: number): void {
    const b = this.projectiles,
      w = this.world,
      e = this.enemies;
    for (let n = 0; n < b.capacity; n++) {
      if (!b.active[n]) continue;
      const travel = Math.min(dt, b.life[n]);
      b.life[n] -= dt;
      b.x[n] += b.vx[n] * travel;
      b.y[n] += b.vy[n] * travel;
      if (
        b.life[n] <= 0 ||
        b.x[n] < w.minX * CHUNK ||
        b.x[n] > (w.maxX + 1) * CHUNK ||
        b.y[n] < w.minY * CHUNK ||
        b.y[n] > (w.maxY + 1) * CHUNK
      ) {
        b.release(n);
        continue;
      }
      if (b.kind[n] === 1 && !this.network.connected) {
        const p = this.player;
        if (Math.hypot(b.x[n] - p.x, b.y[n] - p.y) < 19) {
          const owner = this.projectileOwner[n];
          p.health = Math.max(
            0,
            p.health -
              Math.min(
                22,
                (owner >= 0 ? WEAPONS[this.enemies.gun[owner]].damage * 0.4 : 8) *
                  this.botDifficulty,
              ),
          );
          if (p.health === 0 && this.projectileOwner[n] >= 0)
            this.enemies.kills[this.projectileOwner[n]]++;
          this.burst(p.x, p.y, 5, 2);
          b.release(n);
          continue;
        }
        for (let a = 0; a < this.allies.capacity; a++)
          if (
            this.allies.active[a] &&
            Math.hypot(b.x[n] - this.allies.x[a], b.y[n] - this.allies.y[a]) <
              19
          ) {
            this.allies.life[a] -= 8;
            this.allies.flash[a] = 0.12;
            if (this.allies.life[a] <= 0) {
              this.allies.release(a);
              if (this.projectileOwner[n] >= 0)
                this.enemies.kills[this.projectileOwner[n]]++;
            }
            b.release(n);
            break;
          }
      }
      if (!b.active[n]) continue;
      for (let k = 0; k < e.capacity && b.kind[n] !== 1; k++)
        if (e.active[k] && Math.hypot(b.x[n] - e.x[k], b.y[n] - e.y[k]) < 19) {
          const dealt = b.kind[n] >= 3 ? WEAPONS[b.kind[n] - 3].damage : 20;
          e.life[k] -= dealt;
          e.flash[k] = 0.12;
          if (b.kind[n] >= 3) this.damageNumber(e.x[k], e.y[k], dealt);
          if (b.kind[n] >= 3) {
            e.hitAt[k] = this.matchTime;
            e.hitWeapon[k] = b.kind[n] - 3;
          }
          if (b.kind[n] !== 2) {
            this.hitMarker = 0.15;
            this.sound.play(Sfx.Hit);
          }
          this.burst(b.x[n], b.y[n], 6, 2);
          b.release(n);
          if (e.life[k] <= 0) {
            const owner = this.projectileOwner[n],
              credit = b.kind[n] !== 2 || this.assisted(k);
            if (!credit && owner >= 0) this.allyKills[owner]++;
            this.defeat(
              k,
              credit,
              this.allyNames[Math.max(0, owner)],
              b.kind[n] >= 3
                ? b.kind[n] - 3
                : credit
                  ? e.hitWeapon[k]
                  : this.allies.gun[Math.max(0, owner)],
            );
          }
          break;
        }
      if (!b.active[n]) continue;
      for (let k = 0; k < w.capacity && b.active[n]; k++) {
        const c = w.chunks[k];
        if (
          !c.active ||
          Math.floor(b.x[n] / CHUNK) !== c.x ||
          Math.floor(b.y[n] / CHUNK) !== c.y
        )
          continue;
        for (let j = 0; j < c.count; j++)
          if (
            c.hp[j] > 0 &&
            c.kind[j] === STRUCTURE &&
            Math.hypot(b.x[n] - c.ox[j], b.y[n] - c.oy[j]) < STRUCTURE_RADIUS
          ) {
            this.burst(b.x[n], b.y[n], 4, 3);
            b.release(n);
            break;
          } else if (
            c.hp[j] > 0 &&
            c.kind[j] < 2 &&
            Math.hypot(b.x[n] - c.ox[j], b.y[n] - c.oy[j]) <
              (c.kind[j] === 0 ? 18 : 24)
          ) {
            if (!this.network.connected) w.damage(c, j, 20);
            this.burst(b.x[n], b.y[n], 5, c.kind[j] === 0 ? 0 : 3);
            b.release(n);
            if (c.hp[j] === 0 && (b.kind[n] === 0 || b.kind[n] >= 3)) {
              this.player.supplies += c.drop[j] + 1;
              if (!this.input.touch)
                this.notify("Harvested supplies. Keep moving.");
            }
            break;
          }
      }
    }
  }
  private defeat(
    n: number,
    credit = true,
    killer = "Storm",
    weapon = this.input.weapon === 1 ? 1 : this.player.gun,
  ): void {
    const e = this.enemies,
      w = this.world;
    if (!e.active[n]) return;
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (c.active && c.x === e.homeX[n] && c.y === e.homeY[n]) {
        if (e.object[n] < c.count) w.damage(c, e.object[n], 1);
        break;
      }
    }
    this.killEffect(e.x[n], e.y[n], credit);
    // Gun and ammo drop separately; a seeded 15% roll adds a medkit.
    this.loot.spawn(e.x[n] - 20, e.y[n], 0, 1, 1, e.gun[n]);
    this.loot.spawn(e.x[n] + 20, e.y[n], 24, 0, 1, e.gun[n]);
    if (hash(this.world.seed, n, this.effectSerial + 3301) < MEDKIT_DROP_CHANCE)
      this.loot.spawn(e.x[n], e.y[n] + 26, 0, 2, 1, 0);
    if (credit) {
      this.player.kills++;
      this.addKillMessage(
        ($("callsign") as HTMLInputElement).value,
        this.enemyNames[n],
        weapon,
        true,
      );
      this.profile.reward(25, 100);
    }
    if (credit) {
      this.sound.play(Sfx.Elimination);
      this.player.supplies += KILL_POINTS;
    } else this.addKillMessage(killer, this.enemyNames[n], weapon, false);
    e.release(n);
    if (credit) this.notify("Elimination confirmed · +25 coins, +5 supplies");
  }
  private offscreen(x: number, y: number): boolean {
    return (
      Math.abs(x - this.cameraX) > this.viewW / 2 + CHUNK ||
      Math.abs(y - this.cameraY) > this.viewH / 2 + CHUNK
    );
  }
  private pullInside(pool: Pool, k: number, radius: number): void {
    const d = Math.hypot(pool.x[k], pool.y[k]),
      scale = d > 0 ? (radius * 0.85) / d : 0;
    pool.x[k] *= scale;
    pool.y[k] *= scale;
  }
  /** Battle royale rules apply (online room mode or offline practice mode). */
  private get brMode(): boolean {
    return (
      (this.network.connected ? this.network.mode : this.practiceMode) === "br"
    );
  }
  /** Eliminated in a private round that is still live: follow other players. */
  private spectating(): boolean {
    return (
      this.network.connected &&
      !this.network.eliminationFinal &&
      !respawnMode(this.network.mode) &&
      this.started &&
      !this.matchFinished &&
      this.player.health <= 0
    );
  }
  /** Current spectate slot; falls back to a living ally, then any living player. */
  private spectateFocus(): number {
    const peers = this.network.peers,
      n = this.spectateTarget;
    if (n >= 0 && peers.active[n] && peers.life[n] > 0) return n;
    let fallback = -1;
    for (let k = 0; k < peers.capacity; k++)
      if (peers.active[k] && peers.life[k] > 0) {
        if (this.network.ally(k)) return (this.spectateTarget = k);
        if (fallback < 0) fallback = k;
      }
    return (this.spectateTarget = fallback);
  }
  private cycleSpectate(step: number): void {
    const peers = this.network.peers,
      start = Math.max(0, this.spectateFocus());
    for (let i = 1; i <= peers.capacity; i++) {
      const k = (start + step * i + peers.capacity * 2) % peers.capacity;
      if (peers.active[k] && peers.life[k] > 0) {
        this.spectateTarget = k;
        break;
      }
    }
    this.updateSpectateBar();
  }
  private updateSpectateBar(): void {
    const on = this.spectating(),
      n = on ? this.spectateFocus() : -1;
    $("spectate-bar").hidden = !on;
    document.body.classList.toggle("spectating", on);
    if (on)
      $("spectate-name").textContent =
        n >= 0
          ? this.network.names[n] + (this.network.ally(n) ? " · ALLY" : "")
          : "Waiting for the round to finish";
    const respawning =
      this.network.connected &&
      respawnMode(this.network.mode) &&
      this.started &&
      !this.matchFinished &&
      this.player.health <= 0;
    $("respawn-banner").hidden = !respawning;
  }
  /** True when the player hit this enemy recently enough to own a bot/storm finish. */
  private assisted(k: number): boolean {
    return this.matchTime - this.enemies.hitAt[k] < ASSIST_CREDIT_SECONDS;
  }
  private harvest(): void {
    const p = this.player,
      w = this.world,
      e = this.enemies;
    let best = Infinity,
      chunk = -1,
      object = -1,
      enemy = -1;
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (!c.active) continue;
      for (let j = 0; j < c.count; j++)
        if (c.hp[j] > 0 && c.kind[j] < 2) {
          const d = axeReach(
            p.x,
            p.y,
            p.angle,
            c.ox[j],
            c.oy[j],
            c.kind[j] === 0 ? 18 : 24,
          );
          if (d < best) {
            best = d;
            chunk = k;
            object = j;
          }
        }
    }
    for (let n = 0; n < e.capacity; n++)
      if (e.active[n]) {
        const d = axeReach(p.x, p.y, p.angle, e.x[n], e.y[n], 19);
        if (d < best) {
          best = d;
          enemy = n;
        }
      }
    if (enemy >= 0) {
      e.life[enemy] -= WEAPONS[1].damage;
      e.flash[enemy] = 0.12;
      this.damageNumber(e.x[enemy], e.y[enemy], WEAPONS[1].damage);
      e.hitAt[enemy] = this.matchTime;
      e.hitWeapon[enemy] = 1;
      this.burst(e.x[enemy], e.y[enemy], 8, 2);
      if (e.life[enemy] <= 0) this.defeat(enemy);
    } else if (chunk >= 0) {
      const c = w.chunks[chunk];
      w.damage(c, object, WEAPONS[1].damage);
      this.burst(c.ox[object], c.oy[object], 10, c.kind[object] === 0 ? 0 : 3);
      if (c.hp[object] === 0) p.supplies += c.drop[object] + 2;
    }
    if (best < Infinity) {
      this.hitMarker = 0.15;
      this.sound.play(Sfx.Hit);
      this.notify("Axe hit · +" + WEAPONS[1].damage + " damage");
    } else this.notify("Axe · Aim at a trunk, rock or enemy within reach.");
  }
  private collect(feedback = true, guns = true): void {
    this.pickLoot(guns);
    const w = this.world,
      p = this.player;
    let found = false;
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (!c.active) continue;
      for (let j = 0; j < c.count; j++)
        if (
          c.kind[j] === 2 &&
          c.hp[j] > 0 &&
          (!this.brMode || c.chest[j]) &&
          Math.hypot(p.x - c.ox[j], p.y - c.oy[j]) < 105
        ) {
          w.damage(c, j, 1);
          p.supplies += c.drop[j] + 3;
          if (this.brMode) {
            // Same seeded roll as the authority's openCache.
            const gun = chestWeapon(hash(w.seed, c.x * 64 + j, c.y * 64 + 991));
            this.loot.spawn(c.ox[j] - 22, c.oy[j] + 26, chestAmmo(gun), 1, 1, gun);
            if (hash(w.seed, c.x * 64 + j, c.y * 64 + 997) < CHEST_MEDKIT_CHANCE)
              this.loot.spawn(c.ox[j] + 22, c.oy[j] + 26, 0, 2, 1, 0);
          }
          this.burst(c.ox[j], c.oy[j], 14, 1);
          this.sound.play(this.brMode ? Sfx.Chest : Sfx.Pickup);
          found = true;
        } else if (
          c.kind[j] === MEDKIT &&
          c.hp[j] > 0 &&
          p.health < 100 &&
          Math.hypot(p.x - c.ox[j], p.y - c.oy[j]) < 90
        ) {
          w.damage(c, j, 1);
          p.health = Math.min(100, p.health + MEDKIT_HEAL);
          this.sound.play(Sfx.Heal);
          found = true;
        }
    }
    if (feedback || found)
      this.notify(
        found
          ? this.brMode
            ? "Chest opened. Grab the loot."
            : "Points collected."
          : this.brMode
            ? "Move closer to a chest."
            : "Move closer to a glowing point gem.",
      );
  }
  private collide(): void {
    const w = this.world,
      p = this.player;
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (
        !c.active ||
        Math.abs(c.x * CHUNK - p.x) > CHUNK + 50 ||
        Math.abs(c.y * CHUNK - p.y) > CHUNK + 50
      )
        continue;
      for (let j = 0; j < c.count; j++)
        if (c.hp[j] > 0 && (c.kind[j] < 2 || c.kind[j] === STRUCTURE)) {
          const dx = p.x - c.ox[j],
            dy = p.y - c.oy[j],
            r =
              c.kind[j] === STRUCTURE
                ? STRUCTURE_RADIUS + 16
                : c.kind[j] === 0
                  ? 25
                  : 32,
            d2 = dx * dx + dy * dy;
          if (d2 < r * r && d2 > 0.0001) {
            const d = Math.sqrt(d2);
            p.x += (dx / d) * (r - d);
            p.y += (dy / d) * (r - d);
          }
        }
    }
  }
  private burst(x: number, y: number, count: number, kind: number): void {
    for (let j = 0; j < count; j++) {
      const a = hash(this.world.seed, this.effectSerial++, j) * Math.PI * 2,
        s = 40 + hash(this.world.seed, this.effectSerial, j) * 140;
      this.particles.spawn(
        x,
        y,
        Math.cos(a) * s,
        Math.sin(a) * s,
        0.3 + hash(this.world.seed, j, this.effectSerial) * 0.3,
        kind,
      );
    }
  }
  private updateParticles(dt: number): void {
    const p = this.particles;
    for (let n = 0; n < p.capacity; n++)
      if (p.active[n]) {
        p.life[n] -= dt;
        if (p.life[n] <= 0) {
          p.release(n);
          continue;
        }
        p.x[n] += p.vx[n] * dt;
        p.y[n] += p.vy[n] * dt;
        p.vx[n] *= 0.95;
        p.vy[n] *= 0.95;
      }
  }
  private visible(x: number, y: number, pad = 90): boolean {
    return (
      Math.abs(x - this.cameraX) < this.viewW / 2 + pad &&
      Math.abs(y - this.cameraY) < this.viewH / 2 + pad
    );
  }
  render(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#70894f";
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.cameraX, -this.cameraY);
    if (this.recoil > 0) {
      const a = this.player.angle,
        k = this.recoil * 7;
      ctx.translate(Math.cos(a) * k, Math.sin(a) * k);
      this.recoil = Math.max(0, this.recoil - this.frameDt * 9);
    }
    if (this.shake > 0) {
      const k = this.shake * 40;
      ctx.translate(Math.sin(this.matchTime * 91) * k, Math.cos(this.matchTime * 77) * k);
      this.shake = Math.max(0, this.shake - this.frameDt);
    }
    const w = this.world;
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (
        !c.active ||
        !this.visible(c.x * CHUNK + CHUNK / 2, c.y * CHUNK + CHUNK / 2, CHUNK)
      )
        continue;
      this.ground.draw(ctx, c, k, w.seed, w.relief);
    }
    this.drawTrail(ctx);
    this.drawCamp(ctx);
    if (this.network.connected && this.network.mode === "ctf") this.drawFlags(ctx);
    // Ground shadows first, followed by actors and canopies for a small 2.5D depth cue.
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (!c.active) continue;
      for (let j = 0; j < c.count; j++)
        if (c.hp[j] > 0 && c.kind[j] < 2 && this.visible(c.ox[j], c.oy[j])) {
          ctx.fillStyle = "#213c3060";
          ctx.beginPath();
          ctx.ellipse(
            c.ox[j] + 16,
            c.oy[j] + 13,
            c.kind[j] === 0 ? 39 : 29,
            c.kind[j] === 0 ? 21 : 14,
            -0.4,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
    }
    const e = this.enemies;
    for (let n = 0; n < e.capacity; n++)
      if (e.active[n] && this.visible(e.x[n], e.y[n], 30)) {
        this.drawActor(
          ctx,
          e.x[n],
          e.y[n],
          e.vx[n],
          true,
          e.flash[n] > 0,
          e.kind[n],
          e.skin[n],
          false,
          e.gun[n],
          e.walk[n] > 0 ? this.matchTime * 11 + n : -1,
        );
      }
    const companions = this.allies;
    for (let n = 0; n < companions.capacity; n++)
      if (
        companions.active[n] &&
        this.visible(companions.x[n], companions.y[n])
      )
        this.drawActor(
          ctx,
          companions.x[n],
          companions.y[n],
          companions.vx[n],
          false,
          companions.flash[n] > 0,
          1,
          companions.skin[n],
          false,
          companions.gun[n],
          companions.walk[n] > 0 ? this.matchTime * 11 + n : -1,
        );
    const remotes = this.network.peers;
    for (let n = 0; n < remotes.capacity; n++)
      if (
        remotes.active[n] &&
        remotes.life[n] > 0 &&
        (!this.network.concealed[n] ||
          this.network.ally(n) ||
          Math.hypot(
            remotes.x[n] - this.player.x,
            remotes.y[n] - this.player.y,
          ) < 140) &&
        this.visible(remotes.x[n], remotes.y[n], 40)
      ) {
        this.drawActor(
          ctx,
          remotes.x[n],
          remotes.y[n],
          remotes.vx[n],
          !this.network.ally(n),
          this.peerFlash[n] > 0,
          1,
          this.network.outfits[n],
          this.network.weapons[n] === UNARMED,
          this.network.weapons[n],
          Math.abs(this.network.targetsX[n] - remotes.x[n]) +
            Math.abs(this.network.targetsY[n] - remotes.y[n]) >
            2
            ? this.matchTime * 11 + n
            : -1,
        );
      }
    const p = this.player;
    if (!this.network.connected || p.health > 0)
      this.drawActor(
        ctx,
        p.x,
        p.y,
        p.angle,
        false,
        p.hurt > 0,
        1,
        -1,
        this.input.weapon === 1 || p.gun === UNARMED,
        p.gun,
        Math.abs(p.vx) + Math.abs(p.vy) > 40 ? this.matchTime * 11 : -1,
      );
    if (this.swing > 0) {
      ctx.strokeStyle = "#e7f9b1aa";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 64, p.angle - 0.8, p.angle + 0.8);
      ctx.stroke();
    }
    for (let k = 0; k < w.capacity; k++) {
      const c = w.chunks[k];
      if (!c.active) continue;
      for (let j = 0; j < c.count; j++) {
        if (c.hp[j] <= 0 || c.kind[j] === 3 || !this.visible(c.ox[j], c.oy[j]))
          continue;
        const x = c.ox[j],
          y = c.oy[j];
        if (c.kind[j] === 0)
          ctx.drawImage(
            c.biome[j] === BIOME_SNOW
              ? this.props.pines[j & 1]
              : c.biome[j] === BIOME_DESERT
                ? this.props.cacti[j & 1]
                : this.props.trees[(hash(w.seed, j + c.x, c.y) * 3) | 0],
            x - 64,
            y - 124,
          );
        else if (c.kind[j] === 1)
          ctx.drawImage(this.props.rock, x - 32, y - 38);
        else if (c.kind[j] === MEDKIT) this.drawLoot(ctx, x, y, 2, 0, 0);
        else if (c.kind[j] === STRUCTURE)
          ctx.drawImage(this.props.houses[c.biome[j]] ?? this.props.houses[0], x - 100, y - 118);
        else if (c.kind[j] === 4) {
          const b = c.biome[j];
          ctx.fillStyle =
            b === BIOME_SNOW ? "#9fb7ad" : b === BIOME_DESERT ? "#8d7a45" : "#335d32";
          ctx.beginPath();
          ctx.ellipse(x, y - 5, 35, 25, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle =
            b === BIOME_SNOW ? "#e6efec" : b === BIOME_DESERT ? "#b9a463" : "#68854a";
          ctx.beginPath();
          ctx.ellipse(x - 8, y - 12, 24, 16, -0.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (this.brMode) {
          if (c.chest[j]) this.drawChest(ctx, x, y);
        }
        else this.drawCache(ctx, x, y);
      }
    }
    this.drawKillEffects(ctx, this.frameDt);
    this.drawDamageNumbers(ctx, this.frameDt);
    if (this.god?.espOn) this.drawEsp(ctx);
    this.drawHealthBar(ctx, p.x, p.y, p.health, 100, false);
    for (let n = 0; n < companions.capacity; n++)
      if (
        companions.active[n] &&
        this.visible(companions.x[n], companions.y[n])
      ) {
        this.drawHealthBar(
          ctx,
          companions.x[n],
          companions.y[n],
          companions.life[n],
          100,
          false,
          true,
        );
        ctx.font = "600 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#b2e3ef";
        ctx.fillText(this.allyNames[n], companions.x[n], companions.y[n] - 49);
        ctx.textAlign = "start";
        if (this.devMode) this.devTag(ctx, companions.x[n], companions.y[n], true);
      }
    for (let n = 0; n < remotes.capacity; n++)
      if (
        remotes.active[n] &&
        remotes.life[n] > 0 &&
        (!this.network.concealed[n] ||
          this.network.ally(n) ||
          Math.hypot(
            remotes.x[n] - this.player.x,
            remotes.y[n] - this.player.y,
          ) < 140) &&
        this.visible(remotes.x[n], remotes.y[n], 40)
      ) {
        this.drawHealthBar(
          ctx,
          remotes.x[n],
          remotes.y[n],
          remotes.life[n],
          100,
          !this.network.ally(n),
          this.network.ally(n),
        );
        ctx.font = "600 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle =
          this.network.ally(n) ? "#b2e3ef" : "#eec9a8";
        ctx.fillText(this.network.names[n], remotes.x[n], remotes.y[n] - 49);
        ctx.textAlign = "start";
        if (this.devMode) this.devTag(ctx, remotes.x[n], remotes.y[n], this.network.bots[n] === 1);
      }
    for (let n = 0; n < e.capacity; n++)
      if (e.active[n] && this.visible(e.x[n], e.y[n], 40)) {
        this.drawHealthBar(
          ctx,
          e.x[n],
          e.y[n],
          e.life[n],
          e.kind[n] === 0 ? 45 : e.kind[n] === 1 ? 60 : 100,
          true,
        );
        if (this.devMode) this.devTag(ctx, e.x[n], e.y[n], true);
      }
    const loot = this.network.connected ? this.network.loot : this.loot;
    for (let n = 0; n < loot.capacity; n++)
      if (loot.active[n] && this.visible(loot.x[n], loot.y[n], 50))
        this.drawLoot(ctx, loot.x[n], loot.y[n], loot.vy[n], loot.kind[n], loot.vx[n]);
    const radius = this.network.connected
      ? this.network.radius
      : stormRadius(this.matchTime, this.brMode);
    ctx.fillStyle = "#6f3fbc55";
    ctx.beginPath();
    ctx.rect(
      this.cameraX - this.viewW / 2,
      this.cameraY - this.viewH / 2,
      this.viewW,
      this.viewH,
    );
    ctx.moveTo(radius, 0);
    ctx.arc(0, 0, radius, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.strokeStyle = "#c3a1ed";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.stroke();
    const b = this.projectiles;
    ctx.beginPath();
    for (let n = 0; n < b.capacity; n++)
      if (b.active[n] && this.visible(b.x[n], b.y[n], 10)) {
        ctx.moveTo(b.x[n], b.y[n]);
        ctx.lineTo(b.x[n] - b.vx[n] * 0.03, b.y[n] - b.vy[n] * 0.03);
      }
    // Glowing tracer: wide soft pass, then a bright core.
    ctx.lineCap = "round";
    ctx.strokeStyle = "#ffe27a44";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = "#fff6c8";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.lineCap = "butt";
    const fx = this.particles;
    for (let n = 0; n < fx.capacity; n++)
      if (fx.active[n] && this.visible(fx.x[n], fx.y[n], 10)) {
        const big = fx.kind[n] === 4;
        ctx.fillStyle =
          fx.kind[n] === 0
            ? "#bdd586"
            : fx.kind[n] === 1
              ? "#eff6a1"
              : fx.kind[n] === 2
                ? "#e69b76"
                : big
                  ? KILL_EFFECTS[this.profile.effect].color
                  : "#b9c4b0";
        ctx.globalAlpha = Math.min(1, fx.life[n] * 3);
        ctx.fillRect(fx.x[n], fx.y[n], big ? 6 : 3, big ? 6 : 3);
      }
    ctx.globalAlpha = 1;
    if (this.muzzle > 0) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = "#fff3b0";
      ctx.beginPath();
      ctx.moveTo(27, -9);
      ctx.lineTo(54, 0);
      ctx.lineTo(27, 9);
      ctx.lineTo(34, 0);
      ctx.fill();
      ctx.restore();
    }
    if (this.hitMarker > 0) {
      ctx.strokeStyle = "#fff9d1";
      ctx.lineWidth = 3;
      ctx.beginPath();
      const x = p.x + Math.cos(p.angle) * 90,
        y = p.y + Math.sin(p.angle) * 90;
      ctx.moveTo(x - 9, y - 9);
      ctx.lineTo(x - 3, y - 3);
      ctx.moveTo(x + 9, y - 9);
      ctx.lineTo(x + 3, y - 3);
      ctx.moveTo(x - 9, y + 9);
      ctx.lineTo(x - 3, y + 3);
      ctx.moveTo(x + 9, y + 9);
      ctx.lineTo(x + 3, y + 3);
      ctx.stroke();
    }
    const zone = this.network.connected
        ? this.network.radius
        : stormRadius(this.matchTime, this.brMode),
      inStorm = this.started && Math.hypot(p.x, p.y) > zone && p.health > 0;
    if (inStorm) {
      // Storm exposure: a pulsing border in the storm's own colour.
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.strokeStyle = "#9b5cf0";
      ctx.globalAlpha = 0.45 + Math.sin(this.matchTime * 5) * 0.2;
      ctx.lineWidth = 30;
      ctx.strokeRect(15, 15, this.width - 30, this.height - 30);
      ctx.strokeStyle = "#d9b8ff";
      ctx.globalAlpha *= 0.6;
      ctx.lineWidth = 6;
      ctx.strokeRect(33, 33, this.width - 66, this.height - 66);
      ctx.restore();
    } else if (p.hurt > 0) {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.strokeStyle = "#ff6d57";
      ctx.globalAlpha = Math.min(0.8, p.hurt * 2.5);
      ctx.lineWidth = 18;
      ctx.strokeRect(9, 9, this.width - 18, this.height - 18);
      ctx.restore();
    }
  }
  /** Interactive first-run tutorial (also replayable from the pause menu). */
  private startTutorial(): void {
    this.tutorialStep = 0;
    this.tutorialX = this.player.x;
    this.tutorialY = this.player.y;
    this.shotsFired = 0;
    $("tutorial").hidden = false;
    document.body.classList.add("tutorial-on");
    this.showTutorialStep();
  }
  private endTutorial(): void {
    this.tutorialStep = -1;
    $("tutorial").hidden = true;
    document.body.classList.remove("tutorial-on");
    try {
      localStorage.setItem("wildline.tutorial.v1", "done");
    } catch {
      // Ignore blocked storage.
    }
  }
  private tutorialSteps(): [string, string][] {
    const touch = this.input.touch,
      mode = this.network.connected ? this.network.mode : this.practiceMode;
    return [
      [
        "MOVE",
        touch
          ? "Drag the left joystick to move around."
          : "Move with W A S D or the arrow keys.",
      ],
      [
        "AIM AND SHOOT",
        touch
          ? "Aim with the right joystick and hold ATTACK to fire."
          : "Aim with the mouse and hold left click to fire. R reloads, 1 / 2 swap gun and axe.",
      ],
      [
        "SPRINT",
        touch
          ? "Push the move stick all the way to its edge to sprint. The blue bar under health is stamina."
          : "Hold Shift while moving to sprint. The blue bar under health is stamina.",
      ],
      [
        "LOOT AND POINTS",
        (touch ? "Tap COLLECT" : "Press E") +
          " to pick up guns and open " +
          (mode === "br" ? "chests" : "point gems") +
          ". Ammo and medkits are picked up automatically. Points turn into coins at the end of the round.",
      ],
      [
        "THE ZONE",
        "Stay inside the circle. A pulsing purple border means you are in the storm and losing health. Tap MAP to see the zone.",
      ],
      [
        "WIN THE ROUND",
        mode === "br"
          ? "Battle Royale: everyone starts with an axe. Loot chests and be the last one standing."
          : mode === "ffa"
            ? "Free-for-All: you respawn. First to 15 eliminations wins."
            : mode === "ctf"
              ? "Capture the Flag: grab the enemy flag and bring it to your base while your flag is home."
              : "Team Battle: blue is your team, orange is the enemy. The last team standing wins.",
      ],
    ];
  }
  private showTutorialStep(): void {
    const steps = this.tutorialSteps(),
      [title, text] = steps[this.tutorialStep];
    $("tutorial-step").textContent = this.tutorialStep + 1 + " / " + steps.length;
    $("tutorial-title").textContent = title;
    $("tutorial-text").textContent = text;
    $("tutorial-check").textContent = this.tutorialStep < 3 ? "Try it now…" : "";
    $("tutorial-next").textContent =
      this.tutorialStep === steps.length - 1 ? "LET'S GO ✓" : "NEXT ›";
  }
  private advanceTutorial(): void {
    if (this.tutorialStep < 0) return;
    if (this.tutorialStep >= this.tutorialSteps().length - 1) {
      this.endTutorial();
      return;
    }
    this.tutorialStep++;
    this.tutorialX = this.player.x;
    this.tutorialY = this.player.y;
    this.shotsFired = 0;
    this.showTutorialStep();
  }
  /** Throttled HUD work: the first three steps complete when the player does them. */
  private tutorialTick(): void {
    const step = this.tutorialStep,
      p = this.player;
    if (step < 0 || !this.started || this.paused) return;
    const done =
      step === 0
        ? Math.hypot(p.x - this.tutorialX, p.y - this.tutorialY) > 160
        : step === 1
          ? this.shotsFired > 0
          : step === 2
            ? p.stamina < 85
            : false;
    if (done) {
      $("tutorial-check").textContent = "✓ Nice!";
      this.tutorialStep = -2 - step; // brief pause before the next step
      setTimeout(() => {
        if (this.tutorialStep === -2 - step) {
          this.tutorialStep = step;
          this.advanceTutorial();
        }
      }, 700);
    }
  }
  private showCallsign(): void {
    const name = ($("callsign") as HTMLInputElement).value || "Player";
    $("start-callsign").textContent = name;
    $("player-callsign").textContent = name.toUpperCase();
  }
  /** Dev tools: closest living opponent within range → targetX/targetY. */
  private nearestHostile(range: number): boolean {
    const p = this.player;
    let best = range;
    let found = false;
    if (this.network.connected) {
      const peers = this.network.peers;
      for (let n = 0; n < peers.capacity; n++)
        if (peers.active[n] && peers.life[n] > 0 && !this.network.ally(n)) {
          const d = Math.hypot(peers.x[n] - p.x, peers.y[n] - p.y);
          if (d < best) {
            best = d;
            this.targetX = peers.x[n];
            this.targetY = peers.y[n];
            found = true;
          }
        }
    } else {
      const e = this.enemies;
      for (let n = 0; n < e.capacity; n++)
        if (e.active[n]) {
          const d = Math.hypot(e.x[n] - p.x, e.y[n] - p.y);
          if (d < best) {
            best = d;
            this.targetX = e.x[n];
            this.targetY = e.y[n];
            found = true;
          }
        }
    }
    return found;
  }
  /** Dev tools ESP: box and tracer for every opponent, including hidden ones. */
  private drawEsp(ctx: CanvasRenderingContext2D): void {
    ctx.lineWidth = 2;
    if (this.network.connected) {
      const peers = this.network.peers;
      for (let n = 0; n < peers.capacity; n++)
        if (peers.active[n] && peers.life[n] > 0 && !this.network.ally(n))
          this.espMark(ctx, peers.x[n], peers.y[n]);
    } else {
      const e = this.enemies;
      for (let n = 0; n < e.capacity; n++)
        if (e.active[n]) this.espMark(ctx, e.x[n], e.y[n]);
    }
  }
  private espMark(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const p = this.player;
    ctx.strokeStyle = "#ff4d6dcc";
    ctx.strokeRect(x - 22, y - 30, 44, 54);
    ctx.strokeStyle = "#ff4d6d55";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
  /** Enable ?god-mode=zrax developer tools (menu behind the L key and a password). */
  enableGod(): void {
    const god = (this.god = new GodMode());
    god.scope = () =>
      !this.network.connected ? "full" : this.network.public ? "off" : "assist";
    god.onAction = (action) => {
      if (god.scope() !== "full" || !this.started) return;
      const p = this.player;
      if (action === "tp-center") {
        p.x = p.y = 0;
      } else if (this.nearestHostile(1e9)) {
        p.x = this.targetX + 90;
        p.y = this.targetY;
      }
      p.vx = p.vy = 0;
      this.cameraX = p.x;
      this.cameraY = p.y;
    };
  }
  /** Dev mode only: small BOT / HUMAN tag above a combatant. */
  private devTag(ctx: CanvasRenderingContext2D, x: number, y: number, bot: boolean): void {
    ctx.fillStyle = bot ? "#5a3a8ccc" : "#1f6b4fcc";
    ctx.fillRect(x - 21, y - 76, 42, 13);
    ctx.font = "700 9px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(bot ? "BOT" : "HUMAN", x, y - 66);
    ctx.textAlign = "start";
  }
  private drawHealthBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    health: number,
    max: number,
    enemy: boolean,
    ally = false,
  ): void {
    ctx.fillStyle = "#102820dc";
    ctx.fillRect(x - 24, y - 44, 48, 9);
    ctx.fillStyle = enemy ? "#f0b07e" : ally ? "#88d9ed" : "#d9f877";
    ctx.fillRect(x - 22, y - 42, (44 * Math.max(0, health)) / max, 5);
  }
  private allowedMask(): number {
    let mask = 0;
    document
      .querySelectorAll<HTMLInputElement>(
        'input[name="allowed-weapon"]:checked',
      )
      .forEach((el) => (mask |= 1 << Number(el.value)));
    return mask || 1;
  }
  private reload(): void {
    const p = this.player,
      can = !p.reloading && p.magazine < WEAPONS[p.gun].magazine && p.reserve > 0;
    if (can) this.sound.play(Sfx.Reload);
    if (this.network.connected) {
      this.network.reload();
      return;
    }
    if (can) p.reloading = WEAPONS[p.gun].reload;
  }
  /** Standing on a dropped gun: show how to take it (never automatic). */
  private gunHint(): void {
    if (this.toastClock > 0) return;
    const loot = this.network.connected ? this.network.loot : this.loot,
      p = this.player;
    for (let n = 0; n < loot.capacity; n++)
      if (
        loot.active[n] &&
        loot.vy[n] === 1 &&
        Math.hypot(loot.x[n] - p.x, loot.y[n] - p.y) < 70
      ) {
        this.notify(
          (this.input.touch ? "Tap COLLECT" : "Press E") +
            " to take the " +
            WEAPONS[loot.kind[n]].name,
        );
        return;
      }
  }
  /** Other combatants' shots: louder when close, panned toward their side. */
  private spatialShot(x: number, y: number, weapon: number): void {
    const p = this.player,
      d = Math.hypot(x - p.x, y - p.y);
    if (d > 1300) return;
    const volume = 0.5 * (1 - d / 1300) ** 1.5,
      pan = Math.max(-0.85, Math.min(0.85, (x - p.x) / 700));
    this.sound.play(weapon === 1 ? Sfx.Swing : Sfx.Shot, volume, weapon, pan);
  }
  private pickLoot(guns = false): void {
    if (this.network.connected) return;
    const l = this.loot,
      p = this.player;
    for (let n = 0; n < l.capacity; n++)
      if (l.active[n] && Math.hypot(l.x[n] - p.x, l.y[n] - p.y) < 70) {
        if (l.vx[n] > 0) {
          p.reserve = Math.min(240, p.reserve + l.vx[n]);
          l.vx[n] = 0;
        }
        if (l.vy[n] === 2 && p.health < 100) {
          p.health = Math.min(100, p.health + MEDKIT_HEAL);
          l.vy[n] = 0;
          this.sound.play(Sfx.Heal);
          this.notify("Medkit used · +" + MEDKIT_HEAL + " health");
        }
        if (guns && l.vy[n] === 1) {
          this.sound.play(Sfx.Pickup);
          p.gun = l.kind[n];
          p.magazine = 0;
          p.reloading = 0;
          this.reload();
          l.vy[n] = 0;
        }
        if (!l.vx[n] && !l.vy[n]) l.release(n);
      }
  }
  private finishMatch(won: boolean, draw = false): void {
    if (this.matchFinished) return;
    this.matchFinished = true;
    this.paused = true;
    this.input.clear();
    $("pause-screen").hidden = true;
    $("party-screen").hidden = true;
    $("shop-screen").hidden = true;
    $("leaderboard-screen").hidden = true;
    $("matchmaking-screen").hidden = true;
    if (this.mapExpanded) this.toggleMap();
    const kills = Math.floor(
      finiteValue(
        this.network.connected ? this.network.kills : this.player.kills,
      ),
    );
    const points = this.network.connected ? this.network.supplies : this.player.supplies,
      bonus = pointCoins(points),
      matchCoins = (won ? 100 : 10) + bonus;
    this.profile.reward(matchCoins, won ? 400 : 50);
    this.profile.recordGame(won);
    this.profile.save();
    const mode = this.network.connected ? this.network.mode : this.practiceMode;
    $("result-title").textContent = draw
      ? "DRAW"
      : won
        ? "VICTORY"
        : this.player.health <= 0 && !respawnMode(mode)
          ? "ELIMINATED"
          : "DEFEAT";
    $("result-label").textContent =
      MODE_LABELS[mode] +
      " · " +
      (draw
        ? "NO SIDE TAKES IT"
        : won
          ? mode === "teams"
            ? "YOUR SQUAD TAKES THE FRONTIER"
            : mode === "ctf"
              ? "FLAGS SECURED"
              : mode === "ffa"
                ? "TOP OF THE BOARD"
                : "LAST ONE STANDING"
          : "YOUR RUN ENDS HERE");
    $("result-stats").textContent =
      kills +
      " eliminations · " +
      points +
      " points (+" +
      bonus +
      ") · " +
      matchCoins +
      " match coins · " +
      this.profile.coins +
      " coins saved";
    $("result-status").textContent =
      this.network.connected && !this.network.public
        ? "The host can start a fresh round after the squad finishes."
        : "Next game: a fresh map, fresh loot and a new storm.";
    $("result-again").textContent =
      this.network.connected && !this.network.public
        ? "NEXT PARTY ROUND"
        : "PLAY AGAIN";
    $("victory-dance").hidden = !won;
    this.dancing = won;
    this.danceClock = 0;
    this.danceMove = this.profile.dance;
    this.startFinale(won);
  }
  private openShop(locker: boolean): void {
    this.lockerMode = locker;
    this.shopWasPaused = this.paused;
    this.paused = true;
    this.input.clear();
    $("pause-screen").hidden = true;
    $("shop-screen").hidden = false;
    $("shop-eyebrow").textContent = locker
      ? "YOUR GEAR / OWNED ITEMS"
      : "THE QUARTERMASTER / FIELD SUPPLY";
    $("shop-title").firstChild!.textContent = locker
      ? "YOUR LOCKER"
      : "MAKE IT YOURS";
    $("shop-detail").textContent = locker
      ? "Everything you own. Equip a starting weapon and outfit for your next match."
      : "Items you can still unlock. Earn 25 coins per elimination and 100 for a win; purchases move to your Locker.";
    $("shop-status").textContent = "";
    this.renderShop();
    document.querySelector(".shop-card")!.scrollTop = 0;
    $("shop-close").focus();
  }
  private playPublic(): void {
    this.network.disconnect(false);
    this.joinedRoom = "";
    this.joinedRound = 0;
    this.started = false;
    document.body.classList.remove("playing");
    $("result-screen").hidden = true;
    this.finalePhase = 0;
    $("finale-screen").hidden = true;
    $("start-screen").hidden = false;
    this.setOnlineControls(false);
    this.paused = true;
    this.input.clear();
    $("pause-screen").hidden = true;
    $("party-screen").hidden = true;
    $("matchmaking-screen").hidden = false;
    $("matchmaking-status").textContent =
      "Finding a match. Bots fill empty slots.";
    this.quickPublic = true;
    this.connectParty("PUBLIC", false, true);
  }
  private returnToStart(): void {
    this.quickPublic = false;
    this.network.disconnect(false);
    this.joinedRoom = "";
    this.joinedRound = 0;
    this.started = false;
    document.body.classList.remove("playing");
    this.input.clear();
    $("result-screen").hidden = true;
    this.finalePhase = 0;
    $("finale-screen").hidden = true;
    $("party-screen").hidden = true;
    $("shop-screen").hidden = true;
    $("leaderboard-screen").hidden = true;
    $("matchmaking-screen").hidden = true;
    $("start-screen").hidden = false;
    this.setOnlineControls(false);
    this.setPaused(false);
  }
  private startBotFallback(): void {
    this.quickPublic = false;
    this.network.disconnect();
    this.closeParty();
    $("matchmaking-screen").hidden = true;
    this.localBots = true;
    this.botDifficulty = 1;
    this.practiceMode = "teams";
    this.reset(freshSeed());
    this.enterGame();
    $("multiplayer-status").textContent = "BOT PRACTICE · OFFLINE";
    this.notify(
      "Online connection unavailable · Starting bot practice. Use Public again to retry online.",
    );
  }
  private toggleMap(): void {
    this.mapExpanded = !this.mapExpanded;
    $("map-panel").classList.toggle("expanded", this.mapExpanded);
    $("map-toggle").setAttribute("aria-expanded", String(this.mapExpanded));
    $("map-toggle").setAttribute(
      "aria-label",
      this.mapExpanded ? "Close expanded map" : "Expand map",
    );
    $("map-toggle").textContent = this.mapExpanded ? "CLOSE MAP ×" : "MAP ⤢";
    this.drawMini();
  }
  private addKillMessage(
    killer: string,
    victim: string,
    weapon: number,
    local = false,
  ): void {
    this.feedMessage(
      killer + "  [" + WEAPONS[weapon].name + "]  " + victim,
      local,
    );
  }
  private feedMessage(text: string, local: boolean): void {
    const i = this.feedCursor++ % 4,
      row = this.feedRows[i];
    row.textContent = text;
    row.classList.toggle("your-kill", local);
    row.hidden = false;
    this.feedUntil[i] = performance.now() + 8000;
  }
  private toggleLeaderboard(): void {
    const closing = !$("leaderboard-screen").hidden;
    if (!closing && (!this.started || this.matchFinished)) return;
    if (closing) {
      $("leaderboard-screen").hidden = true;
      this.setPaused(this.boardWasPaused);
    } else {
      this.boardWasPaused = this.paused;
      this.paused = true;
      this.input.clear();
      $("pause-screen").hidden = true;
      $("leaderboard-screen").hidden = false;
      this.drawLeaderboard();
    }
  }
  /** Round standings (cold path: leaderboard/podium), sorted by eliminations. */
  private standings() {
    const entries = [
      {
        name: ($("callsign") as HTMLInputElement).value || "You",
        kills: this.network.connected ? this.network.kills : this.player.kills,
        team: true,
        alive: this.player.health > 0,
        you: true,
        color: SKINS[this.outfit].color as string,
      },
    ];
    if (this.network.connected) {
      for (let n = 0; n < this.network.peers.capacity; n++)
        if (this.network.peers.active[n])
          entries.push({
            name: this.network.names[n],
            kills: this.network.scores[n],
            team: this.network.ally(n),
            alive: this.network.peers.life[n] > 0,
            you: false,
            color: (SKINS[this.network.outfits[n]] ?? SKINS[0]).color,
          });
    } else if (this.localBots) {
      for (let n = 0; n < this.enemySpawned; n++)
        entries.push({
          name: this.enemyNames[n],
          kills: this.enemies.kills[n],
          team: false,
          alive: !!this.enemies.active[n],
          you: false,
          color: (SKINS[this.enemies.skin[n]] ?? SKINS[0]).color,
        });
      if (this.alliesInitialized)
        for (let n = 0; n < 3; n++)
          entries.push({
            name: this.allyNames[n],
            kills: this.allyKills[n],
            team: true,
            alive: !!this.allies.active[n],
            you: false,
            color: (SKINS[this.allies.skin[n]] ?? SKINS[0]).color,
          });
    }
    entries.sort(
      (a, b) =>
        b.kills - a.kills ||
        Number(b.alive) - Number(a.alive) ||
        Number(b.you) - Number(a.you),
    );
    return entries;
  }
  private drawLeaderboard(): void {
    // Cold/throttled UI work: stable scene storage remains untouched.
    const entries = this.standings();
    const mode = this.network.connected ? this.network.mode : this.practiceMode,
      solo = mode === "br" || mode === "ffa";
    let homeKills = 0,
      awayKills = 0,
      home = 0,
      away = 0,
      rank = 0;
    const fill = (row: HTMLElement, e: (typeof entries)[0], place: number) => {
      row.hidden = false;
      row.children[0].textContent = String(place);
      row.children[1].textContent = e.name + (e.you ? " · YOU" : "");
      row.children[2].textContent = e.kills + (e.alive ? "" : " · OUT");
      row.classList.toggle("friendly", e.team);
      row.classList.toggle("you", e.you);
      row.classList.toggle("out", !e.alive);
    };
    for (let n = 0; n < entries.length; n++) {
      const e = entries[n];
      if (e.you) rank = n + 1;
      // Teams: allies left, opponents right. Solo modes: ranks 1–30 left, 31+ right.
      const left = solo ? n < 30 : e.team;
      if (left) {
        homeKills += e.kills;
        if (home < 30) fill(this.boardRows[home], e, solo ? n + 1 : home + 1);
        home++;
      } else {
        awayKills += e.kills;
        if (away < 30) fill(this.boardRows[30 + away], e, solo ? n + 1 : away + 1);
        away++;
      }
    }
    for (let n = Math.min(home, 30); n < 30; n++) this.boardRows[n].hidden = true;
    for (let n = Math.min(away, 30); n < 30; n++) this.boardRows[30 + n].hidden = true;
    $("board-mode").textContent = MODE_LABELS[mode];
    $("leaderboard-rows").classList.toggle("solo", solo);
    if (solo) {
      $("board-home-title").textContent = "STANDINGS";
      $("board-away-title").textContent = away ? "STANDINGS (CONT.)" : "";
      $("board-home-score").textContent = "#" + rank;
      $("board-away-score").textContent = String(entries.length);
      $("board-score-label").textContent = "YOUR RANK OF";
    } else {
      const ctf = this.network.connected && mode === "ctf";
      $("board-home-title").textContent = "YOUR TEAM";
      $("board-away-title").textContent = "ENEMY TEAM";
      $("board-home-score").textContent = String(
        ctf ? this.network.captures[this.network.team] : homeKills,
      );
      $("board-away-score").textContent = String(
        ctf ? this.network.captures[1 - this.network.team] : awayKills,
      );
      $("board-score-label").textContent = ctf ? "CAPTURES" : "ELIMINATIONS";
    }
  }
  private renderShop(): void {
    $("shop-wallet").textContent =
      this.profile.coins.toLocaleString() +
      " COINS  /  " +
      this.profile.xp.toLocaleString() +
      " XP  /  " +
      TIERS[this.profile.tier] +
      " · " +
      this.profile.games +
      " GAMES";
    if (!this.profile.storageAvailable)
      $("shop-status").textContent =
        "Browser storage is unavailable. Progress lasts only for this session.";
    document
      .querySelectorAll<HTMLButtonElement>("[data-shop-filter]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.shopFilter === this.shopFilter),
        ),
      );
    // The shop sells unowned items; the locker holds owned ones.
    // Kinds: 0 weapon, 1 outfit, 2 kill effect, 3 victory dance.
    const pr = this.profile,
      ownedMask = [pr.owned, pr.skins, pr.effects, pr.dances],
      equippedId = [pr.weapon, pr.skin, pr.effect, pr.dance],
      ids: number[][] = [
        [...FIREARM_IDS],
        SKINS.map((_, i) => i),
        KILL_EFFECTS.map((_, i) => i),
        DANCES.map((_, i) => i),
      ],
      filters = ["weapons", "outfits", "effects", "dances"],
      counts = ids.map(
        (list, kind) =>
          list.filter((id) => !!(ownedMask[kind] & (1 << id)) === this.lockerMode).length,
      );
    $("shop-count").textContent = String(counts.reduce((a, b) => a + b, 0));
    $("shop-count-weapons").textContent = String(counts[0]);
    $("shop-count-outfits").textContent = String(counts[1]);
    $("shop-count-effects").textContent = String(counts[2]);
    $("shop-count-dances").textContent = String(counts[3]);
    const filterKind = filters.indexOf(this.shopFilter),
      shown = filterKind >= 0 ? counts[filterKind] : counts.reduce((a, b) => a + b, 0);
    $("shop-empty").hidden = shown > 0;
    $("shop-empty").textContent = this.lockerMode
      ? "Nothing here yet. Unlock items in the Shop."
      : "You own everything in this category. Equip it from your Locker.";
    const list = $("shop-items");
    list.replaceChildren();
    const card = (id: number, kind: number) => {
      const gun = kind === 0,
        info =
          kind === 0
            ? WEAPONS[id]
            : kind === 1
              ? SKINS[id]
              : kind === 2
                ? KILL_EFFECTS[id]
                : DANCES[id],
        owned = !!(ownedMask[kind] & (1 << id)),
        equipped = equippedId[kind] === id;
      if (owned !== this.lockerMode) return;
      const row = document.createElement("article");
      row.className = "shop-row shop-item" + (equipped ? " is-equipped" : "");
      row.style.setProperty(
        "--item-accent",
        kind === 0
          ? id === 0
            ? "#d9f877"
            : id === 2
              ? "#e5b67b"
              : "#8ed8e9"
          : kind === 1
            ? SKINS[id].color
            : kind === 2
              ? KILL_EFFECTS[id].color
              : "#d9f877",
      );
      const visual = document.createElement("div");
      visual.className = "item-visual";
      const tag = document.createElement("span");
      tag.className = "item-type";
      tag.textContent =
        kind === 0
          ? WEAPON_RARITY[id] + " · " + WEAPON_TAGS[id]
          : kind === 1
            ? "COSMETIC · OUTFIT"
            : kind === 2
              ? "COSMETIC · KILL EFFECT"
              : "COSMETIC · VICTORY DANCE";
      const state = document.createElement("span");
      state.className = "item-state";
      state.textContent = equipped ? "✓ EQUIPPED" : owned ? "OWNED" : "UNLOCK";
      const img = document.createElement("img");
      const asset =
        kind === 0
          ? WEAPON_ASSETS[id]
          : kind === 1
            ? SKIN_ASSETS[id]
            : kind === 2
              ? KILL_EFFECTS[id].asset
              : DANCES[id].asset;
      img.src = "/items/" + asset + ".svg";
      img.alt =
        kind === 0
          ? info.name + " weapon illustration"
          : kind === 1
            ? info.name + " tactical outfit preview"
            : kind === 2
              ? info.name + " elimination effect preview"
              : info.name + " victory dance pose";
      img.width = 480;
      img.height = 280;
      img.loading = "lazy";
      visual.append(tag, state, img);
      const content = document.createElement("div");
      content.className = "item-content";
      const title = document.createElement("h3");
      title.textContent = info.name + (kind === 1 ? " OUTFIT" : "");
      const detail = document.createElement("p");
      detail.className = "item-description";
      detail.textContent =
        kind === 0
          ? id === 0
            ? "Dependable. Versatile. Ready for anything."
            : id === 2
              ? "Get close. Make every shot count."
              : id === 4
                ? "Fast bursts. Keep the fight close."
                : id === 5
                  ? "Controlled fire. Reach further."
                  : "A steady hand goes a long way."
          : kind === 1
            ? id === 0
              ? "Made for the untamed wilderness."
              : id === 1
                ? "A cooler head in the heat of battle."
                : id === 2
                  ? "Leave a little fire in your wake."
                  : id === 3
                    ? "Quiet colors. Sharp instincts."
                    : "A little color on the frontier."
            : kind === 2
              ? "Bursts where your opponent falls. Shown on your eliminations."
              : "Plays automatically on the victory screen when you win.";
      const stats = document.createElement("div");
      stats.className = "item-stats";
      if (gun) {
        const spec = WEAPONS[id];
        stats.innerHTML =
          "<span>DAMAGE <b>" +
          spec.damage +
          "</b></span><span>RANGE <b>" +
          spec.range +
          "</b></span><span>MAG <b>" +
          spec.magazine +
          "</b></span>";
      } else {
        const swatch = document.createElement("i");
        swatch.style.background =
          kind === 1 ? SKINS[id].color : kind === 2 ? KILL_EFFECTS[id].color : "#d9f877";
        stats.append(swatch);
        const note = document.createElement("span");
        note.textContent = "COSMETIC · NO STAT CHANGES";
        stats.append(note);
      }
      const footer = document.createElement("div");
      footer.className = "item-footer";
      const price = document.createElement("div");
      price.className = "item-price";
      price.textContent = owned ? "IN YOUR LOCKER" : "◇ " + info.cost;
      const sub = document.createElement("small");
      sub.textContent = owned ? "Ready to equip" : "COINS · ONE-TIME UNLOCK";
      price.append(sub);
      const button = document.createElement("button");
      const affordable = pr.coins >= info.cost;
      button.textContent = equipped ? "EQUIPPED" : owned ? "EQUIP" : "UNLOCK ↗";
      button.disabled = equipped || (!owned && !affordable);
      button.title =
        !owned && !affordable
          ? "Earn " + (info.cost - pr.coins) + " more coins"
          : gun
            ? "Equip for your next match"
            : "Equip this item";
      button.addEventListener("click", () => {
        const success =
          kind === 0
            ? pr.buyWeapon(id)
            : kind === 1
              ? pr.buySkin(id)
              : pr.buyCosmetic(kind === 2 ? "effect" : "dance", id);
        $("shop-status").textContent = !success
          ? "Not enough coins yet. Keep playing."
          : this.lockerMode
            ? gun
              ? "Loadout saved for next match."
              : info.name + " equipped."
            : info.name + " unlocked and equipped. Find it in your Locker.";
        this.renderShop();
      });
      footer.append(price, button);
      content.append(title, detail, stats, footer);
      row.append(visual, content);
      list.append(row);
    };
    for (let kind = 0; kind < 4; kind++)
      if (filterKind < 0 || filterKind === kind)
        for (const id of ids[kind]) card(id, kind);
  }
  private enterGame(): void {
    this.started = true;
    let seen = "";
    try {
      seen = localStorage.getItem("wildline.tutorial.v1") || "";
    } catch {
      seen = "done"; // storage blocked: do not nag every round
    }
    if (seen !== "done") this.startTutorial();
    $("player-callsign").textContent = (
      ($("callsign") as HTMLInputElement).value || "Player"
    ).toUpperCase();
    $("start-screen").hidden = true;
    document.body.classList.add("playing");
    if (this.network.connected) this.network.enterMatch();
    this.setPaused(false);
  }
  private openParty(): void {
    this.partyWasPaused = this.paused;
    this.paused = true;
    this.input.clear();
    $("pause-screen").hidden = true;
    $("party-screen").hidden = false;
    this.setPartyStep(this.network.connected ? "connected" : "choice");
    $(this.network.connected ? "party-play" : "choose-create").focus();
  }
  private closeParty(): void {
    if (!this.network.connected) {
      this.quickPublic = false;
      this.network.disconnect();
    }
    $("party-screen").hidden = true;
    this.setPaused(this.started && this.partyWasPaused);
  }
  private setPartyStep(step: "choice" | "create" | "join" | "connected"): void {
    if (!this.network.connecting)
      for (const id of ["create-party", "join-room", "find-public"])
        ($(id) as HTMLButtonElement).disabled = false;
    $("party-choices").hidden = step !== "choice";
    $("multiplayer-form").hidden = step !== "create" && step !== "join";
    $("party-create-fields").hidden = step !== "create";
    $("party-join-fields").hidden = step !== "join";
    $("party-connected").hidden = step !== "connected";
    ($("room") as HTMLInputElement).required = step === "join";
    $("party-step").textContent =
      step === "create" ? "02 / CREATE YOUR PARTY" : "02 / FIND YOUR PEOPLE";
    if (step === "choice")
      $("connection-status").textContent =
        "Choose Create or Join to get started.";
    if (step === "create" || step === "join") $("callsign").focus();
  }
  private connectParty(
    code: string,
    create = false,
    matchmaking = false,
  ): void {
    if (!($("callsign") as HTMLInputElement).reportValidity()) return;
    if (!/^[-a-zA-Z0-9_]{1,24}$/.test(code)) {
      $("connection-status").textContent = "Enter a valid party code.";
      return;
    }
    this.autoEnter = matchmaking;
    // A dedicated ws server is optional; without one, players host in-browser (P2P).
    const endpoint = import.meta.env.VITE_MULTIPLAYER_URL || "";
    if (endpoint) {
      this.paused = true;
      this.joinWith(endpoint, code, create, matchmaking, null);
      return;
    }
    if (this.p2pPending) return;
    this.paused = true;
    void this.connectPeer(code, create, matchmaking);
  }
  private p2pPending = false;
  /**
   * Host migration: the successor (holding the latest authority backup) hosts
   * the same code from that backup; everyone else reconnects and reclaims
   * their slot. Falls back to the normal "connection lost" path on failure.
   */
  private async migrateHost(): Promise<void> {
    const net = this.network,
      generation = net.generation,
      code = net.room;
    this.notify("The host left · moving the match to a new host…");
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const takeOver = async () => {
        const backup = net.backup as { token?: string },
          host = new HostSession(
            code,
            net.public,
            net.mode,
            this.profile.tier,
            typeof backup.token === "string" ? backup.token : undefined,
          );
        await host.start({ state: net.backup, edits: this.world.exportEdits() });
        if (generation !== net.generation) {
          host.stop();
          return;
        }
        net.resume(() => host.local);
      };
      if (net.successor && net.backup) {
        await takeOver();
        return;
      }
      // Give the successor a moment to come up, then reconnect to the same code.
      for (let attempt = 0; attempt < 10; attempt++) {
        await wait(attempt ? 1500 : 2500);
        if (generation !== net.generation) return;
        try {
          const socket = await connectRoom(code, 6000);
          if (generation !== net.generation) {
            socket.close();
            return;
          }
          net.resume(() => socket);
          return;
        } catch {
          // The new host is not listening yet; retry. As a last resort, any client
          // holding a (possibly older) backup takes over so the match survives.
          if (attempt === 4 && net.backup) {
            await takeOver();
            return;
          }
        }
      }
    } catch {
      // Fall through to a clean disconnect.
    }
    if (generation === net.generation) {
      net.disconnect();
      this.notify("The host left and the match could not continue.");
    }
  }
  /** Find/host/join a browser-hosted room through /api/signal, then join it. */
  private async connectPeer(
    code: string,
    create: boolean,
    matchmaking: boolean,
  ): Promise<void> {
    const generation = this.network.generation;
    const status = (text: string) => {
      $("connection-status").textContent = text;
      if (this.quickPublic) $("matchmaking-status").textContent = text;
    };
    this.p2pPending = true;
    for (const id of ["create-party", "join-room", "find-public"])
      ($(id) as HTMLButtonElement).disabled = true;
    let host: HostSession | null = null;
    try {
      let room = code,
        hosting = create,
        joined: Socketish | null = null,
        isPublic =
          ($("party-visibility") as HTMLSelectElement).value === "public";
      if (matchmaking) {
        // Try up to three listed matches (skipping stale ones), else host a new one.
        const tried = this.quickPublic && this.lastPublicRoom ? [this.lastPublicRoom] : [];
        if (this.network.connected) tried.push(this.network.room);
        for (let attempt = 0; attempt < 3 && !joined; attempt++) {
          status(
            attempt
              ? "Trying another public match…"
              : "Finding a " + TIERS[this.profile.tier] + " match (" + this.profile.games + " games played)…",
          );
          const found = await findPublicRoom(tried, this.profile.tier);
          if (!found || generation !== this.network.generation) break;
          try {
            joined = await connectRoom(found);
            room = found;
          } catch {
            tried.push(found);
          }
        }
        if (!joined) {
          // No reachable public match: host one; bots fill it and others can join.
          const random = crypto.getRandomValues(new Uint32Array(1))[0];
          room = "P" + random.toString(36).toUpperCase().padStart(7, "0");
          hosting = true;
          isPublic = true;
        }
      } else if (!create) {
        status("Connecting to the host…");
        joined = await connectRoom(code);
      }
      if (hosting) {
        status("Opening your match…");
        host = new HostSession(
          room,
          isPublic,
          isPublic
            ? "teams"
            : validMode(($("game-mode") as HTMLSelectElement).value),
          this.profile.tier,
        );
        await host.start();
      }
      if (generation !== this.network.generation) {
        host?.stop();
        joined?.close();
        return;
      }
      const session = host,
        socket = joined;
      this.joinWith(
        "",
        room,
        hosting,
        matchmaking && !hosting,
        session ? () => session.local : () => socket!,
        isPublic,
      );
    } catch (error) {
      host?.stop();
      if (generation !== this.network.generation) return;
      if (this.quickPublic) this.startBotFallback();
      else
        status(
          error instanceof SignalError && error.status === 404
            ? "Party not found. The host may have left — check the code or create a new party."
            : error instanceof Error
              ? error.message
              : "Online play is unavailable right now.",
        );
    } finally {
      this.p2pPending = false;
      if (!this.network.connecting)
        for (const id of ["create-party", "join-room", "find-public"])
          ($(id) as HTMLButtonElement).disabled = false;
    }
  }
  private joinWith(
    endpoint: string,
    code: string,
    create: boolean,
    matchmaking: boolean,
    transport: (() => Socketish) | null,
    isPublic = ($("party-visibility") as HTMLSelectElement).value === "public",
  ): void {
    this.network.tier = this.profile.tier;
    try {
      this.network.connect(
        endpoint,
        code,
        ($("callsign") as HTMLInputElement).value,
        create || matchmaking
          ? freshSeed()
          : ($("seed") as HTMLInputElement).value,
        this.world.relief,
        this.world.enemyDensity,
        create,
        isPublic,
        matchmaking,
        this.profile.weapon,
        ($("infinite-ammo") as HTMLInputElement).checked,
        this.allowedMask(),
        this.profile.skin,
        matchmaking && this.quickPublic ? this.lastPublicRoom : "",
        ($("private-bots") as HTMLInputElement).checked,
        Number(($("bot-difficulty") as HTMLSelectElement).value),
        validMode(($("game-mode") as HTMLSelectElement).value),
        transport,
      );
    } catch (error) {
      $("connection-status").textContent =
        error instanceof Error ? error.message : "Could not join party.";
    }
  }
  private setOnlineControls(online: boolean): void {
    document
      .querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("#seed-form input,#seed-form select,#seed-form button")
      .forEach((el) => (el.disabled = online));
    $("restart").textContent = "RESTART EXPEDITION";
    $("online").textContent = online ? "PARTY ONLINE" : "PARTY";
    $("party-play").toggleAttribute("disabled", !online);
    $("leave-party").hidden = !online;
    $("join-room").textContent = "JOIN WITH CODE";
  }
  /** Dirt path on land; wooden bridge spans wherever it crosses water. */
  private drawTrail(ctx: CanvasRenderingContext2D): void {
    const start = Math.floor((this.cameraY - this.viewH / 2 - 100) / 80) * 80,
      end = this.cameraY + this.viewH / 2 + 100,
      w = this.world;
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      for (let y = start; y < end; y += 80) {
        const x0 = trailX(w.seed, y),
          x1 = trailX(w.seed, y + 80),
          wet =
            terrainHeight(w.seed, (x0 + x1) / 2, y + 40, w.relief) < -0.24;
        if (wet) continue;
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y + 80);
      }
      ctx.strokeStyle = pass === 0 ? "#a2a075" : pass === 1 ? "#b4ad80" : "#c3b98b33";
      ctx.lineWidth = pass === 0 ? 69 : pass === 1 ? 51 : 2;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    ctx.lineCap = "butt";
    for (let y = start; y < end; y += 80) {
      const x0 = trailX(w.seed, y),
        x1 = trailX(w.seed, y + 80);
      if (terrainHeight(w.seed, (x0 + x1) / 2, y + 40, w.relief) >= -0.24) continue;
      const a = Math.atan2(80, x1 - x0);
      ctx.save();
      ctx.translate(x0, y);
      ctx.rotate(a);
      ctx.fillStyle = "#1d3a3655";
      ctx.fillRect(4, -22, 84, 50);
      ctx.fillStyle = "#7a5a3a";
      ctx.fillRect(0, -26, 84, 52);
      ctx.fillStyle = "#946e48";
      for (let k = 2; k < 84; k += 10) ctx.fillRect(k, -24, 7, 48);
      ctx.fillStyle = "#5b4128";
      ctx.fillRect(0, -28, 84, 4);
      ctx.fillRect(0, 24, 84, 4);
      ctx.restore();
    }
  }
  private drawCamp(ctx: CanvasRenderingContext2D): void {
    if (this.campWet || !this.visible(this.campX, this.campY, 180)) return;
    ctx.save();
    ctx.translate(this.campX, this.campY);
    ctx.fillStyle = "#233a3155";
    ctx.fillRect(-50, -25, 146, 115);
    ctx.fillStyle = "#788073";
    ctx.fillRect(-76, 0, 148, 66);
    ctx.fillStyle = "#555c4d";
    ctx.fillRect(-72, -50, 144, 95);
    ctx.fillStyle = "#a99570";
    ctx.fillRect(-72, 40, 144, 15);
    ctx.fillStyle = "#6e5844";
    ctx.fillRect(-20, 40, 29, 24);
    ctx.fillStyle = "#334c42";
    ctx.beginPath();
    ctx.moveTo(-85, -48);
    ctx.lineTo(-5, -91);
    ctx.lineTo(83, -48);
    ctx.lineTo(83, 15);
    ctx.lineTo(-85, 15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#53715a";
    ctx.beginPath();
    ctx.moveTo(-85, -48);
    ctx.lineTo(-5, -91);
    ctx.lineTo(-5, -25);
    ctx.lineTo(-85, 15);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#8ba18355";
    ctx.lineWidth = 2;
    for (let x = -65; x < 80; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, -45);
      ctx.lineTo(x, 12);
      ctx.stroke();
    }
    ctx.fillStyle = "#d4b96b";
    ctx.fillRect(31, 39, 23, 13);
    ctx.fillStyle = "#354b36";
    ctx.fillRect(39, 39, 3, 13);
    ctx.fillStyle = "#81795a";
    ctx.fillRect(-90, 77, 180, 6);
    ctx.fillRect(-90, 101, 180, 6);
    for (let x = -90; x < 100; x += 45) {
      ctx.fillStyle = "#454d39";
      ctx.fillRect(x, 70, 5, 42);
    }
    ctx.restore();
  }
  private drawTree(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
  ): void {
    const size = 30 + r * 18;
    ctx.fillStyle = "#65553c";
    ctx.fillRect(x - 5, y - 22, 10, 28);
    ctx.fillStyle = "#294f37";
    ctx.beginPath();
    ctx.arc(x, y - 30, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TREE[(r * 3) | 0];
    ctx.beginPath();
    ctx.arc(x - 8, y - 43, size * 0.82, 0, Math.PI * 2);
    ctx.arc(x + size * 0.4, y - 34, size * 0.66, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#87a25b44";
    ctx.beginPath();
    ctx.arc(x - 12, y - 52, size * 0.47, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#b1c17c24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x - 8, y - 43, size * 0.81, 3.5, 5.2);
    ctx.stroke();
  }
  private drawRock(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = "#63766b";
    ctx.beginPath();
    ctx.moveTo(x - 27, y + 7);
    ctx.lineTo(x - 23, y - 14);
    ctx.lineTo(x - 7, y - 26);
    ctx.lineTo(x + 18, y - 20);
    ctx.lineTo(x + 27, y + 2);
    ctx.lineTo(x + 14, y + 13);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#9ba68a";
    ctx.beginPath();
    ctx.moveTo(x - 23, y - 14);
    ctx.lineTo(x - 7, y - 26);
    ctx.lineTo(x + 18, y - 20);
    ctx.lineTo(x + 9, y - 6);
    ctx.lineTo(x - 8, y - 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#82937b";
    ctx.beginPath();
    ctx.moveTo(x - 23, y - 14);
    ctx.lineTo(x - 8, y - 2);
    ctx.lineTo(x - 3, y + 12);
    ctx.lineTo(x - 27, y + 7);
    ctx.closePath();
    ctx.fill();
  }
  /** Victory stage (wins only) → top-3 podium → results screen. */
  private startFinale(won: boolean): void {
    const top = this.standings().slice(0, 3),
      places = document.querySelectorAll<HTMLElement>(".podium .place"),
      order = [1, 0, 2]; // visual order: second, first, third
    places.forEach((place, slot) => {
      const e = top[order[slot]];
      place.hidden = !e;
      if (!e) return;
      (place.querySelector("i") as HTMLElement).style.background = e.color;
      place.querySelector("b")!.textContent = e.name + (e.you ? " · YOU" : "");
      place.querySelector("span")!.textContent = e.kills + " ELIMINATIONS";
      place.classList.toggle("you", e.you);
    });
    $("finale-sub").textContent = $("result-label").textContent ?? "";
    $("finale-dance").hidden = !won;
    $("finale-podium").hidden = won;
    $("finale-screen").hidden = false;
    this.finalePhase = won ? 1 : 2;
    this.finaleClock = 0;
  }
  private advanceFinale(dt: number, skip = false): void {
    this.finaleClock += dt;
    if (this.finalePhase === 1 && (skip || this.finaleClock > 5)) {
      this.finalePhase = 2;
      this.finaleClock = 0;
      $("finale-dance").hidden = true;
      $("finale-podium").hidden = false;
    } else if (this.finalePhase === 2 && (skip || this.finaleClock > 4.5)) this.endFinale();
  }
  private endFinale(): void {
    if (!this.finalePhase) return;
    this.finalePhase = 0;
    $("finale-screen").hidden = true;
    if (!this.matchFinished) return;
    $("result-screen").hidden = false;
    $("result-again").focus();
  }
  /** Looping victory dance of the player's outfit on the win screen. */
  private drawDance(dt: number): void {
    const stage = this.finalePhase === 1;
    if (!stage && $("result-screen").hidden) {
      if (!this.finalePhase) this.dancing = false;
      return;
    }
    const c = stage
      ? (this.finaleCtx ??= ($("finale-canvas") as HTMLCanvasElement).getContext("2d"))
      : (this.danceCtx ??= ($("victory-dance") as HTMLCanvasElement).getContext("2d"));
    if (!c) return;
    const t = (this.danceClock += dt),
      zoom = stage ? 1.5 : 1;
    c.setTransform(zoom, 0, 0, zoom, 0, 0);
    c.clearRect(0, 0, 240, 200);
    c.fillStyle = "#d9f87722";
    c.beginPath();
    c.arc(120, 112, 70 + Math.sin(t * 3) * 4, 0, Math.PI * 2);
    c.fill();
    // Confetti: positions derived from time, no per-frame storage.
    for (let k = 0; k < 24; k++) {
      const fall = (t * (40 + (k % 5) * 12) + k * 37) % 220,
        x = (k * 53 + Math.sin(t * 2 + k) * 14) % 240;
      c.fillStyle = k % 3 === 0 ? "#ffd65a" : k % 3 === 1 ? "#7fd3e6" : "#f0a36c";
      c.fillRect(x, fall - 20, 5, 9);
    }
    // 0 Victory Spin, 1 Hop Party, 2 Axe Salute, 3 Side Shuffle, 4 Breakdown.
    const move = this.danceMove,
      hop =
        move === 1
          ? -Math.abs(Math.sin(t * 6)) * 16
          : move === 4
            ? -Math.abs(Math.sin(t * 9)) * 8
            : 0,
      slide = move === 3 ? Math.sin(t * 5) * 34 : 0,
      angle =
        move === 0
          ? t * 5
          : move === 1
            ? -Math.PI / 2 + Math.sin(t * 6) * 0.35
            : move === 2
              ? -Math.PI / 2 + Math.sin(t * 4) * 0.7
              : move === 3
                ? (Math.cos(t * 5) > 0 ? 0 : Math.PI) + Math.sin(t * 10) * 0.2
                : t * 11,
      squash = move === 4 ? 1 + Math.sin(t * 18) * 0.12 : 1,
      swing = this.swing;
    if (move === 2) this.swing = 0.1 + Math.sin(t * 8) * 0.06;
    c.translate(120 + slide, 120 + hop);
    c.scale(2.4 * squash, 2.4 / squash);
    this.drawActor(c, 0, 0, angle, false, false, 1, -1, move === 2, this.player.gun);
    this.swing = swing;
  }
  private damageNumber(x: number, y: number, damage: number): void {
    const i = this.dnCursor++ % 16;
    this.dnX[i] = x + (hash(this.world.seed, this.dnCursor, 7) - 0.5) * 24;
    this.dnY[i] = y - 30;
    this.dnAge[i] = 0;
    this.dnValue[i] = Math.min(200, Math.round(damage));
  }
  private drawDamageNumbers(ctx: CanvasRenderingContext2D, dt: number): void {
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#10251d";
    for (let i = 0; i < 16; i++) {
      const age = (this.dnAge[i] += dt);
      if (age > 0.8) continue;
      const big = this.dnValue[i] >= 50;
      ctx.globalAlpha = 1 - age / 0.8;
      ctx.font = big ? "900 20px sans-serif" : "800 15px sans-serif";
      ctx.fillStyle = big ? "#ffd65a" : "#ffffff";
      const y = this.dnY[i] - age * 50;
      ctx.strokeText(DAMAGE_TEXT[this.dnValue[i]], this.dnX[i], y);
      ctx.fillText(DAMAGE_TEXT[this.dnValue[i]], this.dnX[i], y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
  }
  private killEffect(x: number, y: number, local: boolean): void {
    const i = this.fxCursor++ % 8;
    this.fxX[i] = x;
    this.fxY[i] = y;
    this.fxAge[i] = 0;
    this.fxLocal[i] = local ? 1 : 0;
    this.fxStyle[i] = this.profile.effect;
    this.burst(x, y, local ? 12 : 8, 1);
    if (local) {
      // Coloured sparks in the equipped effect's colour and a short screen shake.
      this.burst(x, y, 26, 4);
      this.shake = 0.28;
    }
  }
  /** Elimination shockwave and rising label; drawn in world space, fixed slots. */
  private drawKillEffects(ctx: CanvasRenderingContext2D, dt: number): void {
    for (let i = 0; i < 8; i++) {
      const age = (this.fxAge[i] += dt);
      if (age > 1.1 || !this.visible(this.fxX[i], this.fxY[i], 140)) continue;
      const x = this.fxX[i],
        y = this.fxY[i],
        fade = 1 - age / 1.1,
        local = this.fxLocal[i] === 1,
        style = local ? this.fxStyle[i] : -1,
        color = style >= 0 ? KILL_EFFECTS[style].color : "#f0a36c",
        grow = 20 + age * 120;
      if (age < 0.14) {
        // Impact flash.
        ctx.globalAlpha = 1 - age / 0.14;
        ctx.fillStyle = local ? "#ffffff" : color;
        ctx.beginPath();
        ctx.arc(x, y, 18 + age * 160, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = fade;
      ctx.strokeStyle = color;
      ctx.lineWidth = 5 * fade + 1;
      ctx.beginPath();
      // Void Rift collapses inward; every other style expands.
      ctx.arc(x, y, style === 4 ? Math.max(4, 130 - age * 115) : grow, 0, Math.PI * 2);
      ctx.stroke();
      if (style === 1 || style === 2) {
        // Frost shards / ember tongues flying outward.
        ctx.fillStyle = style === 1 ? "#e8fbff" : "#ffcf5a";
        for (let k = 0; k < 10; k++) {
          const a = k * 0.628 + age * (style === 2 ? 2 : 0.3),
            r = grow * 0.9;
          ctx.fillRect(x + Math.cos(a) * r - 3, y + Math.sin(a) * r - (style === 2 ? 8 : 3), 6, style === 2 ? 12 : 6);
        }
      } else if (style === 3) {
        ctx.strokeStyle = "#4ff0ff";
        ctx.beginPath();
        ctx.arc(x, y, grow * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (local) {
        // Label pops in large, then settles and rises.
        const pop = age < 0.15 ? 1.6 - age * 4 : 1;
        ctx.save();
        ctx.translate(x, y - 44 - age * 40);
        ctx.scale(pop, pop);
        ctx.font = "900 20px sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#10251d";
        ctx.strokeText("ELIMINATED", 0, 0);
        ctx.fillStyle = style === 0 ? "#ffe9a3" : color;
        ctx.fillText("ELIMINATED", 0, 0);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }
  /** Dropped items: gun illustration with rarity glow, medkit, or ammo box. */
  private drawLoot(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    type: number,
    weapon: number,
    ammo: number,
  ): void {
    const pulse = 0.75 + Math.sin(this.matchTime * 4 + x * 0.01) * 0.25;
    if (type === 1) {
      const rarity = WEAPON_RARITY[weapon];
      ctx.fillStyle =
        rarity === "EPIC" ? "#b67cf2" : rarity === "RARE" ? "#5fb4f0" : "#b9d58a";
      ctx.globalAlpha = 0.28 * pulse;
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 36, 18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      const icon = this.gunIcons[weapon];
      if (icon && icon.complete && icon.naturalWidth > 0)
        ctx.drawImage(icon, x - 32, y - 20, 64, 37);
      else {
        ctx.fillStyle = "#263b32";
        ctx.fillRect(x - 16, y - 3, 32, 7);
      }
      return;
    }
    if (type === 2) {
      ctx.fillStyle = "#ff6b6b";
      ctx.globalAlpha = 0.25 * pulse;
      ctx.beginPath();
      ctx.ellipse(x, y + 3, 26, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f4f6f2";
      ctx.fillRect(x - 13, y - 11, 26, 20);
      ctx.strokeStyle = "#9aa39a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 13, y - 11, 26, 20);
      ctx.fillStyle = "#e0393e";
      ctx.fillRect(x - 3, y - 8, 6, 14);
      ctx.fillRect(x - 8, y - 4, 16, 6);
      ctx.font = "700 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffe3e3";
      ctx.fillText(MEDKIT_LABEL, x, y - 15);
      ctx.textAlign = "start";
      return;
    }
    if (ammo <= 0) return;
    ctx.fillStyle = "#4d5f3a";
    ctx.fillRect(x - 12, y - 8, 24, 15);
    ctx.fillStyle = "#e2c35c";
    for (let k = 0; k < 4; k++) ctx.fillRect(x - 9 + k * 5, y - 13, 3, 7);
    ctx.fillStyle = "#c9d88a";
    ctx.fillRect(x - 12, y - 2, 24, 2);
  }
  private drawChest(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.fillStyle = "#ffd65a33";
    ctx.beginPath();
    ctx.ellipse(x, y + 2, 34, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7a4a1f";
    ctx.fillRect(x - 18, y - 12, 36, 22);
    ctx.fillStyle = "#a8692c";
    ctx.beginPath();
    ctx.moveTo(x - 18, y - 12);
    ctx.quadraticCurveTo(x, y - 28, x + 18, y - 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f2c94c";
    ctx.fillRect(x - 18, y - 13, 36, 3);
    ctx.fillRect(x - 18, y + 2, 36, 3);
    ctx.fillRect(x - 3, y - 8, 6, 9);
    ctx.fillStyle = "#fff3b0";
    ctx.fillRect(x - 1, y - 5, 2, 3);
  }
  /** Point gem: a floating diamond worth points (no healing). */
  private drawCache(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const bob = Math.sin(this.matchTime * 3 + x * 0.05) * 3;
    ctx.fillStyle = "#defc7630";
    ctx.beginPath();
    ctx.ellipse(x, y + 6, 18, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#d9f877";
    ctx.beginPath();
    ctx.moveTo(x, y - 20 + bob);
    ctx.lineTo(x + 11, y - 7 + bob);
    ctx.lineTo(x, y + 4 + bob);
    ctx.lineTo(x - 11, y - 7 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f4ffd0";
    ctx.beginPath();
    ctx.moveTo(x, y - 20 + bob);
    ctx.lineTo(x + 4, y - 7 + bob);
    ctx.lineTo(x, y - 2 + bob);
    ctx.lineTo(x - 5, y - 9 + bob);
    ctx.closePath();
    ctx.fill();
  }
  private drawFlags(ctx: CanvasRenderingContext2D): void {
    const net = this.network;
    for (let t = 0; t < 2; t++) {
      const own = t === net.team,
        color = own ? "#7fd3e6" : "#f0a36c",
        bx = baseX(t);
      if (this.visible(bx, 0, 140)) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.setLineDash(own ? [] : [12, 8]);
        ctx.beginPath();
        ctx.arc(bx, 0, 120, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = own ? "#7fd3e622" : "#f0a36c22";
        ctx.fill();
      }
      const fx = net.flagX[t],
        fy = net.flagY[t];
      if (!this.visible(fx, fy, 60)) continue;
      ctx.fillStyle = "#1b2d26";
      ctx.fillRect(fx - 2, fy - 46, 4, 50);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(fx + 2, fy - 46);
      ctx.lineTo(fx + 30, fy - 36);
      ctx.lineTo(fx + 2, fy - 26);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#10251d";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  private drawActor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    enemy: boolean,
    hurt: boolean,
    variant = 1,
    outfit = -1,
    axe = false,
    gun = 0,
    stride = -1,
  ): void {
    ctx.fillStyle = "#183b3255";
    ctx.beginPath();
    ctx.ellipse(x + 5, y + 9, 18, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!enemy) {
      ctx.strokeStyle = "#e3f7a366";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y + 4, 23, 17, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // Feet swing while walking; a slight body bob sells the step.
    const swing = stride >= 0 ? Math.sin(stride) * 6 : 0;
    ctx.fillStyle = "#1f2f29";
    ctx.fillRect(-5 + swing, -12, 10, 6);
    ctx.fillRect(-5 - swing, 6, 10, 6);
    if (stride >= 0) {
      const bob = 1 + Math.abs(Math.cos(stride)) * 0.04;
      ctx.scale(bob, bob);
    }
    ctx.fillStyle =
      outfit >= 0
        ? (SKINS[outfit] ?? SKINS[0]).color
        : enemy
          ? variant === 0
            ? "#d1b46a"
            : variant === 1
              ? "#b78a6b"
              : "#9a799b"
          : SKINS[this.outfit].color;
    ctx.fillRect(-10, -12, 22, 24);
    ctx.fillStyle = enemy ? "#644b43" : "#294d45";
    ctx.fillRect(-15, -8, 9, 16);
    if (axe) {
      ctx.save();
      ctx.rotate(this.swing > 0 ? -0.8 + this.swing * 8 : 0.2);
      ctx.fillStyle = "#b48d60";
      ctx.fillRect(8, 7, 34, 5);
      ctx.fillStyle = "#e5ead2";
      ctx.beginPath();
      ctx.moveTo(31, -6);
      ctx.lineTo(46, -3);
      ctx.lineTo(43, 15);
      ctx.lineTo(31, 12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      const length = GUN_LENGTH[gun] || 23,
        width = GUN_WIDTH[gun] || 6;
      ctx.fillStyle = GUN_COLOR[gun] || GUN_COLOR[0];
      ctx.fillRect(4, 10 - width / 2, length, width);
      ctx.fillStyle = "#aeb8a0";
      ctx.fillRect(length - 3, 8.5, 9, 3);
      if (gun === 3 || gun === 5) {
        ctx.fillStyle = "#8ed8e9";
        ctx.fillRect(10, 5, 9, 3);
      } else if (gun === 4 || gun === 7) {
        ctx.fillStyle = "#151f1c";
        ctx.fillRect(12, 12, 4, 6);
      }
    }
    ctx.fillStyle = hurt ? "#f8c4a3" : enemy ? "#e4b38b" : "#dde1c3";
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = enemy ? "#704d3c" : "#527567";
    ctx.beginPath();
    ctx.arc(-2, -1, 8, 1.2, 4.9);
    ctx.fill();
    if (hurt) {
      // Hit flash.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-12, -13, 26, 26);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  private updateHUD(): void {
    const fps = this.frames / Math.max(0.001, this.elapsed),
      ms = (this.elapsed / Math.max(1, this.frames)) * 1000;
    this.samples[this.sample] = ms;
    this.sample = (this.sample + 1) % 80;
    this.ui.fps.textContent = Math.round(fps).toString();
    $("fps-small").textContent = Math.round(fps).toString();
    this.ui.frame.textContent = ms.toFixed(1) + " ms";
    this.frames = 0;
    this.elapsed = 0;
    this.ui.entities.textContent = (
      1 +
      this.enemies.count +
      this.projectiles.count +
      this.particles.count +
      this.allies.count +
      this.network.peers.count
    ).toString();
    this.ui.chunks.textContent = this.world.activeCount.toString();
    const p = this.player;
    const h = terrainHeight(this.world.seed, p.x, p.y, this.world.relief);
    const biome = biomeAt(this.world.seed, p.x, p.y);
    document.querySelector(".biome")!.textContent =
      h < -0.24
        ? biome === BIOME_SNOW
          ? "FROZEN LAKE"
          : biome === BIOME_DESERT
            ? "OASIS"
            : "WETLANDS"
        : biome === BIOME_SNOW
          ? "SNOWFIELDS"
          : biome === BIOME_DESERT
            ? "THE DUNES"
            : h > 0.4
              ? "THE HIGHLANDS"
              : "THE LOWLANDS";
    this.ui.coords.textContent =
      Math.round(p.x) + " E · " + Math.round(-p.y) + " N";
    this.ui.sector.textContent =
      Math.floor(p.x / CHUNK) + " : " + Math.floor(p.y / CHUNK);
    this.ui.health.textContent = Math.ceil(p.health) + " / 100";
    this.ui.healthFill.style.width = p.health + "%";
    this.ui.resources.textContent = p.supplies.toString();
    $("coin-balance").textContent = this.profile.coins.toString();
    this.profile.save();
    const unarmed = p.gun === UNARMED && this.input.weapon !== 1;
    $("ammo-label").textContent = unarmed
      ? "NO WEAPON · OPEN A CHEST"
      : this.input.weapon === 1
        ? "MELEE · NO AMMO NEEDED"
        : "AMMO · MAG / RESERVE";
    $("ammo-count").textContent = unarmed
      ? "AXE · " + p.reserve + " AMMO"
      : this.input.weapon === 1
        ? "AXE"
        : p.reloading > 0
          ? "RELOADING…"
          : this.network.connected && this.network.infiniteAmmo
            ? "∞ AMMO"
            : p.magazine + " / " + p.reserve;
    this.slots[0].querySelector("span:not([class])")!.textContent =
      p.gun === UNARMED ? "EMPTY" : WEAPONS[p.gun].name;
    if (this.slotIconGun !== p.gun) {
      this.slotIconGun = p.gun;
      const holder = this.slots[0].querySelector(".weapon-icon")!;
      if (p.gun === UNARMED) {
        holder.replaceChildren();
        holder.textContent = "✋";
      } else {
        this.slotIcon.src = "/items/" + WEAPON_ASSETS[p.gun] + ".svg";
        this.slotIcon.alt = WEAPONS[p.gun].name + " icon";
        holder.replaceChildren(this.slotIcon);
      }
      holder.classList.toggle("has-icon", p.gun !== UNARMED);
    }
    $("kills-count").textContent = p.kills.toString();
    $("stamina-fill").style.width = Math.round(p.stamina) + "%";
    // Opponents still standing; teammates are not counted.
    let enemiesLeft = 0;
    if (this.network.connected) {
      const peers = this.network.peers;
      for (let n = 0; n < peers.capacity; n++)
        if (peers.active[n] && peers.life[n] > 0 && !this.network.ally(n))
          enemiesLeft++;
    } else enemiesLeft = this.enemies.count;
    $("players-left").textContent = String(enemiesLeft);
    const time = this.network.connected ? this.network.elapsed : this.matchTime;
    const radius = this.network.connected
      ? this.network.radius
      : stormRadius(this.matchTime, this.brMode);
    const mode = this.network.connected ? this.network.mode : this.practiceMode,
      left = Math.max(0, Math.ceil(timeLimit(mode) - time)),
      clock = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
    $("storm-status").textContent =
      Math.hypot(p.x, p.y) > radius
        ? "OUTSIDE ZONE · MOVE TO CENTER"
        : mode === "ffa"
          ? "FFA · FIRST TO " + FFA_KILL_TARGET + " · " + clock
          : mode === "ctf"
            ? "CTF · YOU " +
              this.network.captures[this.network.team] +
              " – " +
              this.network.captures[1 - this.network.team] +
              " THEM · TO " +
              CTF_CAPTURE_TARGET +
              " · " +
              clock
            : (mode === "br" ? "SOLO · " : "") +
              "STORM · " +
              Math.max(0, Math.ceil(stormEnd(this.brMode) - time)) +
              "s";
    this.updateSpectateBar();
    this.tutorialTick();
    const edge = Math.hypot(p.x, p.y) - radius;
    this.sound.ambient(
      biomeAt(this.world.seed, p.x, p.y),
      edge > 0 ? 1 : edge > -400 ? (edge + 400) / 800 : 0,
      this.started && !this.paused && !this.matchFinished,
    );
    $("cover-status").textContent =
      this.world.covered(p.x, p.y) && this.matchTime > this.revealUntil
        ? "HIDDEN IN COVER"
        : "";

    $("elevation").textContent =
      "ELEV " +
      Math.round(
        terrainHeight(this.world.seed, p.x, p.y, this.world.relief) * 180,
      ) +
      " m";
    this.ui.toast.style.opacity = this.toastClock > 0 ? "1" : "0";
    $("leaderboard-open").textContent =
      "LEADERBOARD · " +
      (this.network.connected
        ? this.network.humanCount + this.network.botCount
        : 1 + this.enemySpawned + (this.alliesInitialized ? 3 : 0));
    for (let n = 0; n < this.slots.length; n++)
      this.slots[n].classList.toggle("selected", n === this.input.weapon);
    this.drawMini();
    const now = performance.now();
    for (let n = 0; n < 4; n++)
      if (!this.feedRows[n].hidden && this.feedUntil[n] < now)
        this.feedRows[n].hidden = true;
    if (!$("leaderboard-screen").hidden) this.drawLeaderboard();
    if (
      document.body.classList.contains("dev-mode") &&
      !document.body.classList.contains("debug-hidden")
    )
      this.drawGraph();
  }
  private drawGraph(): void {
    const c = this.graph;
    c.clearRect(0, 0, 220, 28);
    c.strokeStyle = "#d9f877";
    c.lineWidth = 1;
    c.beginPath();
    for (let n = 0; n < 80; n++) {
      const y = 27 - Math.min(26, this.samples[(this.sample + n) % 80] * 0.65);
      if (n === 0) c.moveTo(0, y);
      else c.lineTo((n * 220) / 79, y);
    }
    c.stroke();
    c.strokeStyle = "#d9f87722";
    c.beginPath();
    c.moveTo(0, 16);
    c.lineTo(220, 16);
    c.stroke();
  }
  private drawMini(): void {
    const c = this.mini,
      p = this.player;
    const zoom = this.mapExpanded
        ? 75 / (this.brMode ? BR_START_RADIUS : STORM_START_RADIUS)
        : 0.075,
      centerX = this.mapExpanded ? 0 : p.x,
      centerY = this.mapExpanded ? 0 : p.y;
    c.fillStyle = "#294e3e";
    c.fillRect(0, 0, 160, 160);
    if (this.mapExpanded) {
      if (
        this.mapTerrainSeed !== this.world.seed ||
        this.mapTerrainRelief !== this.world.relief ||
        this.mapTerrainZoom !== zoom
      ) {
        this.mapTerrainZoom = zoom;
        this.mapTerrain.width = this.mapTerrain.height = 160;
        const m = this.mapTerrain.getContext("2d")!;
        for (let y = 0; y < 160; y += 4)
          for (let x = 0; x < 160; x += 4) {
            const h = terrainHeight(
              this.world.seed,
              (x - 80) / zoom,
              (y - 80) / zoom,
              this.world.relief,
            );
            m.fillStyle =
              TERRAIN[
                terrainIndex(
                  this.world.seed,
                  (x - 80) / zoom,
                  (y - 80) / zoom,
                  h,
                )
              ];
            m.fillRect(x, y, 4, 4);
          }
        this.mapTerrainSeed = this.world.seed;
        this.mapTerrainRelief = this.world.relief;
      }
      c.drawImage(this.mapTerrain, 0, 0);
    } else {
      for (let k = 0; k < this.world.capacity; k++) {
        const chunk = this.world.chunks[k];
        if (!chunk.active) continue;
        for (let j = 0; j < CELLS * CELLS; j++) {
          const x =
              80 + (chunk.x * CHUNK + (j % CELLS) * TILE - centerX) * zoom,
            y =
              80 +
              (chunk.y * CHUNK + Math.floor(j / CELLS) * TILE - centerY) * zoom;
          c.fillStyle = TERRAIN[chunk.terrain[j]];
          c.fillRect(x, y, TILE * zoom + 0.4, TILE * zoom + 0.4);
        }
      }
    }
    c.strokeStyle = "#cfa7f4";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(
      80 - centerX * zoom,
      80 - centerY * zoom,
      (this.network.connected
        ? this.network.radius
        : stormRadius(this.matchTime, this.brMode)) * zoom,
      0,
      Math.PI * 2,
    );
    c.stroke();
    if (this.network.connected && this.network.mode === "ctf")
      for (let t = 0; t < 2; t++) {
        c.fillStyle = t === this.network.team ? "#7fd3e6" : "#f0a36c";
        c.fillRect(
          80 + (this.network.flagX[t] - centerX) * zoom - 3,
          80 + (this.network.flagY[t] - centerY) * zoom - 3,
          6,
          6,
        );
      }
    c.strokeStyle = "#e7efb322";
    c.lineWidth = 1;
    c.beginPath();
    for (let n = 0; n < 160; n += 40) {
      c.moveTo(n, 0);
      c.lineTo(n, 160);
      c.moveTo(0, n);
      c.lineTo(160, n);
    }
    c.stroke();
    c.fillStyle = "#79d9ee";
    const e = this.network.connected ? this.network.peers : this.allies;
    for (let n = 0; n < e.capacity; n++)
      if (
        e.active[n] &&
        e.life[n] > 0 &&
        (!this.network.connected || this.network.ally(n))
      ) {
        c.fillRect(
          80 + (e.x[n] - centerX) * zoom - 1.5,
          80 + (e.y[n] - centerY) * zoom - 1.5,
          3,
          3,
        );
      }
    c.fillStyle = "#e9ffb0";
    c.save();
    c.translate(80 + (p.x - centerX) * zoom, 80 + (p.y - centerY) * zoom);
    c.rotate(p.angle);
    c.beginPath();
    c.moveTo(6, 0);
    c.lineTo(-4, -4);
    c.lineTo(-2, 0);
    c.lineTo(-4, 4);
    c.closePath();
    c.fill();
    c.restore();
  }
  notify(message: string): void {
    this.ui.toast.textContent = message;
    this.toastClock = 3;
  }
  setPaused(value: boolean): void {
    this.renderDirty = true;
    this.paused = value;
    if (value && this.network.connected && this.player.health > 0)
      $("pause-copy").textContent =
        "The room stays live while this menu is open.";
    document.body.classList.toggle("is-paused", value);
    this.accumulator = 0;
    this.input.clear();
    $("pause-screen").hidden = !value;
    $("pause").setAttribute("aria-label", value ? "Resume game" : "Pause game");
    if (value) $("resume").focus();
    else this.canvas.focus();
  }
  togglePause(): void {
    if (!$("matchmaking-screen").hidden) {
      this.returnToStart();
      return;
    }
    if (!$("leaderboard-screen").hidden) {
      this.toggleLeaderboard();
      return;
    }
    if (this.mapExpanded) {
      this.toggleMap();
      return;
    }
    if (!$("shop-screen").hidden) {
      $("shop-close").click();
      return;
    }
    if (!$("result-screen").hidden) return;
    if (!$("party-screen").hidden) {
      this.closeParty();
      return;
    }
    if (!this.started || this.player.health <= 0) return;
    this.setPaused(!this.paused);
  }
  reset(seed: string): void {
    ($("seed") as HTMLInputElement).value = seed;
    this.input.weapon = 0;
    this.input.clear();
    const relief = Number(($("relief") as HTMLSelectElement).value);
    const enemies = Number(($("enemy-density") as HTMLSelectElement).value);
    this.world.reset(seed, relief, enemies);
    this.ground.invalidate();
    this.campY = -220 - hash(this.world.seed, 91, 2) * 500;
    this.campX = trailX(this.world.seed, this.campY) + 150;
    this.campWet =
      terrainHeight(this.world.seed, this.campX, this.campY, this.world.relief) < -0.12;
    this.player.reset();
    this.allyKills.fill(0);
    this.enemies.kills.fill(0);
    this.enemies.hitAt.fill(-1e9);
    this.spectateTarget = -1;
    this.projectileOwner.fill(-1);
    this.feedUntil.fill(0);
    for (const row of this.feedRows) row.hidden = true;
    $("leaderboard-screen").hidden = true;
    this.outfit = this.profile.skin;
    // Battle royale ignores the Locker weapon: start with the axe and loot chests.
    this.player.gun = this.brMode ? UNARMED : this.profile.weapon;
    this.player.magazine = WEAPONS[this.player.gun].magazine;
    this.player.reserve = WEAPONS[this.player.gun].reserve;
    this.loot.clear();
    this.previousHealth = 100;
    this.muzzle = 0;
    this.hitMarker = 0;
    if (this.mapExpanded) this.toggleMap();
    this.matchTime = 0;
    this.revealUntil = 0;
    this.matchFinished = false;
    this.enemySpawned = 0;
    this.autoClock = 0;
    $("result-screen").hidden = true;
    this.finalePhase = 0;
    $("finale-screen").hidden = true;
    $("result-status").textContent = "";
    this.ui.toast.textContent = "";
    this.toastClock = 0;

    this.allies.clear();
    this.alliesInitialized = false;
    this.projectiles.clear();
    this.particles.clear();
    this.enemies.clear();
    this.cameraX = this.cameraY = 0;
    this.effectSerial = 0;
    this.swing = 0;
    document.querySelector(".pause-card h2")!.textContent = "Frontier on hold.";
    $("pause-copy").textContent = "Your wilderness will be right here.";
    $("resume").textContent = "BACK TO THE FIELD ↗";
    this.setPaused(false);
    this.world.sync(0, 0, this.viewW, this.viewH);
    this.renderDirty = true;
  }
}
