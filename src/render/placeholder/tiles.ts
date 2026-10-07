import { hashInts, Rng, valueNoise2D } from '../../core/rng';
import type { TileDef } from '../../content/types';
import { buildRamp, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';

/**
 * Generated stand-in tiles (32x32), styled after the reference art: muted,
 * textured ground (mottled, with tufts and pebbles), beveled deck plates with
 * dark grout, chunky walls with a lit lip and a shaded front face.
 *
 * Every tile is drawn from the 5-tone ramp of its content color (outline,
 * shadow, mid, base, highlight), so recoloring a tile in content keeps the
 * same lighting. Each tile gets VARIANTS variations (picked per map cell to
 * break up repetition) and, for solid tiles, a "front face" form drawn when
 * open floor is below it, which gives walls height in the 3/4 view.
 *
 * Textures wrap around (they tile seamlessly with themselves).
 */
export const TILE_SIZE = 32;
export const VARIANTS = 4;
const S = TILE_SIZE;

type Ramp = RGB[];

class Tex {
  readonly pc = new PixelCanvas(S, S);
  constructor(readonly ramp: Ramp) {}
  /** Sets a pixel, wrapping around the tile edges. */
  set(x: number, y: number, c: RGB): void {
    this.pc.set(((Math.round(x) % S) + S) % S, ((Math.round(y) % S) + S) % S, c);
  }
  tone(x: number, y: number, t: number, ramp = this.ramp): void {
    this.set(x, y, ramp[Math.max(0, Math.min(4, t))]!);
  }
  fill(t: number, ramp = this.ramp): void {
    this.pc.rect(0, 0, S, S, ramp[t]!);
  }
  rect(x: number, y: number, w: number, h: number, t: number, ramp = this.ramp): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.tone(xx, yy, t, ramp);
  }
}

/**
 * Seamless mottling: soft-edged blotches stamped with wrap-around, so the tile
 * tiles with itself. Returns a 0..1 field (0.5 = untouched).
 */
function mottle(rng: Rng, count: number, rMin: number, rMax: number): Float32Array {
  const f = new Float32Array(S * S).fill(0.5);
  for (let i = 0; i < count; i++) {
    const cx = rng.range(0, S);
    const cy = rng.range(0, S);
    const rx = rng.range(rMin, rMax);
    const ry = rx * rng.range(0.55, 1);
    const sign = rng.chance(0.5) ? 1 : -1;
    for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++) {
      for (let x = Math.floor(cx - rx - 2); x <= cx + rx + 2; x++) {
        // Ragged edge: jitter the radius per pixel.
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry) + (rng.next() - 0.5) * 0.35;
        if (d >= 1) continue;
        const i2 = (((y % S) + S) % S) * S + (((x % S) + S) % S);
        f[i2] = Math.max(0, Math.min(1, f[i2]! + sign * 0.3 * (1 - d * 0.5)));
      }
    }
  }
  return f;
}

function grass(t: Tex, rng: Rng, accent: Ramp): void {
  t.fill(3);
  const m = mottle(rng, 9, 3, 7);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = m[y * S + x]! + (rng.next() - 0.5) * 0.12;
      if (n < 0.34) t.tone(x, y, 2);
      else if (n > 0.68) t.tone(x, y, 3, accent);
    }
  }
  // Blades: short strokes, lit tip, shaded root.
  for (let i = 0; i < 34; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    const h = rng.int(2, 4);
    const lean = rng.pick([-1, 0, 0, 1]);
    t.tone(x, y, 2);
    for (let k = 1; k < h; k++) t.tone(x + (k === h - 1 ? lean : 0), y - k, k === h - 1 ? 4 : 3, k === h - 1 ? accent : t.ramp);
  }
  // Tufts: little fans of blades with a shadow under them.
  for (let i = 0; i < 4; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    for (let dx = -2; dx <= 2; dx++) t.tone(x + dx, y + 1, 1);
    for (const [dx, h] of [
      [-2, 2],
      [-1, 3],
      [0, 4],
      [1, 3],
      [2, 2],
    ] as const) {
      for (let k = 0; k < h; k++) t.tone(x + dx + (k === h - 1 ? Math.sign(dx) : 0), y - k, k === h - 1 ? 4 : 3, accent);
    }
  }
  for (let i = 0; i < 4; i++) t.tone(rng.int(0, S - 1), rng.int(0, S - 1), 1);
}

