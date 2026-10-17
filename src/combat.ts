export const WEAPONS = [
  {
    name: "CARBINE",
    range: 520,
    speed: 900,
    damage: 22,
    cooldown: 0.17,
    magazine: 24,
    reserve: 72,
    reload: 1.4,
    cost: 0,
  },
  {
    name: "AXE",
    range: 105,
    speed: 0,
    damage: 35,
    cooldown: 0.42,
    magazine: 0,
    reserve: 0,
    reload: 0,
    cost: 0,
  },
  {
    name: "BREACH SHOTGUN",
    range: 280,
    speed: 800,
    damage: 72,
    cooldown: 0.8,
    magazine: 6,
    reserve: 24,
    reload: 1.8,
    cost: 350,
  },
  {
    name: "LONGSHOT",
    range: 1800,
    speed: 1500,
    damage: 95,
    cooldown: 1.25,
    magazine: 5,
    reserve: 15,
    reload: 2.2,
    cost: 700,
  },
  {
    name: "RAPID SMG",
    range: 340,
    speed: 1050,
    damage: 13,
    cooldown: 0.09,
    magazine: 32,
    reserve: 128,
    reload: 1.3,
    cost: 450,
  },
  {
    name: "MARKSMAN",
    range: 1050,
    speed: 1250,
    damage: 42,
    cooldown: 0.36,
    magazine: 12,
    reserve: 48,
    reload: 1.6,
    cost: 550,
  },
  {
    name: "SIDEKICK",
    range: 430,
    speed: 1050,
    damage: 24,
    cooldown: 0.24,
    magazine: 14,
    reserve: 70,
    reload: 1.1,
    cost: 200,
  },
  {
    name: "VANGUARD",
    range: 650,
    speed: 1100,
    damage: 30,
    cooldown: 0.2,
    magazine: 20,
    reserve: 80,
    reload: 1.7,
    cost: 800,
  },
] as const;
export const FIREARM_IDS = [0, 2, 3, 4, 5, 6, 7] as const;
export const FIREARM_MASK = FIREARM_IDS.reduce<number>(
  (mask, id) => mask | (1 << id),
  0,
);
export const WEAPON_ASSETS = [
  "carbine",
  "",
  "shotgun",
  "sniper",
  "smg",
  "marksman",
  "pistol",
  "vanguard",
];
export const WEAPON_TAGS = [
  "ASSAULT",
  "TOOL",
  "CLOSE QUARTERS",
  "PRECISION",
  "RAPID FIRE",
  "MID RANGE",
  "SIDEARM",
  "ASSAULT",
];
export const WEAPON_RARITY = [
  "STANDARD",
  "STANDARD",
  "RARE",
  "EPIC",
  "RARE",
  "RARE",
  "STANDARD",
  "EPIC",
];
export function validWeapon(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < WEAPONS.length && id !== 1;
}
export function firstWeapon(mask: number): number {
  for (let id = 0; id < WEAPONS.length; id++)
    if (id !== 1 && mask & (1 << id)) return id;
  return 0;
}
/** Match area: the storm starts at this radius, holds, then closes to zero. */
export const STORM_START_RADIUS = 3000;
export const STORM_HOLD = 30;
export const STORM_CLOSE = 330;
export const STORM_END = STORM_HOLD + STORM_CLOSE;
/** Window in which a player's hit earns the kill if a bot or the storm finishes the target. */
export const ASSIST_CREDIT_SECONDS = 6;
/**
 * Battle royale plays on a much larger island: wider zone, longer hold for
 * looting, longer close. Team Battle keeps the STORM_* timeline.
 */
export const BR_START_RADIUS = 7000;
export const BR_HOLD = 60;
export const BR_CLOSE = 600;
export const BR_END = BR_HOLD + BR_CLOSE;
export function stormRadius(seconds: number, br = false): number {
  const start = br ? BR_START_RADIUS : STORM_START_RADIUS,
    hold = br ? BR_HOLD : STORM_HOLD,
    close = br ? BR_CLOSE : STORM_CLOSE;
  if (seconds <= hold) return start;
  if (seconds >= hold + close) return 0;
  return Math.max(0, start * (1 - (seconds - hold) / close));
}
export function stormDamage(seconds: number, br = false): number {
  const end = br ? BR_END : STORM_END;
  return seconds > end - 60 ? 15 : seconds > end - 140 ? 9 : 5;
}
export function stormEnd(br = false): number {
  return br ? BR_END : STORM_END;
}

/** Battle royale loot: players start with only the axe and open chests. */
export const UNARMED = 1;
/** Medkits restore a fixed number of health points. */
export const MEDKIT_HEAL = 25;
/** Chance an eliminated combatant also drops a medkit. */
export const MEDKIT_DROP_CHANCE = 0.15;
export const CHEST_MEDKIT_CHANCE = 0.45;
/** Rarity-weighted firearm for a chest roll r in [0, 1). */
export function chestWeapon(r: number): number {
  // Sidekick 25%, carbine 22%, SMG 18%, shotgun 15%, marksman 10%, Vanguard 6%, longshot 4%.
  return r < 0.25
    ? 6
    : r < 0.47
      ? 0
      : r < 0.65
        ? 4
        : r < 0.8
          ? 2
          : r < 0.9
            ? 5
            : r < 0.96
              ? 7
              : 3;
}
/** Chest ammo: about two reloads for the rolled weapon. */
export function chestAmmo(weapon: number): number {
  return WEAPONS[weapon].magazine * 2;
}

/** Surface distance inside the axe's forward arc, shared by client and authority. */
export function axeReach(
  x: number,
  y: number,
  angle: number,
  tx: number,
  ty: number,
  radius = 18,
): number {
  const dx = tx - x,
    dy = ty - y,
    d = Math.hypot(dx, dy),
    surface = Math.max(0, d - radius);
  if (
    surface > WEAPONS[1].range ||
    (d > radius && (dx * Math.cos(angle) + dy * Math.sin(angle)) / d < 0.25)
  )
    return Infinity;
  return surface;
}
