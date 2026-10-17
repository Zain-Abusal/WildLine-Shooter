import { WEAPONS, validWeapon, FIREARM_MASK } from "./combat";
export const SKINS = [
  { name: "RANGER", color: "#9db4a0", cost: 0 },
  { name: "AZURE", color: "#67cce5", cost: 150 },
  { name: "EMBER", color: "#e99c67", cost: 150 },
  { name: "GHOST", color: "#dce3dc", cost: 225 },
  { name: "ORCHID", color: "#bb9cd9", cost: 225 },
  { name: "MOSS", color: "#86a56a", cost: 275 },
  { name: "SUNSET", color: "#e4be67", cost: 275 },
] as const;
export const SKIN_ASSETS = [
  "ranger",
  "azure",
  "ember",
  "ghost",
  "orchid",
  "moss",
  "sunset",
];
/** Cosmetic kill effects (shown on your eliminations) and victory dances (played when you win). */
export const KILL_EFFECTS = [
  { name: "GOLD BURST", color: "#ffd65a", cost: 0, asset: "fx-gold" },
  { name: "FROST SHATTER", color: "#9fe3ff", cost: 200, asset: "fx-frost" },
  { name: "EMBER BLAZE", color: "#ff8a3d", cost: 250, asset: "fx-ember" },
  { name: "NEON PULSE", color: "#ff5ce1", cost: 300, asset: "fx-neon" },
  { name: "VOID RIFT", color: "#a07bff", cost: 400, asset: "fx-void" },
] as const;
export const DANCES = [
  { name: "VICTORY SPIN", cost: 0, asset: "dance-spin" },
  { name: "HOP PARTY", cost: 200, asset: "dance-hop" },
  { name: "AXE SALUTE", cost: 250, asset: "dance-salute" },
  { name: "SIDE SHUFFLE", cost: 300, asset: "dance-shuffle" },
  { name: "BREAKDOWN", cost: 450, asset: "dance-breakdown" },
] as const;
/** Matchmaking brackets by games played on this device. */
export const TIERS = ["ROOKIE", "REGULAR", "VETERAN", "ELITE"] as const;
export function tierFor(games: number): number {
  return games >= 60 ? 3 : games >= 20 ? 2 : games >= 5 ? 1 : 0;
}
/** Public bot difficulty per bracket (Rookies face gentler bots). */
export const TIER_DIFFICULTY = [0.8, 1, 1.15, 1.3];
export class Profile {
  coins = 0;
  xp = 0;
  owned = 1;
  skins = 1;
  skin = 0;
  weapon = 0;
  games = 0;
  wins = 0;
  effects = 1;
  effect = 0;
  dances = 1;
  dance = 0;
  dirty = false;
  storageAvailable = true;
  constructor(private storage: Pick<Storage, "getItem" | "setItem"> | null) {
    try {
      const raw = storage?.getItem("wildline.profile.v1");
      if (raw) {
        const p = JSON.parse(raw);
        this.coins = this.amount(p.coins);
        this.xp = this.amount(p.xp);
        this.owned = (this.amount(p.owned) & FIREARM_MASK) | 1;
        this.skins = (this.amount(p.skins) & ((1 << SKINS.length) - 1)) | 1;
        this.skin =
          Number.isInteger(p.skin) &&
          p.skin >= 0 &&
          p.skin < SKINS.length &&
          this.skins & (1 << p.skin)
            ? p.skin
            : 0;
        this.weapon =
          validWeapon(p.weapon) && this.owned & (1 << p.weapon) ? p.weapon : 0;
        this.games = this.amount(p.games);
        this.effects = (this.amount(p.effects) & ((1 << KILL_EFFECTS.length) - 1)) | 1;
        this.effect = this.pick(p.effect, KILL_EFFECTS.length, this.effects);
        this.dances = (this.amount(p.dances) & ((1 << DANCES.length) - 1)) | 1;
        this.dance = this.pick(p.dance, DANCES.length, this.dances);
        this.wins = Math.min(this.games, this.amount(p.wins));
      }
    } catch {
      this.storageAvailable = false;
    }
  }
  /** A valid, owned cosmetic index, else the free default. */
  private pick(v: unknown, length: number, owned: number): number {
    return Number.isInteger(v) && (v as number) >= 0 && (v as number) < length && owned & (1 << (v as number))
      ? (v as number)
      : 0;
  }
  private amount(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v)
      ? Math.max(0, Math.min(99999999, Math.floor(v)))
      : 0;
  }
  reward(coins: number, xp: number): void {
    this.coins = this.amount(this.coins + coins);
    this.xp = this.amount(this.xp + xp);
    this.dirty = true;
  }
  get tier(): number {
    return tierFor(this.games);
  }
  /** Called once per finished round (any mode, online or offline). */
  recordGame(won: boolean): void {
    this.games = this.amount(this.games + 1);
    if (won) this.wins = this.amount(this.wins + 1);
    this.dirty = true;
  }
  buyWeapon(id: number): boolean {
    if (!validWeapon(id)) return false;
    const bit = 1 << id;
    if (!(this.owned & bit)) {
      if (this.coins < WEAPONS[id].cost) return false;
      this.coins -= WEAPONS[id].cost;
      this.owned |= bit;
    }
    this.weapon = id;
    this.dirty = true;
    this.save();
    return true;
  }
  /** Unlock (if affordable) and equip a kill effect or victory dance. */
  buyCosmetic(kind: "effect" | "dance", id: number): boolean {
    const list = kind === "effect" ? KILL_EFFECTS : DANCES;
    if (!Number.isInteger(id) || id < 0 || id >= list.length) return false;
    const bit = 1 << id,
      owned = kind === "effect" ? this.effects : this.dances;
    if (!(owned & bit)) {
      if (this.coins < list[id].cost) return false;
      this.coins -= list[id].cost;
      if (kind === "effect") this.effects |= bit;
      else this.dances |= bit;
    }
    if (kind === "effect") this.effect = id;
    else this.dance = id;
    this.dirty = true;
    this.save();
    return true;
  }
  buySkin(id: number): boolean {
    if (!Number.isInteger(id) || id < 0 || id >= SKINS.length) return false;
    const bit = 1 << id;
    if (!(this.skins & bit)) {
      if (this.coins < SKINS[id].cost) return false;
      this.coins -= SKINS[id].cost;
      this.skins |= bit;
    }
    this.skin = id;
    this.dirty = true;
    this.save();
    return true;
  }
  save(): void {
    if (!this.dirty) return;
    try {
      if (this.storage)
        this.storage.setItem(
          "wildline.profile.v1",
          JSON.stringify({
            coins: this.coins,
            xp: this.xp,
            owned: this.owned,
            skins: this.skins,
            skin: this.skin,
            weapon: this.weapon,
            games: this.games,
            wins: this.wins,
            effects: this.effects,
            effect: this.effect,
            dances: this.dances,
            dance: this.dance,
          }),
        );
      else this.storageAvailable = false;
      this.dirty = false;
    } catch {
      this.storageAvailable = false;
      this.storage = null;
      this.dirty = false;
    }
  }
}
export function loadProfile(): Profile {
  try {
    return new Profile(localStorage);
  } catch {
    return new Profile(null);
  }
}
