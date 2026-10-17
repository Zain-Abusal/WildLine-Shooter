import {
  Chunk,
  CHUNK,
  CELLS,
  TILE,
  LEVELS,
  hash,
  terrainHeight,
} from "./world";
/** Indexed by biome * LEVELS + elevation band (water, shore, ground, ground, highland). */
export const TERRAIN = [
  // Forest
  "#538e86",
  "#9ca77b",
  "#6c894e",
  "#658149",
  "#7e8c60",
  // Snow
  "#9fc6d2",
  "#d9e4e6",
  "#e9f0ef",
  "#dbe5e5",
  "#c3d1d4",
  // Desert
  "#4c9e98",
  "#ead9a4",
  "#dfc58a",
  "#d4b677",
  "#bf9862",
];
/** Small, preallocated raster tiles avoid thousands of repeated ground draw calls. */
export class GroundCache {
  private canvases: HTMLCanvasElement[];
  private contexts: CanvasRenderingContext2D[];
  private x: Float64Array;
  private y: Float64Array;
  private seeds: Uint32Array;
  private valid: Uint8Array;
  constructor(capacity: number) {
    this.canvases = Array.from({ length: capacity }, () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      return canvas;
    });
    this.contexts = this.canvases.map(
      (c) => c.getContext("2d", { alpha: false })!,
    );
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.seeds = new Uint32Array(capacity);
    this.valid = new Uint8Array(capacity);
  }
  invalidate(): void {
    this.valid.fill(0);
  }
  draw(
    ctx: CanvasRenderingContext2D,
    chunk: Chunk,
    slot: number,
    seed: number,
    relief = 1,
  ): void {
    if (
      !this.valid[slot] ||
      this.x[slot] !== chunk.x ||
      this.y[slot] !== chunk.y ||
      this.seeds[slot] !== seed
    ) {
      this.valid[slot] = 1;
      this.x[slot] = chunk.x;
      this.y[slot] = chunk.y;
      this.seeds[slot] = seed;
      const c = this.contexts[slot];
      for (let j = 0; j < CELLS * CELLS; j++) {
        const x = (j % CELLS) * 16,
          y = Math.floor(j / CELLS) * 16;
        c.fillStyle = TERRAIN[chunk.terrain[j]];
        c.fillRect(x, y, 16, 16);
        const height = chunk.heights[j],
          band = Math.floor(height * 7);
        if (height > -0.12) {
          c.fillStyle = height > 0.45 ? "#dbe0b755" : "#173b2320";
          c.fillRect(x, y, 16, 16);
          const wx = chunk.x * CHUNK + (j % CELLS) * TILE,
            wy = chunk.y * CHUNK + Math.floor(j / CELLS) * TILE;
          const south = terrainHeight(seed, wx, wy + TILE, relief),
            east = terrainHeight(seed, wx + TILE, wy, relief);
          if (band > Math.floor(south * 7)) {
            c.fillStyle = "#354f35aa";
            c.fillRect(x, y + 12, 16, 4);
            c.fillStyle = "#d7dfa37a";
            c.fillRect(x, y + 11, 16, 1);
          }
          if (band > Math.floor(east * 7)) {
            c.fillStyle = "#354f3570";
            c.fillRect(x + 13, y, 3, 16);
          }
        }

        const h = hash(
          seed,
          chunk.x * CHUNK + (j % CELLS) * TILE,
          chunk.y * CHUNK + Math.floor(j / CELLS) * TILE,
        );
        const level = chunk.terrain[j] % LEVELS;
        c.fillStyle = level === 0 ? "#8fb9a033" : "#b8c78630";
        c.fillRect(x + 2 + h * 8, y + 3 + h * 9, 3 + h * 4, 0.65);
        if (level > 1) {
          c.fillStyle = "#354f362e";
          c.fillRect(x + 4, y + 5, 0.6, 1.5);
          c.fillRect(x + 5, y + 6, 0.6, 1.2);
        }
      }
    }
    ctx.drawImage(
      this.canvases[slot],
      chunk.x * CHUNK,
      chunk.y * CHUNK,
      CHUNK,
      CHUNK,
    );
  }
}
/** Rasterized once at boot; drawImage reuses the same backing stores for every prop. */
export class PropSprites {
  readonly trees: HTMLCanvasElement[];
  readonly rock: HTMLCanvasElement;
  /** Snow-biome pines and desert cacti share the tree anchor (64, 124). */
  readonly pines: HTMLCanvasElement[];
  readonly cacti: HTMLCanvasElement[];
  /** Structures by biome: forest cabin, snow lodge, desert adobe. Anchor (100, 118). */
  readonly houses: HTMLCanvasElement[];
  constructor(
    drawTree: (
      c: CanvasRenderingContext2D,
      x: number,
      y: number,
      r: number,
    ) => void,
    drawRock: (c: CanvasRenderingContext2D, x: number, y: number) => void,
  ) {
    this.trees = Array.from({ length: 3 }, (_, n) => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 144;
      drawTree(canvas.getContext("2d")!, 64, 124, n / 3 + 0.1);
      return canvas;
    });
    this.pines = Array.from({ length: 2 }, (_, n) => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 144;
      drawPine(canvas.getContext("2d")!, 64, 124, n);
      return canvas;
    });
    this.cacti = Array.from({ length: 2 }, (_, n) => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 144;
      drawCactus(canvas.getContext("2d")!, 64, 124, n);
      return canvas;
    });
    this.houses = Array.from({ length: 3 }, (_, biome) => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 200;
      drawHouse(canvas.getContext("2d")!, 100, 118, biome);
      return canvas;
    });
    this.rock = document.createElement("canvas");
    this.rock.width = 64;
    this.rock.height = 64;
    drawRock(this.rock.getContext("2d")!, 32, 38);
  }
}

