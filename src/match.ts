/** Shared protocol limits: humans and bots consume the same participant slots. */
export const MAX_PARTICIPANTS = 30;
export const TEAM_SIZE = MAX_PARTICIPANTS / 2;

/**
 * Game modes. Public matchmaking always uses "teams"; the others are private-party options.
 * - teams: two sides of 15, shrinking storm, last team standing, final eliminations.
 * - br: battle royale, everyone hostile, shrinking storm, last one standing.
 * - ffa: free-for-all deathmatch with respawns, first to FFA_KILL_TARGET or most after the timer.
 * - ctf: two teams with respawns, first to CTF_CAPTURE_TARGET flag captures or most after the timer.
 */
export const GAME_MODES = ["teams", "br", "ffa", "ctf"] as const;
export type GameMode = (typeof GAME_MODES)[number];
export const MODE_LABELS: Record<GameMode, string> = {
  teams: "TEAM BATTLE",
  br: "BATTLE ROYALE",
  ffa: "FREE-FOR-ALL",
  ctf: "CAPTURE THE FLAG",
};
export const FFA_KILL_TARGET = 15;
export const CTF_CAPTURE_TARGET = 3;
export const FFA_SECONDS = 300;
export const CTF_SECONDS = 420;
export const RESPAWN_SECONDS = 4;
/** Flag bases sit on the x axis at ±CTF_BASE_X; team 0 owns the west base. */
export const CTF_BASE_X = 1500;
export const FLAG_REACH = 60;
/** Round result code for an individual winner identified by winnerId. */
export const WINNER_INDIVIDUAL = 3;

export function validMode(value: unknown): GameMode {
  return (GAME_MODES as readonly unknown[]).includes(value)
    ? (value as GameMode)
    : "teams";
}
/** Everyone is an opponent: no teammates, no friendly-fire protection. */
export function soloMode(mode: GameMode): boolean {
  return mode === "br" || mode === "ffa";
}
/** Eliminations respawn after RESPAWN_SECONDS instead of being final. */
export function respawnMode(mode: GameMode): boolean {
  return mode === "ffa" || mode === "ctf";
}
/** Shrinking storm applies; other modes keep a fixed arena boundary. */
export function stormMode(mode: GameMode): boolean {
  return mode === "teams" || mode === "br";
}
export function timeLimit(mode: GameMode): number {
  return mode === "ffa" ? FFA_SECONDS : mode === "ctf" ? CTF_SECONDS : 0;
}
export function hostile(
  mode: GameMode,
  aId: number,
  aTeam: number,
  bId: number,
  bTeam: number,
): boolean {
  return aId !== bId && (soloMode(mode) || aTeam !== bTeam);
}
export function baseX(team: number): number {
  return team === 0 ? -CTF_BASE_X : CTF_BASE_X;
}
