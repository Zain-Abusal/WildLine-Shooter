/** Sprint: speed multiplier and stamina drain/regen per second (shared with the authority). */
export const SPRINT_MULTIPLIER = 1.45;
export const STAMINA_DRAIN = 28;
export const STAMINA_REGEN = 20;
export const STAMINA_DELAY = 0.8;
export function movementSpeed(height: number): number {
  return height < -0.24 ? 145 : 235;
}
export class Pool {
  active: Uint8Array;
  x: Float64Array;
  y: Float64Array;
  vx: Float32Array;
  vy: Float32Array;
  life: Float32Array;
  kind: Uint8Array;
  count = 0;
  cursor = 0;
  constructor(public capacity: number) {
    this.active = new Uint8Array(capacity);
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
  }
  spawn(
    x: number,
    y: number,
    vx: number,
    vy: number,
    life: number,
    kind = 0,
  ): number {
    for (let n = 0; n < this.capacity; n++) {
      const i = (this.cursor + n) % this.capacity;
      if (!this.active[i]) {
        this.active[i] = 1;
        this.x[i] = x;
        this.y[i] = y;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.life[i] = life;
        this.kind[i] = kind;
        this.count++;
        this.cursor = (i + 1) % this.capacity;
        return i;
      }
    }
    return -1;
  }
  release(i: number): void {
    if (this.active[i]) {
      this.active[i] = 0;
      this.count--;
    }
  }
  clear(): void {
    this.active.fill(0);
    this.count = 0;
    this.cursor = 0;
  }
}
export class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  angle = 0;
  health = 100;
  supplies = 0;
  cooldown = 0;
  hurt = 0;
  gun = 0;
  magazine = 24;
  reserve = 72;
  reloading = 0;
  kills = 0;
  stamina = 100;
  staminaDelay = 0;
  /** Spends stamina while sprinting; refills after STAMINA_DELAY. Returns the speed multiplier. */
  sprint(dt: number, wants: boolean): number {
    if (wants && this.stamina > 0) {
      this.stamina = Math.max(0, this.stamina - STAMINA_DRAIN * dt);
      this.staminaDelay = STAMINA_DELAY;
      return SPRINT_MULTIPLIER;
    }
    this.staminaDelay = Math.max(0, this.staminaDelay - dt);
    if (this.staminaDelay === 0)
      this.stamina = Math.min(100, this.stamina + STAMINA_REGEN * dt);
    return 1;
  }
  update(dt: number, mx: number, my: number, speed = 235): void {
    const length = Math.hypot(mx, my);
    if (length > 1) {
      mx /= length;
      my /= length;
    }
    const ease = 1 - Math.exp(-12 * dt);
    this.vx += (mx * speed - this.vx) * ease;
    this.vy += (my * speed - this.vy) * ease;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hurt = Math.max(0, this.hurt - dt);
  }
  reset(): void {
    this.x =
      this.y =
      this.vx =
      this.vy =
      this.angle =
      this.supplies =
      this.cooldown =
      this.hurt =
        0;
    this.health = 100;
    this.kills = 0;
    this.stamina = 100;
    this.staminaDelay = 0;
    this.reloading = 0;
  }
}