function dirt(t: Tex, rng: Rng): void {
  t.fill(3);
  const m = mottle(rng, 10, 2.5, 6);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = m[y * S + x]! + (rng.next() - 0.5) * 0.16;
      if (n < 0.32) t.tone(x, y, 2);
      else if (n > 0.72) t.tone(x, y, 4);
    }
  }
  // Pebbles: lit top-left, shadow bottom-right, dark rim under.
  for (let i = 0; i < 5; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    const big = rng.chance(0.4);
    t.tone(x, y, 4);
    t.tone(x + 1, y, 3);
    t.tone(x, y + 1, 2);
    t.tone(x + 1, y + 1, 1);
    t.tone(x, y + 2, 0);
    t.tone(x + 1, y + 2, 0);
    if (big) {
      t.tone(x + 2, y, 2);
      t.tone(x + 2, y + 1, 1);
      t.tone(x + 2, y + 2, 0);
    }
  }
  // Hairline cracks and specks.
  for (let i = 0; i < 2; i++) {
    let x = rng.int(0, S - 1);
    let y = rng.int(0, S - 1);
    for (let k = 0; k < rng.int(3, 7); k++) {
      t.tone(x, y, 1);
      x += rng.pick([1, 1, 0]);
      y += rng.pick([0, 1]);
    }
  }
  for (let i = 0; i < 10; i++) t.tone(rng.int(0, S - 1), rng.int(0, S - 1), rng.chance(0.4) ? 1 : 4);
}

/** Cellular rock: lumpy stones, lit top-left, dark cracks between. */
function rockTop(t: Tex, rng: Rng): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < 7; i++) pts.push([rng.range(0, S), rng.range(0, S)]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      let best = 0;
      pts.forEach(([px, py], i) => {
        for (const ox of [-S, 0, S]) {
          for (const oy of [-S, 0, S]) {
            const d = Math.hypot(x - px - ox, y - py - oy);
            if (d < d1) {
              d2 = d1;
              d1 = d;
              best = i;
            } else if (d < d2) d2 = d;
          }
        }
      });
      const edge = d2 - d1;
      // Direction from the cell center: light from the top-left.
      const [px, py] = pts[best]!;
      let dx = x - px;
      let dy = y - py;
      if (dx > S / 2) dx -= S;
      if (dx < -S / 2) dx += S;
      if (dy > S / 2) dy -= S;
      if (dy < -S / 2) dy += S;
      const lit = -(dx + dy) / (Math.hypot(dx, dy) + 3);
      let tone = edge < 0.9 ? 1 : edge < 2 ? 2 : lit > 0.45 ? 4 : 3;
      if (tone > 1 && rng.chance(0.06)) tone -= 1;
      t.tone(x, y, tone);
    }
  }
}

function rockFront(t: Tex, rng: Rng, face: number): void {
  const top = S - face;
  for (let y = top; y < S; y++) {
    const depth = (y - top) / face;
    for (let x = 0; x < S; x++) {
      // Vertical strata that get darker toward the ground.
      const band = (x + Math.floor(valueNoise2D(7, x / 5, y / 9) * 4)) % 7;
      let tone = depth < 0.15 ? 3 : depth > 0.85 ? 0 : band === 0 ? 1 : depth > 0.55 ? 1 : 2;
      if (tone === 2 && rng.chance(0.08)) tone = 3;
      t.pc.set(x, y, t.ramp[tone]!);
    }
  }
  // Lit lip where the top meets the face.
  for (let x = 0; x < S; x++) t.pc.set(x, top, t.ramp[4]!);
  for (let x = 0; x < S; x++) t.pc.set(x, top - 1, t.ramp[rng.chance(0.3) ? 2 : 3]!);
}

