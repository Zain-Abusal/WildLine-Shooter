/**
 * Player-style callsigns for guests who have not chosen one and for bots, so
 * lobbies read like real matches. pick(r) takes values in [0, 1): seeded hashes
 * offline, crypto randomness on the authority.
 */
const FIRST = [
  "Swift", "Night", "Frost", "Rogue", "Pixel", "Shadow", "Turbo", "Lucky",
  "Silent", "Crimson", "Neon", "Wild", "Iron", "Storm", "Cosmic", "Blaze",
  "Ghost", "Rapid", "Sneaky", "Golden", "Atomic", "Lunar", "Savage", "Clutch",
  "Toxic", "Hyper", "Mellow", "Dusty", "Frosty", "Spicy", "Sly", "Ember",
];
const SECOND = [
  "Fox", "Wolf", "Viper", "Falcon", "Panda", "Ninja", "Raven", "Tiger",
  "Otter", "Hawk", "Cobra", "Llama", "Moose", "Badger", "Shark", "Lynx",
  "Bandit", "Comet", "Sniper", "Rider", "Builder", "Nomad", "Ranger", "Pilot",
  "Gecko", "Yeti", "Kraken", "Mantis", "Bison", "Orca", "Goose", "Wizard",
];
const STYLES = 4;
export function playerName(a: number, b: number, c: number, d: number): string {
  const first = FIRST[Math.floor(a * FIRST.length) % FIRST.length],
    second = SECOND[Math.floor(b * SECOND.length) % SECOND.length],
    digits = Math.floor(c * 1000),
    style = Math.floor(d * STYLES) % STYLES;
  return style === 0
    ? first + second + digits
    : style === 1
      ? first + "_" + second
      : style === 2
        ? second + digits
        : first + second;
}
export function randomPlayerName(): string {
  const v = crypto.getRandomValues(new Uint32Array(4));
  return playerName(
    v[0] / 4294967296,
    v[1] / 4294967296,
    v[2] / 4294967296,
    v[3] / 4294967296,
  );
}
