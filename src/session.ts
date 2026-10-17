/** Protocol defaults: absent/invalid fields are never a match result. */
export function finiteValue(
  value: unknown,
  fallback = 0,
  min = 0,
  max = 99999999,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}
/**
 * Explicit round results only. winner 0/1 is a team, 2 a draw, 3 an individual
 * identified by winnerId. With finalOnDeath (public rounds) a confirmed
 * elimination ends the local round; spectating/respawn rooms wait for a winner.
 */
export function roundOutcome(
  entered: boolean,
  health: number,
  winner: unknown,
  team: number,
  winnerId: unknown = undefined,
  selfId = 0,
  finalOnDeath = true,
): "" | "won" | "lost" | "draw" {
  if (!entered) return "";
  if (winner === 2) return "draw";
  if (health <= 0 && finalOnDeath) return "lost";
  if (winner === 3)
    return Number.isInteger(winnerId) ? (winnerId === selfId ? "won" : "lost") : "";
  if (winner !== 0 && winner !== 1) return "";
  return winner === team ? "won" : "lost";
}
export function freshSeed(): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return values[0].toString(36) + "-" + values[1].toString(36);
}