/** Deck plates like the reference room: 16px plates, beveled, dark grout. */
function plate(t: Tex, rng: Rng, variant: number): void {
  t.fill(3);
  for (let py = 0; py < S; py += 16) {
    for (let px = 0; px < S; px += 16) {
      for (let i = 0; i < 16; i++) {
        t.tone(px + i, py, 4);
        t.tone(px, py + i, 4);
        t.tone(px + i, py + 14, 2);
        t.tone(px + 14, py + i, 2);
        t.tone(px + i, py + 15, 0);
        t.tone(px + 15, py + i, 0);
      }
      t.tone(px + 15, py, 1);
      t.tone(px, py + 15, 1);
      // Scuffs and grime.
      for (let k = 0; k < 6; k++) t.tone(px + rng.int(2, 12), py + rng.int(2, 12), rng.chance(0.6) ? 2 : 4);
    }
  }
  // Variants: a rivet pair, a stain, a vent slot.
  if (variant === 1) {
    for (const [x, y] of [
      [4, 4],
      [11, 4],
    ] as const) {
      t.tone(x, y, 4);
      t.tone(x + 1, y + 1, 1);
    }
  }
  if (variant === 2) {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) if (Math.hypot(x - 4, y - 3) < 3.6 && rng.chance(0.7)) t.tone(18 + x, 19 + y, 2);
  }
  if (variant === 3) {
    for (let x = 19; x < 29; x++) {
      t.tone(x, 6, 0);
      t.tone(x, 8, 0);
      t.tone(x, 7, 1);
      t.tone(x, 9, 4);
    }
  }
}

function grate(t: Tex): void {
  t.fill(0);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const bx = x % 4;
      const by = y % 4;
      if (by === 0) t.tone(x, y, 3);
      else if (by === 1) t.tone(x, y, 2);
      else if (bx === 0) t.tone(x, y, 2);
      else t.tone(x, y, by === 3 ? 0 : 1);
    }
  }
  for (let x = 0; x < S; x++) {
    t.tone(x, 0, 4);
    t.tone(x, S - 1, 0);
  }
}

function hazard(t: Tex, rng: Rng, stripe: Ramp): void {
  t.fill(3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (((x + y) >> 3) % 2 === 0) t.tone(x, y, rng.chance(0.08) ? 4 : 3, stripe);
      else if (rng.chance(0.05)) t.tone(x, y, 2); // chipped paint
    }
  }
  for (let x = 0; x < S; x++) {
    t.tone(x, 0, 4);
    t.tone(x, 1, 4);
    t.tone(x, S - 2, 1);
    t.tone(x, S - 1, 0);
  }
}

/** Bulkhead walls: a lit cap on top; when floor is below, a paneled front face. */
function wall(t: Tex, rng: Rng, variant: number, front: boolean, accent: Ramp): void {
  // Cap: two rows of blocks with mortar.
  t.fill(3);
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / 8);
    const off = row % 2 ? 8 : 0;
    for (let x = 0; x < S; x++) {
      const bx = (x + off) % 16;
      const by = y % 8;
      if (by === 7 || bx === 15) t.tone(x, y, 1);
      else if (by === 0 || bx === 0) t.tone(x, y, 4);
      else if (rng.chance(0.07)) t.tone(x, y, 2);
    }
  }
  if (!front) return;
  const face = 18;
  const top = S - face;
  for (let y = top; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const depth = (y - top) / face;
      const seam = x % 16 === 15;
      let tone = seam ? 0 : depth > 0.86 ? 0 : depth > 0.6 ? 1 : 2;
      if (!seam && x % 16 === 0) tone = Math.min(4, tone + 1);
      t.pc.set(x, y, t.ramp[tone]!);
    }
  }
  for (let x = 0; x < S; x++) {
    t.pc.set(x, top, t.ramp[4]!);
    t.pc.set(x, top + 1, t.ramp[3]!);
    t.pc.set(x, top - 1, t.ramp[0]!);
  }
  // A horizontal trim line and the occasional lamp / rivets.
  for (let x = 0; x < S; x++) t.pc.set(x, top + 8, t.ramp[x % 16 === 15 ? 0 : 1]!);
  if (variant === 3) {
    for (let x = 12; x < 20; x++) {
      t.pc.set(x, top + 4, accent[4]!);
      t.pc.set(x, top + 5, accent[3]!);
    }
  } else {
    for (const x of [3, 12, 19, 28]) t.pc.set(x, top + 4, t.ramp[3]!);
  }
}

