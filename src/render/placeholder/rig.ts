import type { RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';

/**
 * A tiny "2.5D" rasterizer for generating pixel-art characters in code.
 *
 * Body parts are built from round primitives (tapered capsules, ellipses) that
 * each produce a height field, like clay. Within a part the heights merge
 * (where an arm meets a shoulder you get a soft crease, which reads as
 * muscle). Parts are painted back to front. Every pixel then gets a surface
 * normal from its part's height field, is lit from the top-left, and is
 * quantized onto a 5-tone ramp:
 *
 *   0 outline · 1 shadow · 2 mid · 3 base · 4 highlight
 *
 * Finishing touches give the hand-pixeled look of the reference art:
 * - colored outlines ("sel-out"): the silhouette uses the darkest tone of the
 *   color it borders, not black;
 * - inner contour lines where a part overlaps one behind it (arm over chest);
 * - small cast shadows below/right of parts in front.
 *
 * Per-pixel body-part tags (`regions`) and tones are kept so armor can be
 * fitted to and shaded exactly like the body underneath.
 */

/** outline, shadow, mid, base, highlight */
export type Ramp = readonly [RGB, RGB, RGB, RGB, RGB];

export interface V {
  x: number;
  y: number;
}

export const v = (x: number, y: number): V => ({ x, y });
export const lerpV = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export type Shape =
  /** Tapered capsule from a (radius ra) to b (radius rb). */
  | { k: 'cap'; a: V; b: V; ra: number; rb: number; z?: number; region?: number }
  /** Ellipse, optionally rotated (radians). */
  | { k: 'ell'; c: V; rx: number; ry: number; rot?: number; z?: number; region?: number }
  /** Triangle (ears, spikes, claws); slightly domed. */
  | { k: 'tri'; a: V; b: V; c: V; z?: number; dome?: number; region?: number };

export const cap = (a: V, b: V, ra: number, rb = ra, extra: { z?: number; region?: number } = {}): Shape => ({ k: 'cap', a, b, ra, rb, ...extra });
export const ell = (c: V, rx: number, ry: number, extra: { rot?: number; z?: number; region?: number } = {}): Shape => ({ k: 'ell', c, rx, ry, ...extra });
export const tri = (a: V, b: V, c: V, extra: { z?: number; dome?: number; region?: number } = {}): Shape => ({ k: 'tri', a, b, c, ...extra });

export interface PartOptions {
  region: number;
  ramp: Ramp;
  /** Draw an inner contour where this part overlaps parts behind it (default true). */
  line?: boolean;
  /** Draw the automatic colored outline around this part (default true; off for hand-drawn art that has its own). */
  outline?: boolean;
  /** Casts a 1px shadow onto parts behind it (default true). */
  shadow?: boolean;
  /** Shading strength: <1 flatter, >1 rounder (default 1). */
  relief?: number;
  /** Shifts every tone of this part (e.g. -1 for a limb on the far side). */
  toneShift?: number;
}

/** Light direction (toward the light): from the top-left, slightly in front. */
const L = (() => {
  const x = -0.5;
  const y = -0.62;
  const z = 0.62;
  const n = Math.hypot(x, y, z);
  return { x: x / n, y: y / n, z: z / n };
})();

const EMPTY = -1;

export class Rig {
  readonly part: Int16Array;
  readonly regions: Uint8Array;
  readonly height: Float32Array;
  /** Index into `ramps` per pixel. */
  readonly rampOf: Int16Array;
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  /** Fixed colors (eyes, teeth...) that skip lighting. */
  private fixed = new Map<number, RGB>();
  /** Explicit tone overrides (painted details like muscle lines). */
  private toneMarks = new Map<number, number>();
  readonly parts: PartOptions[] = [];
  readonly ramps: Ramp[] = [];
  private scratch: Float32Array | null = null;
  /** Bounding box of everything painted so far (finish() only looks there). */
  private bx0 = Infinity;
  private by0 = Infinity;
  private bx1 = -Infinity;
  private by1 = -Infinity;
  private scratchReg: Uint8Array | null = null;

  /** Results of finish(). */
  tone: Int8Array | null = null;
  /** 1 where the pixel is an inner contour line. */
  contour: Uint8Array | null = null;

  constructor(
    readonly width: number,
    readonly height_: number,
  ) {
    const n = width * height_;
    this.part = new Int16Array(n).fill(EMPTY);
    this.regions = new Uint8Array(n);
    this.height = new Float32Array(n);
    this.rampOf = new Int16Array(n).fill(EMPTY);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
  }

  private idx(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.width || y >= this.height_ ? -1 : y * this.width + x;
  }

  private rampIndex(r: Ramp): number {
    let i = this.ramps.indexOf(r);
    if (i < 0) {
      i = this.ramps.length;
      this.ramps.push(r);
    }
    return i;
  }

  /**
   * Places hand-drawn pixels as a part, exactly as given: fixed colors, a tone per
   * pixel (so armor drawn over it is shaded to match), no lighting, no outline.
   */
  addPixels(opts: PartOptions, pixels: { x: number; y: number; color: RGB; tone: number; region: number }[]): number {
    const index = this.parts.length;
    this.parts.push({ line: false, shadow: false, outline: false, ...opts });
    const ramp = this.rampIndex(opts.ramp);
    for (const p of pixels) {
      const i = this.idx(p.x, p.y);
      if (i < 0) continue;
      this.grow(p.x, p.y, p.x, p.y);
      this.part[i] = index;
      this.regions[i] = p.region;
      this.rampOf[i] = ramp;
      this.height[i] = 3;
      this.nx[i] = 0;
      this.ny[i] = 0;
      this.nz[i] = 1;
      this.fixed.set(i, p.color);
      this.toneMarks.set(i, p.tone);
    }
    return index;
  }

  /** Paints one body part (later parts cover earlier ones). Returns its index. */
  add(opts: PartOptions, shapes: Shape[]): number {
    const W = this.width;
    const H = this.height_;
    // Scratch height field, kept at -Infinity between calls (only the touched box is reset).
    this.scratch ??= new Float32Array(W * H).fill(-Infinity);
    this.scratchReg ??= new Uint8Array(W * H);
    const hm = this.scratch;
    const reg = this.scratchReg;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (const s of shapes) {
      const r = s.region ?? opts.region;
      rasterize(s, W, H, (x, y, h) => {
        const i = y * W + x;
        if (h > hm[i]!) {
          hm[i] = h;
          reg[i] = r;
        }
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      });
    }
    const index = this.parts.length;
    this.parts.push(opts);
    this.grow(x0, y0, x1, y1);
    const ramp = this.rampIndex(opts.ramp);
    const relief = opts.relief ?? 1;
    const at = (x: number, y: number, fallback: number) => {
      const h = x < 0 || y < 0 || x >= W || y >= H ? -Infinity : hm[y * W + x]!;
      return h === -Infinity ? fallback - 2.2 : h;
    };
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        const h = hm[i]!;
        if (h === -Infinity) continue;
        const hx = (at(x + 1, y, h) - at(x - 1, y, h)) / 2;
        const hy = (at(x, y + 1, h) - at(x, y - 1, h)) / 2;
        const nx = -hx * relief;
        const ny = -hy * relief;
        const n = Math.hypot(nx, ny, 1);
        this.part[i] = index;
        this.regions[i] = reg[i]!;
        this.height[i] = h;
        this.rampOf[i] = ramp;
        this.nx[i] = nx / n;
        this.ny[i] = ny / n;
        this.nz[i] = 1 / n;
        this.fixed.delete(i);
        this.toneMarks.delete(i);
      }
    }
    for (let y = y0; y <= y1; y++) hm.fill(-Infinity, y * W + x0, y * W + x1 + 1);
    return index;
  }

  private grow(x0: number, y0: number, x1: number, y1: number): void {
    if (x0 < this.bx0) this.bx0 = x0;
    if (y0 < this.by0) this.by0 = y0;
    if (x1 > this.bx1) this.bx1 = x1;
    if (y1 > this.by1) this.by1 = y1;
  }

  /** Clears everything painted so the rig can be reused for another frame. */
  reset(): void {
    this.bx0 = this.by0 = Infinity;
    this.bx1 = this.by1 = -Infinity;
    this.part.fill(EMPTY);
    this.rampOf.fill(EMPTY);
    this.fixed.clear();
    this.toneMarks.clear();
    this.parts.length = 0;
    this.ramps.length = 0;
    this.tone = null;
    this.contour = null;
  }

  /**
   * Recolors already painted pixels inside `shapes` with another ramp (markings:
   * a pale belly, a stripe), keeping their shading. `where` limits it to some
   * body-part regions; `parts` to some part indices.
   */
  decal(ramp: Ramp, shapes: Shape[], where: { regions?: number[]; parts?: number[] } = {}): void {
    const r = this.rampIndex(ramp);
    for (const s of shapes) {
      rasterize(s, this.width, this.height_, (x, y) => {
        const i = y * this.width + x;
        if (this.part[i] === EMPTY) return;
        if (where.regions && !where.regions.includes(this.regions[i]!)) return;
        if (where.parts && !where.parts.includes(this.part[i]!)) return;
        this.rampOf[i] = r;
      });
    }
  }

  /** A single pixel of fixed color on top of whatever is there (eyes, teeth, claws). */
  dot(x: number, y: number, c: RGB, region?: number): void {
    const i = this.idx(Math.round(x), Math.round(y));
    if (i < 0) return;
    this.grow(Math.round(x), Math.round(y), Math.round(x), Math.round(y));
    if (this.part[i] === EMPTY) {
      // Painting onto empty space: attach to the nearest part so outlines work.
      this.part[i] = this.parts.length - 1;
      this.rampOf[i] = this.rampIndex(this.parts[this.parts.length - 1]!.ramp);
      this.nz[i] = 1;
    }
    if (region !== undefined) this.regions[i] = region;
    this.fixed.set(i, c);
  }

  /** Forces a painted pixel to a tone of its own ramp (lines, creases, highlights). */
  mark(x: number, y: number, tone: number, region?: number): void {
    const i = this.idx(Math.round(x), Math.round(y));
    if (i < 0 || this.part[i] === EMPTY) return;
    if (region !== undefined) this.regions[i] = region;
    this.toneMarks.set(i, tone);
  }

  /** A line of tone marks (only on painted pixels). */
  markLine(a: V, b: V, tone: number): void {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 0; s <= n; s++) this.mark(a.x + ((b.x - a.x) * s) / n, a.y + ((b.y - a.y) * s) / n, tone);
  }

  regionAt(x: number, y: number): number {
    const i = this.idx(Math.round(x), Math.round(y));
    return i < 0 ? 0 : this.regions[i]!;
  }

  isPainted(x: number, y: number): boolean {
    const i = this.idx(x, y);
    return i >= 0 && this.part[i] !== EMPTY;
  }

  /** Lights, outlines and flattens everything into pixels (with region tags). */
  finish(target?: PixelCanvas): PixelCanvas {
    const W = this.width;
    const H = this.height_;
    const n = W * H;
    const tone = new Int8Array(n).fill(-1);
    const contour = new Uint8Array(n);
    // Only the painted area (plus a pixel for the outline) needs any work.
    const X0 = Math.max(0, this.bx0 - 1);
    const Y0 = Math.max(0, this.by0 - 1);
    const X1 = Math.min(W - 1, this.bx1 + 1);
    const Y1 = Math.min(H - 1, this.by1 + 1);
    const part = this.part;
    const parts = this.parts;
    // 1. Light.
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0, i = y * W + X0; x <= X1; x++, i++) {
        const p = part[i]!;
        if (p === EMPTY) continue;
        const d = this.nx[i]! * L.x + this.ny[i]! * L.y + this.nz[i]! * L.z;
        let t = d > 0.9 ? 4 : d > 0.66 ? 3 : d > 0.36 ? 2 : 1;
        t += parts[p]!.toneShift ?? 0;
        tone[i] = t < 1 ? 1 : t > 4 ? 4 : t;
      }
    }
    // 2. Cast shadows: a part in front darkens what's just below-right of it.
    const casts = (o: number, p: number) => o !== EMPTY && o > p && parts[o]!.shadow !== false;
    for (let y = Math.max(1, Y0); y <= Y1; y++) {
      for (let x = Math.max(1, X0); x <= X1; x++) {
        const i = y * W + x;
        const p = part[i]!;
        if (p === EMPTY) continue;
        if (casts(part[i - W - 1]!, p) || casts(part[i - W]!, p)) tone[i] = Math.max(1, tone[i]! - 1);
      }
    }
    // 3. Inner contours where a part overlaps one behind it.
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const i = y * W + x;
        const p = part[i]!;
        if (p === EMPTY || parts[p]!.line === false) continue;
        for (const [dx, dy] of NEIGHBORS) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          const q = part[j]!;
          if (q === EMPTY || q >= p) continue;
          if (this.rampOf[j] !== this.rampOf[i] || this.height[i]! - this.height[j]! > 1.5) {
            contour[i] = 1;
            break;
          }
        }
      }
    }
    for (const [i, t] of this.toneMarks) tone[i] = t;
    for (let y = Y0; y <= Y1; y++) for (let i = y * W + X0, e = y * W + X1; i <= e; i++) if (contour[i]) tone[i] = 0;
    this.tone = tone;
    this.contour = contour;

    // 4. Flatten, then sel-out silhouette outline.
    let out: PixelCanvas;
    if (target) {
      out = target;
      out.data.fill(0);
      out.regions?.fill(0);
    } else out = new PixelCanvas(W, H).enableRegions();
    const data = out.data;
    const regions = out.regions;
    const put = (i: number, c: RGB, r: number) => {
      const k = i * 4;
      data[k] = c[0];
      data[k + 1] = c[1];
      data[k + 2] = c[2];
      data[k + 3] = 255;
      if (regions) regions[i] = r;
    };
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0, i = y * W + X0; x <= X1; x++, i++) {
        if (part[i] === EMPTY) continue;
        put(i, this.fixed.get(i) ?? this.ramps[this.rampOf[i]!]![tone[i]!]!, this.regions[i]!);
      }
    }
    const marks: [number, RGB, number][] = [];
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        if (part[y * W + x] !== EMPTY) continue;
        // Prefer the neighbor below (feet on the ground), then sides, then above.
        for (const [dx, dy] of OUTLINE_ORDER) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (part[j] === EMPTY || parts[part[j]!]!.outline === false) continue;
          marks.push([y * W + x, this.ramps[this.rampOf[j]!]![0], this.regions[j]!]);
          break;
        }
      }
    }
    for (const [i, c, r] of marks) put(i, c, r);
    out.region = 0;
    return out;
  }
}

const NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const OUTLINE_ORDER: [number, number][] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
];

/** Calls `put(x, y, height)` for every pixel center inside the shape. */
function rasterize(s: Shape, W: number, H: number, put: (x: number, y: number, h: number) => void): void {
  const z = s.z ?? 0;
  if (s.k === 'cap') {
    const r = Math.max(s.ra, s.rb);
    const bx0 = Math.max(0, Math.floor(Math.min(s.a.x, s.b.x) - r - 1));
    const by0 = Math.max(0, Math.floor(Math.min(s.a.y, s.b.y) - r - 1));
    const bx1 = Math.min(W - 1, Math.ceil(Math.max(s.a.x, s.b.x) + r + 1));
    const by1 = Math.min(H - 1, Math.ceil(Math.max(s.a.y, s.b.y) + r + 1));
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - s.a.x) * dx + (py - s.a.y) * dy) / len2));
        const cx = s.a.x + dx * t;
        const cy = s.a.y + dy * t;
        const rr = s.ra + (s.rb - s.ra) * t;
        const d2 = (px - cx) ** 2 + (py - cy) ** 2;
        if (d2 < rr * rr) put(x, y, z + Math.sqrt(rr * rr - d2));
      }
    }
    return;
  }
  if (s.k === 'ell') {
    const rot = s.rot ?? 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const r = Math.max(s.rx, s.ry);
    const m = Math.min(s.rx, s.ry);
    for (let y = Math.max(0, Math.floor(s.c.y - r - 1)); y <= Math.min(H - 1, Math.ceil(s.c.y + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(s.c.x - r - 1)); x <= Math.min(W - 1, Math.ceil(s.c.x + r + 1)); x++) {
        const px = x + 0.5 - s.c.x;
        const py = y + 0.5 - s.c.y;
        const lx = px * cos + py * sin;
        const ly = -px * sin + py * cos;
        const q = (lx / s.rx) ** 2 + (ly / s.ry) ** 2;
        if (q < 1) put(x, y, z + Math.sqrt(1 - q) * m);
      }
    }
    return;
  }
  // Triangle: inside test by edge functions; height from distance to the nearest edge.
  const { a, b, c } = s;
  const dome = s.dome ?? 1;
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-6) return;
  const sgn = Math.sign(area);
  const edgeDist = (p: V, q: V, x: number, y: number) => {
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    return (((x - p.x) * ey - (y - p.y) * ex) / Math.hypot(ex, ey)) * -sgn;
  };
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const d = Math.min(edgeDist(a, b, px, py), edgeDist(b, c, px, py), edgeDist(c, a, px, py));
      if (d >= 0) put(x, y, z + Math.min(3, d) * dome);
    }
  }
}
