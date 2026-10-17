export const CHUNK = 512,
  CELLS = 8,
  TILE = CHUNK / CELLS,
  OBJECTS = 24;
export function seedHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function hash(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Stateless 2D simplex noise; gradients are selected by coordinate hash. */
export function simplex(seed: number, x: number, y: number): number {
  const s = (x + y) * 0.3660254037844386,
    i = Math.floor(x + s),
    j = Math.floor(y + s),
    t = (i + j) * 0.21132486540518713;
  const x0 = x - i + t,
    y0 = y - j + t,
    ix = x0 > y0 ? 1 : 0,
    iy = 1 - ix;
  return (
    70 *
    (corner(seed, i, j, x0, y0) +
      corner(
        seed,
        i + ix,
        j + iy,
        x0 - ix + 0.21132486540518713,
        y0 - iy + 0.21132486540518713,
      ) +
      corner(
        seed,
        i + 1,
        j + 1,
        x0 - 1 + 0.42264973081037427,
        y0 - 1 + 0.42264973081037427,
      ))
  );
}
function corner(
  seed: number,
  i: number,
  j: number,
  x: number,
  y: number,
): number {
  let t = 0.5 - x * x - y * y;
  if (t < 0) return 0;
  const g = (hash(seed, i, j) * 8) | 0;
  const u = g < 4 ? x : y,
    v = g < 4 ? y : x;
  t *= t;
  return t * t * ((g & 1 ? -u : u) + (g & 2 ? -2 * v : 2 * v));
}
/** Seed-dependent offsets avoid every map starting at simplex's zero-valued origin. */
export function terrainHeight(
  seed: number,
  x: number,
  y: number,
  relief = 1,
): number {
  const ox = hash(seed, 191, 71) * 20000,
    oy = hash(seed, 83, 293) * 20000;
  return (
    (simplex(seed, (x + ox) / 1300, (y + oy) / 1300) * 0.55 +
      simplex(seed + 1, (x + ox) / 450, (y + oy) / 450) * 0.15) *
    relief
  );
}
/** Biomes: 0 forest, 1 snow, 2 desert. Large-scale seeded "temperature" noise. */
export const BIOME_FOREST = 0,
  BIOME_SNOW = 1,
  BIOME_DESERT = 2,
  LEVELS = 5;
export function biomeAt(seed: number, x: number, y: number): number {
  const t =
    simplex(seed + 7, x / 6500 + 31.7, y / 6500 - 12.3) * 0.8 +
    simplex(seed + 11, x / 2200, y / 2200) * 0.2;
  return t < -0.26 ? BIOME_SNOW : t > 0.28 ? BIOME_DESERT : BIOME_FOREST;
}
/** Elevation band 0 water, 1 shore, 2–3 ground, 4 highland. */
export function terrainLevel(h: number): number {
  return h < -0.24 ? 0 : h < -0.12 ? 1 : h > 0.35 ? 4 : h > 0.08 ? 3 : 2;
}
/** Palette index into TERRAIN: biome * LEVELS + elevation band. */
export function terrainIndex(seed: number, x: number, y: number, h: number) {
  return biomeAt(seed, x, y) * LEVELS + terrainLevel(h);
}
/** Object kinds: 0 tree, 1 rock, 2 cache/chest, 3 spawn anchor, 4 bush, 5 structure. */
export const STRUCTURE = 5;
/**
 * True when a spawn point is in water or inside/against a structure.
 * Structures (slots 0 and 3) sit at least 140 units inside their chunk, so only
 * the point's own chunk needs checking; `scratch` is regenerated for it.
 */
export function blockedSpot(
  seed: number,
  x: number,
  y: number,
  relief: number,
  density: number,
  scratch: Chunk,
): boolean {
  if (terrainHeight(seed, x, y, relief) < -0.24) return true;
  scratch.generate(seed, Math.floor(x / CHUNK), Math.floor(y / CHUNK), relief, density);
  for (const slot of [0, 3])
    if (
      scratch.kind[slot] === STRUCTURE &&
      Math.hypot(x - scratch.ox[slot], y - scratch.oy[slot]) < STRUCTURE_RADIUS + 45
    )
      return true;
  return false;
}
/** Rare ground medkit, collected like a cache. */
export const MEDKIT = 6;
/** Structures block movement and shots within this radius of their centre. */
export const STRUCTURE_RADIUS = 72;
export function trailX(seed: number, y: number): number {
  return (
    Math.sin(y / (450 + hash(seed, 44, 12) * 450) + hash(seed, 23, 54) * 6.28) *
      (100 + hash(seed, 85, 33) * 200) +
    hash(seed, 19, 87) * 600 -
    200
  );
}
export class Chunk {
  active = false;
  x = 0;
  y = 0;
  count = OBJECTS;
  heights = new Float32Array(CELLS * CELLS);
  terrain = new Uint8Array(CELLS * CELLS);
  ox = new Float32Array(OBJECTS);
  oy = new Float32Array(OBJECTS);
  kind = new Uint8Array(OBJECTS);
  hp = new Float32Array(OBJECTS);
  drop = new Uint8Array(OBJECTS);
  variant = new Uint8Array(OBJECTS);
  biome = new Uint8Array(OBJECTS);
  /** Battle royale chests: ~30% of caches plus every structure's doorstep cache. */
  chest = new Uint8Array(OBJECTS);
  generate(
    seed: number,
    x: number,
    y: number,
    relief = 1,
    enemyDensity = 0.04,
  ): void {
    this.active = true;
    this.x = x;
    this.y = y;
    for (let i = 0; i < CELLS * CELLS; i++) {
      const wx = x * CHUNK + (i % CELLS) * TILE,
        wy = y * CHUNK + Math.floor(i / CELLS) * TILE;
      const h = terrainHeight(seed, wx, wy, relief);
      this.heights[i] = h;
      this.terrain[i] = terrainIndex(seed, wx, wy, h);
    }
    for (let i = 0; i < OBJECTS; i++) {
      // Keep a margin from chunk edges so props never overlap a neighbour's.
      this.ox[i] = x * CHUNK + 28 + hash(seed + i * 17, x, y) * (CHUNK - 56);
      this.oy[i] = y * CHUNK + 28 + hash(seed + i * 17 + 9, x, y) * (CHUNK - 56);
      const r = hash(seed + i * 31 + 400, x, y);
      this.kind[i] = r > 1 - enemyDensity ? 3 : r < 0.62 ? 0 : r < 0.84 ? 1 : 2;
      if (this.kind[i] === 0 && hash(seed + i * 97 + 433, x, y) > 0.72)
        this.kind[i] = 4;
      this.variant[i] = (hash(seed + i * 47 + 901, x, y) * 3) | 0;
      this.biome[i] = biomeAt(seed, this.ox[i], this.oy[i]);
      // Deserts are sparse: half their trees become rocks (shared by client and authority).
      if (
        this.biome[i] === BIOME_DESERT &&
        this.kind[i] === 0 &&
        hash(seed + i * 53 + 77, x, y) < 0.5
      )
        this.kind[i] = 1;
      this.hp[i] = this.kind[i] < 2 ? 60 : 1;
      this.drop[i] = (hash(seed + i + 801, x, y) * 3) | 0;
      if (Math.hypot(this.ox[i], this.oy[i]) < (this.kind[i] === 3 ? 240 : 100))
        this.hp[i] = 0;
      // Surface rules: nothing stands in water; sandy shores grow bushes, not trees.
      const ground = terrainHeight(seed, this.ox[i], this.oy[i], relief);
      if (ground < -0.24) this.hp[i] = 0;
      else if (ground < -0.12 && this.kind[i] === 0) this.kind[i] = 4;
      // Mountains: high ground is rocky; most trees and bushes give way to boulders.
      else if (
        ground > 0.45 &&
        (this.kind[i] === 0 || this.kind[i] === 4) &&
        hash(seed + i * 61 + 13, x, y) < 0.65
      )
        this.kind[i] = 1;
    }
    this.chest.fill(0);
    // Buildings: rare in the wild, clustered into villages where a large-scale
    // "settlement" noise field is high (up to two per chunk, opposite corners).
    const town = simplex(seed + 23, (x * CHUNK) / 3600, (y * CHUNK) / 3600),
      houses = town > 0.42 ? 2 : hash(seed + 5003, x, y) < 0.16 ? 1 : 0,
      placed = [-1, -1];
    for (let h = 0; h < houses; h++) {
      const slot = h === 0 ? 0 : 3,
        base = houses === 2 ? (h === 0 ? 140 : CHUNK - 200) : 140,
        span = houses === 2 ? 60 : CHUNK - 280,
        sx = x * CHUNK + base + hash(seed + 5011 + h * 7, x, y) * span,
        sy = y * CHUNK + base + hash(seed + 5021 + h * 7, x, y) * span,
        ground = terrainHeight(seed, sx, sy, relief);
      if (ground <= -0.1 || ground >= 0.4 || Math.hypot(sx, sy) <= 450) continue;
      this.kind[slot] = STRUCTURE;
      this.ox[slot] = sx;
      this.oy[slot] = sy;
      this.hp[slot] = 1;
      this.biome[slot] = biomeAt(seed, sx, sy);
      // A cache on the doorstep (always a chest in battle royale).
      this.kind[slot + 1] = 2;
      this.ox[slot + 1] = sx;
      this.oy[slot + 1] = sy + STRUCTURE_RADIUS + 22;
      this.hp[slot + 1] = 1;
      this.chest[slot + 1] = 1;
      placed[h] = slot;
    }
    for (const slot of placed) {
      if (slot < 0) continue;
      for (let i = 0; i < OBJECTS; i++) {
        if (placed.includes(i) || placed.includes(i - 1)) continue;
        if (Math.hypot(this.ox[i] - this.ox[slot], this.oy[i] - this.oy[slot]) < STRUCTURE_RADIUS + 60)
          this.hp[i] = 0;
      }
    }
    // Final surface pass (covers relocated structure caches): nothing in water.
    for (let i = 0; i < OBJECTS; i++)
      if (this.kind[i] !== STRUCTURE && terrainHeight(seed, this.ox[i], this.oy[i], relief) < -0.24)
        this.hp[i] = 0;
    // Spacing: drop props that would stand inside an earlier one (deterministic order).
    for (let i = 1; i < OBJECTS; i++) {
      if (this.hp[i] <= 0 || this.kind[i] === 3) continue;
      for (let j = 0; j < i; j++)
        if (
          this.hp[j] > 0 &&
          this.kind[j] !== 3 &&
          Math.hypot(this.ox[i] - this.ox[j], this.oy[i] - this.oy[j]) <
            (this.kind[i] === 0 || this.kind[j] === 0 ? 58 : 44)
        ) {
          this.hp[i] = 0;
          break;
        }
    }
    // Roughly one chunk in five holds a ground medkit (object slot 2, on dry land).
    if (hash(seed + 7001, x, y) < 0.2 && this.hp[2] > 0 && this.kind[2] !== 3) {
      this.kind[2] = MEDKIT;
      this.hp[2] = 1;
    }
    for (let i = 0; i < OBJECTS; i++)
      if (this.kind[i] === 2 && hash(seed, x * 64 + i, y * 64 + 983) < 0.3)
        this.chest[i] = 1;
  }
}
// A bounded journal retains edits across chunk eviction. Oldest edits expire after 8192 entries.
export class World {
  seed = 0;
  relief = 1;
  enemyDensity = 0.04;
  chunks: Chunk[];
  activeCount = 0;
  capacity = 0;
  minX = 0;
  maxX = 0;
  minY = 0;
  maxY = 0;
  private editX = new Int32Array(8192);
  private editY = new Int32Array(8192);
  private editI = new Uint8Array(8192);
  private editHP = new Float32Array(8192);
  private edits = 0;
  private cursor = 0;
  constructor(seed: string, capacity = 100) {
    this.capacity = capacity;
    this.chunks = Array.from({ length: capacity }, () => new Chunk());
    this.reset(seed);
  }
  reset(
    text: string,
    relief = this.relief,
    enemyDensity = this.enemyDensity,
  ): void {
    this.relief = Math.max(0, Math.min(2, relief));
    this.enemyDensity = Math.max(0, Math.min(0.15, enemyDensity));
    this.seed = seedHash(text);
    this.edits = 0;
    this.activeCount = 0;
    this.cursor = 0;
    for (let i = 0; i < this.capacity; i++) this.chunks[i].active = false;
  }
  sync(x: number, y: number, w: number, h: number): void {
    const minX = Math.floor((x - w / 2) / CHUNK) - 1,
      maxX = Math.floor((x + w / 2) / CHUNK) + 1,
      minY = Math.floor((y - h / 2) / CHUNK) - 1,
      maxY = Math.floor((y + h / 2) / CHUNK) + 1;
    if (
      this.activeCount > 0 &&
      minX === this.minX &&
      maxX === this.maxX &&
      minY === this.minY &&
      maxY === this.maxY
    )
      return;
    this.minX = minX;
    this.maxX = Math.floor((x + w / 2) / CHUNK) + 1;
    this.minY = Math.floor((y - h / 2) / CHUNK) - 1;
    this.maxY = Math.floor((y + h / 2) / CHUNK) + 1;
    for (let i = 0; i < this.capacity; i++) {
      const c = this.chunks[i];
      if (
        c.active &&
        (c.x < this.minX ||
          c.x > this.maxX ||
          c.y < this.minY ||
          c.y > this.maxY)
      )
        c.active = false;
    }
    this.activeCount = 0;
    for (let cy = this.minY; cy <= this.maxY; cy++)
      for (let cx = this.minX; cx <= this.maxX; cx++) {
        let found = false;
        for (let i = 0; i < this.capacity; i++) {
          const c = this.chunks[i];
          if (c.active && c.x === cx && c.y === cy) {
            found = true;
            break;
          }
        }
        if (!found)
          for (let i = 0; i < this.capacity; i++) {
            const c = this.chunks[i];
            if (!c.active) {
              c.generate(this.seed, cx, cy, this.relief, this.enemyDensity);
              for (let k = 0; k < this.edits; k++)
                if (this.editX[k] === cx && this.editY[k] === cy)
                  c.hp[this.editI[k]] = this.editHP[k];
              break;
            }
          }
      }
    for (let i = 0; i < this.capacity; i++)
      if (this.chunks[i].active) this.activeCount++;
  }
  covered(x: number, y: number): boolean {
    for (let k = 0; k < this.capacity; k++) {
      const c = this.chunks[k];
      if (
        !c.active ||
        Math.abs(c.x * CHUNK - x) > CHUNK + 50 ||
        Math.abs(c.y * CHUNK - y) > CHUNK + 50
      )
        continue;
      for (let i = 0; i < c.count; i++)
        if (
          c.hp[i] > 0 &&
          (c.kind[i] === 0 || c.kind[i] === 4) &&
          Math.hypot(x - c.ox[i], y - c.oy[i]) < (c.kind[i] === 4 ? 40 : 44)
        )
          return true;
    }
    return false;
  }
  damage(c: Chunk, i: number, amount: number): void {
    c.hp[i] = Math.max(0, c.hp[i] - amount);
    this.remember(c.x, c.y, i, c.hp[i]);
  }
  applyEdit(x: number, y: number, i: number, hp: number): void {
    if (i < 0 || i >= OBJECTS) return;
    for (let n = 0; n < this.capacity; n++) {
      const c = this.chunks[n];
      if (c.active && c.x === x && c.y === y) c.hp[i] = hp;
    }
    this.remember(x, y, i, hp);
  }
  /** Snapshot of the bounded edit journal (cold path: host migration only). */
  exportEdits(): { x: number; y: number; i: number; hp: number }[] {
    const out = [];
    for (let k = 0; k < this.edits; k++)
      out.push({ x: this.editX[k], y: this.editY[k], i: this.editI[k], hp: this.editHP[k] });
    return out;
  }
  private remember(x: number, y: number, i: number, hp: number): void {
    for (let k = 0; k < this.edits; k++)
      if (this.editX[k] === x && this.editY[k] === y && this.editI[k] === i) {
        this.editHP[k] = hp;
        return;
      }
    const k = this.cursor;
    this.editX[k] = x;
    this.editY[k] = y;
    this.editI[k] = i;
    this.editHP[k] = hp;
    this.cursor = (k + 1) % 8192;
    this.edits = Math.min(this.edits + 1, 8192);
  }
}