/** Water: murky body, slow ripple bands, a few glints; shallows show stones on the bottom. */
function water(t: Tex, rng: Rng, accent: Ramp, shallow: boolean): void {
  t.fill(2);
  const m = mottle(rng, 7, 4, 9);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = m[y * S + x]!;
      if (n < 0.36) t.tone(x, y, 1);
      else if (n > 0.7) t.tone(x, y, 3);
    }
  }
  if (shallow) {
    for (let i = 0; i < 4; i++) {
      const x = rng.int(0, S - 1);
      const y = rng.int(0, S - 1);
      for (const [dx, dy, tone] of [
        [0, 0, 3],
        [1, 0, 3],
        [0, 1, 1],
        [1, 1, 1],
        [2, 1, 1],
      ] as const)
        t.tone(x + dx, y + dy, tone);
    }
  }
  // Ripples: long, faint wavy crests; a few glints.
  for (let i = 0; i < 4; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    const len = rng.int(7, 14);
    for (let k = 0; k < len; k++) t.tone(x + k, y + Math.round(Math.sin(k * 0.5) * 0.7), 3);
  }
  for (let i = 0; i < 2; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    t.tone(x, y, 4, accent);
    t.tone(x + 1, y, 3, accent);
  }
}

/** Wet mud: dark, with sheen on puddles and boot-churned dents. */
function mud(t: Tex, rng: Rng, accent: Ramp): void {
  t.fill(2);
  const m = mottle(rng, 9, 3, 7);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = m[y * S + x]! + (rng.next() - 0.5) * 0.1;
      if (n < 0.33) t.tone(x, y, 1);
      else if (n > 0.7) t.tone(x, y, 3);
    }
  }
  for (let i = 0; i < 2; i++) {
    const cx = rng.range(4, S - 4);
    const cy = rng.range(4, S - 4);
    const rx = rng.range(2.5, 5);
    const ry = rx * 0.5;
    for (let y = -3; y <= 3; y++) {
      for (let x = -6; x <= 6; x++) {
        const d = Math.hypot(x / rx, y / ry);
        if (d < 1) t.tone(cx + x, cy + y, d < 0.5 && y < 0 ? 3 : 2, accent);
        else if (d < 1.3 && y > 0) t.tone(cx + x, cy + y, 0);
      }
    }
  }
  for (let i = 0; i < 6; i++) t.tone(rng.int(0, S - 1), rng.int(0, S - 1), rng.chance(0.5) ? 0 : 4);
}

/** Fine sand with wind ripples. */
function sand(t: Tex, rng: Rng): void {
  t.fill(3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = rng.next();
      if (r < 0.08) t.tone(x, y, 2);
      else if (r > 0.94) t.tone(x, y, 4);
    }
  }
  // Ripples run across the tile and wrap, so they continue onto the next tile.
  const phase = rng.range(0, Math.PI * 2);
  for (let x = 0; x < S; x++) {
    for (let k = 0; k < 4; k++) {
      const y = Math.round(k * 8 + 3 + Math.sin((x / S) * Math.PI * 2 + phase + k) * 1.5);
      t.tone(x, y, 4);
      t.tone(x, y + 1, 2);
    }
  }
}

/** Loose gravel: a carpet of small lit stones. */
function gravel(t: Tex, rng: Rng): void {
  t.fill(2);
  for (let i = 0; i < 60; i++) {
    const x = rng.int(0, S - 1);
    const y = rng.int(0, S - 1);
    const lit = rng.chance(0.5) ? 4 : 3;
    t.tone(x, y, lit);
    if (rng.chance(0.6)) t.tone(x + 1, y, 3);
    t.tone(x, y + 1, 1);
    if (rng.chance(0.4)) t.tone(x + 1, y + 1, 0);
  }
}