function drawPine(c: CanvasRenderingContext2D, x: number, y: number, n: number) {
  const scale = 1 + n * 0.18;
  c.fillStyle = "#5d4a36";
  c.fillRect(x - 5, y - 20, 10, 26);
  for (let tier = 0; tier < 3; tier++) {
    const w = (44 - tier * 11) * scale,
      top = y - 30 - tier * 26 * scale;
    c.fillStyle = tier % 2 ? "#2f5a48" : "#274d3e";
    c.beginPath();
    c.moveTo(x - w, top + 18);
    c.lineTo(x, top - 30 * scale);
    c.lineTo(x + w, top + 18);
    c.closePath();
    c.fill();
    // Snow caps on each tier.
    c.fillStyle = "#f1f6f6";
    c.beginPath();
    c.moveTo(x - w * 0.55, top - 2);
    c.lineTo(x, top - 30 * scale);
    c.lineTo(x + w * 0.55, top - 2);
    c.lineTo(x + w * 0.2, top + 3);
    c.lineTo(x - w * 0.15, top - 4);
    c.closePath();
    c.fill();
  }
}
function drawCactus(c: CanvasRenderingContext2D, x: number, y: number, n: number) {
  const h = 70 + n * 16;
  c.fillStyle = "#2f6b45";
  c.fillRect(x - 9, y - h, 18, h + 4);
  c.beginPath();
  c.arc(x, y - h, 9, Math.PI, 0);
  c.fill();
  // Arms
  c.fillRect(x - 30, y - h * 0.62, 21, 10);
  c.fillRect(x - 30, y - h * 0.62 - 24, 10, 34);
  c.fillRect(x + 9, y - h * 0.45, 20, 10);
  c.fillRect(x + 19, y - h * 0.45 - 20, 10, 30);
  c.fillStyle = "#4f9363";
  c.fillRect(x - 4, y - h, 4, h);
  c.fillRect(x - 27, y - h * 0.62 - 22, 3, 30);
  c.fillRect(x + 22, y - h * 0.45 - 18, 3, 26);
}

/** Top-down 2.5D house: shadow, walls, pitched or flat roof and a door facing south. */
function drawHouse(c: CanvasRenderingContext2D, x: number, y: number, biome: number) {
  const wall = biome === 2 ? "#c99a63" : biome === 1 ? "#7b5a43" : "#8a6a48",
    wallDark = biome === 2 ? "#a97c4c" : biome === 1 ? "#5e4433" : "#6b5038",
    roof = biome === 2 ? "#b8865a" : biome === 1 ? "#eef4f3" : "#7d3f2f",
    roofDark = biome === 2 ? "#9a6e47" : biome === 1 ? "#c9d6d7" : "#5f2f23";
  c.fillStyle = "#1b2f2655";
  c.beginPath();
  c.ellipse(x + 10, y + 18, 84, 46, 0, 0, Math.PI * 2);
  c.fill();
  // Front wall with door and windows.
  c.fillStyle = wallDark;
  c.fillRect(x - 70, y - 10, 140, 52);
  c.fillStyle = wall;
  c.fillRect(x - 70, y - 10, 140, 46);
  c.fillStyle = "#3a2a1e";
  c.fillRect(x - 12, y + 6, 24, 36);
  c.fillStyle = biome === 1 ? "#ffd98a" : "#cfe6e9";
  c.fillRect(x - 54, y + 4, 22, 16);
  c.fillRect(x + 32, y + 4, 22, 16);
  c.strokeStyle = "#2a1f17";
  c.lineWidth = 2;
  c.strokeRect(x - 54, y + 4, 22, 16);
  c.strokeRect(x + 32, y + 4, 22, 16);
  if (biome === 2) {
    // Flat adobe roof with a parapet.
    c.fillStyle = roof;
    c.fillRect(x - 76, y - 78, 152, 70);
    c.fillStyle = roofDark;
    c.fillRect(x - 76, y - 16, 152, 8);
    c.fillStyle = "#d9b07c";
    c.fillRect(x - 66, y - 70, 132, 52);
    c.fillStyle = "#6b4a2e";
    for (let k = -2; k <= 2; k++) c.fillRect(x + k * 26 - 3, y - 12, 6, 6);
  } else {
    // Pitched roof seen from above: two slopes meeting at a ridge.
    c.fillStyle = roofDark;
    c.beginPath();
    c.moveTo(x - 82, y - 8);
    c.lineTo(x - 82, y - 50);
    c.lineTo(x + 82, y - 50);
    c.lineTo(x + 82, y - 8);
    c.closePath();
    c.fill();
    c.fillStyle = roof;
    c.beginPath();
    c.moveTo(x - 82, y - 50);
    c.lineTo(x - 82, y - 92);
    c.lineTo(x + 82, y - 92);
    c.lineTo(x + 82, y - 50);
    c.closePath();
    c.fill();
    c.strokeStyle = biome === 1 ? "#ffffff" : "#a65a43";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(x - 82, y - 50);
    c.lineTo(x + 82, y - 50);
    c.stroke();
    // Chimney
    c.fillStyle = "#6d6d6a";
    c.fillRect(x + 40, y - 88, 16, 22);
  }
}