/** Dry, cracked earth: curling plates split by dark fissures. */
function cracked(t: Tex, rng: Rng): void {
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) pts.push([rng.range(0, S), rng.range(0, S)]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      for (const [px, py] of pts) {
        for (const ox of [-S, 0, S]) {
          for (const oy of [-S, 0, S]) {
            const d = Math.hypot(x - px - ox, y - py - oy);
            if (d < d1) {
              d2 = d1;
              d1 = d;
            } else if (d < d2) d2 = d;
          }
        }
      }
      const edge = d2 - d1;
      t.tone(x, y, edge < 0.8 ? 1 : edge < 1.8 ? 2 : rng.chance(0.06) ? 4 : 3);
    }
  }
}

/** Old asphalt: soft mottling, sparse aggregate, hairline cracks, flecks of paint. */
function asphalt(t: Tex, rng: Rng, variant: number, accent: Ramp): void {
  t.fill(3);
  const m = mottle(rng, 6, 3, 8);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = rng.next();
      const n = m[y * S + x]!;
      if (n < 0.32 || r < 0.03) t.tone(x, y, 2);
      else if (r > 0.975) t.tone(x, y, 4);
    }
  }
  if (variant === 1 || variant === 3) {
    let x = rng.int(0, S - 1);
    let y = rng.int(0, S - 1);
    for (let k = 0; k < rng.int(6, 12); k++) {
      t.tone(x, y, 1);
      x += rng.pick([1, 1, 0, -1]);
      y += rng.pick([1, 0]);
    }
  }
  if (variant === 3) for (let i = 0; i < 4; i++) t.tone(rng.int(0, S - 1), rng.int(0, S - 1), 2, accent);
}

/** Poured concrete: slabs with a lit lip and dark joint, stains and hairline cracks. */
function concrete(t: Tex, rng: Rng, variant: number): void {
  t.fill(3);
  const m = mottle(rng, 6, 3, 8);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = m[y * S + x]! + (rng.next() - 0.5) * 0.12;
      if (n < 0.34) t.tone(x, y, 2);
      else if (n > 0.74) t.tone(x, y, 4);
    }
  }
  for (let i = 0; i < S; i++) {
    t.tone(i, 0, 4);
    t.tone(i, S - 1, 1);
    t.tone(0, i, 4);
    t.tone(S - 1, i, 1);
  }
  if (variant >= 2) {
    let x = rng.int(4, S - 4);
    let y = rng.int(2, 6);
    for (let k = 0; k < rng.int(6, 14); k++) {
      t.tone(x, y, 1);
      x += rng.pick([1, 0, -1]);
      y += 1;
    }
  }
}

/** Wooden boards: wide, warm, soft seams, staggered joints and nail heads. */
function planks(t: Tex, rng: Rng): void {
  const rows = 3;
  const bounds = [0, 11, 22, 32];
  for (let r = 0; r < rows; r++) {
    const y0 = bounds[r]!;
    const y1 = bounds[r + 1]!;
    const base = rng.chance(0.5) ? 3 : rng.chance(0.5) ? 4 : 2;
    const joint = rng.int(4, S - 4);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < S; x++) {
        const ly = y - y0;
        let tone = ly === y1 - y0 - 1 ? 1 : ly === 0 ? Math.min(4, base + 1) : base;
        if (x === joint && ly < y1 - y0 - 1) tone = 1;
        else if (tone === base && valueNoise2D(r * 7 + 3, x / 4, ly * 1.3) > 0.74) tone = Math.max(1, base - 1);
        t.tone(x, y, tone);
      }
    }
    for (const x of [joint - 2, joint + 3]) t.tone(x, y0 + Math.floor((y1 - y0) / 2), 1);
  }
}

/** Brick walls: a rough brick course on top; a bricked front face with dark mortar. */
function brick(t: Tex, rng: Rng, front: boolean, mortar: Ramp): void {
  t.fill(2);
  const course = (x: number, y: number, top: boolean, depth: number) => {
    const row = Math.floor(y / 4);
    const off = row % 2 ? 4 : 0;
    const bx = (x + off) % 8;
    const by = y % 4;
    if (by === 3 || bx === 7) return t.tone(x, y, top ? 1 : 1, mortar);
    let tone = by === 0 && top ? 4 : depth > 0.75 ? 1 : depth > 0.45 ? 2 : 3;
    if (bx === 0 && tone < 4) tone = Math.min(4, tone + 1);
    if (rng.chance(0.05)) tone = Math.max(0, tone - 1);
    t.tone(x, y, tone);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) course(x, y, true, 0);
  if (!front) return;
  const face = 18;
  const top = S - face;
  for (let y = top; y < S; y++) for (let x = 0; x < S; x++) course(x, y - top, false, (y - top) / face);
  for (let x = 0; x < S; x++) {
    t.pc.set(x, top - 1, t.ramp[0]!);
    t.pc.set(x, top, t.ramp[4]!);
    t.pc.set(x, S - 1, t.ramp[0]!);
  }
}

/** Ceramic floor tiles: 8px squares with grout, the odd stain and cracked tile. */
function floorTiles(t: Tex, rng: Rng, variant: number): void {
  t.fill(3);
  for (let ty = 0; ty < S; ty += 8) {
    for (let tx = 0; tx < S; tx += 8) {
      const tone = rng.chance(0.25) ? 4 : rng.chance(0.15) ? 2 : 3;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const gx = tx + x;
          const gy = ty + y;
          if (x === 7 || y === 7) t.tone(gx, gy, 1);
          else if (x === 0 || y === 0) t.tone(gx, gy, Math.min(4, tone + 1));
          else t.tone(gx, gy, tone);
        }
      }
    }
  }
  if (variant === 2) for (let i = 0; i < 9; i++) t.tone(18 + i, 10 + Math.round(i * 0.6), 1);
  if (variant === 3) {
    const m = mottle(rng, 2, 3, 5);
    for (let i = 0; i < S * S; i++) if (m[i]! < 0.3) t.tone(i % S, Math.floor(i / S), 2);
  }
}

/** A doorway: worn deck plate with a threshold seam and painted corner brackets. */
function doorway(t: Tex, accent: Ramp): void {
  t.fill(3);
  for (let i = 0; i < S; i++) {
    t.tone(i, 0, 1);
    t.tone(i, S - 1, 1);
    t.tone(0, i, 1);
    t.tone(S - 1, i, 1);
    t.tone(i, 15, 2);
    t.tone(i, 16, 4);
  }
  for (const [x, y, dx, dy] of [
    [2, 2, 1, 1],
    [S - 3, 2, -1, 1],
    [2, S - 3, 1, -1],
    [S - 3, S - 3, -1, -1],
  ] as const) {
    for (let k = 0; k < 6; k++) {
      t.tone(x + dx * k, y, 3, accent);
      t.tone(x, y + dy * k, 3, accent);
    }
  }
}

/** Open space: near-black with a scatter of stars (a few bright, one coloured). */
function space(t: Tex, rng: Rng, accent: Ramp): void {
  t.fill(1);
  const m = mottle(rng, 3, 6, 12);
  for (let i = 0; i < S * S; i++) if (m[i]! > 0.68) t.tone(i % S, Math.floor(i / S), 2);
  for (let i = 0; i < 7; i++) t.tone(rng.int(0, S - 1), rng.int(0, S - 1), rng.chance(0.6) ? 3 : 4, accent);
  if (rng.chance(0.5)) {
    const x = rng.int(2, S - 3);
    const y = rng.int(2, S - 3);
    t.tone(x, y, 4, accent);
    t.tone(x - 1, y, 2, accent);
    t.tone(x + 1, y, 2, accent);
    t.tone(x, y - 1, 2, accent);
    t.tone(x, y + 1, 2, accent);
  }
}

/** A viewport: a heavy frame; the glass shows stars. With floor below, a tall pane of glass. */
function viewport(t: Tex, rng: Rng, front: boolean, glass: Ramp): void {
  t.fill(2);
  for (let i = 0; i < S; i++) {
    t.tone(i, 0, 4);
    t.tone(i, S - 1, 0);
  }
  const pane = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) t.pc.set(x, y, glass[(x + y) % 11 === 0 ? 2 : 0]!);
    for (let i = 0; i < 3; i++) t.pc.set(rng.int(x0, x1), rng.int(y0, y1), glass[4]!);
    for (let x = x0; x <= x1; x++) t.pc.set(x, y0, glass[1]!);
  };
  pane(4, 4, S - 5, front ? 9 : S - 5);
  if (!front) return;
  const face = 18;
  const top = S - face;
  for (let y = top; y < S; y++) for (let x = 0; x < S; x++) t.pc.set(x, y, t.ramp[x < 3 || x > S - 4 ? 1 : 2]!);
  pane(3, top + 2, S - 4, S - 3);
  for (let x = 0; x < S; x++) t.pc.set(x, top, t.ramp[4]!);
}

/** A round hatch in the floor: rim, lid with a cross of braces, a painted handle. */
function hatch(t: Tex, accent: Ramp): void {
  t.fill(3);
  const c = S / 2 - 0.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d < 13 && d >= 11.5) t.tone(x, y, x + y < S ? 4 : 1);
      else if (d < 11.5) t.tone(x, y, (x === Math.round(c) || y === Math.round(c)) && d < 10 ? 2 : d > 10 ? 1 : 3);
    }
  }
  for (let x = 12; x < 20; x++) {
    t.tone(x, 9, 4, accent);
    t.tone(x, 10, 2, accent);
  }
}

export function generateTile(def: TileDef, variant: number, front: boolean): PixelCanvas {
  const ramp = buildRamp(def.placeholder.color);
  const accent = def.placeholder.accent ? buildRamp(def.placeholder.accent) : ramp;
  const seed = hashInts(variant, def.id.length, def.id.charCodeAt(0), def.id.charCodeAt(def.id.length - 1));
  const rng = new Rng(hashInts(seed, front ? 1 : 0));
  const t = new Tex(ramp);
  switch (def.placeholder.style) {
    case 'noise':
      if (def.id === 'void') t.fill(1);
      else dirt(t, rng);
      break;
    case 'grass':
      grass(t, rng, accent);
      break;
    case 'plate':
      plate(t, rng, variant);
      break;
    case 'grate':
      grate(t);
      break;
    case 'hazard':
      hazard(t, rng, accent);
      break;
    case 'rock':
      rockTop(t, rng);
      if (front) rockFront(t, rng, 16);
      break;
    case 'wall':
      wall(t, rng, variant, front, accent);
      break;
    case 'water':
      water(t, rng, accent, !def.solid);
      break;
    case 'mud':
      mud(t, rng, accent);
      break;
    case 'sand':
      sand(t, rng);
      break;
    case 'gravel':
      gravel(t, rng);
      break;
    case 'cracked':
      cracked(t, rng);
      break;
    case 'asphalt':
      asphalt(t, rng, variant, accent);
      break;
    case 'concrete':
      concrete(t, rng, variant);
      break;
    case 'planks':
      planks(t, rng);
      break;
    case 'brick':
      brick(t, rng, front, accent);
      break;
    case 'tiles':
      floorTiles(t, rng, variant);
      break;
    case 'door':
      doorway(t, accent);
      break;
    case 'space':
      space(t, rng, accent);
      break;
    case 'window':
      viewport(t, rng, front, accent);
      break;
    case 'hatch':
      hatch(t, accent);
      break;
  }
  return t.pc;
}

/** The colors a tile's ground is drawn in (for blending edges and props). */
export function tileRamp(def: TileDef): RGB[] {
  return buildRamp(def.placeholder.color);
}
