import { hashInts, Rng } from '../../core/rng';
import type { TileDef } from '../../content/types';
import { hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';

/**
 * Generated stand-in tiles (32x32). Each tile gets VARIANTS random variations
 * (picked per map cell to break up repetition) and, for solid tiles, a "front
 * face" form drawn when open floor is below it — this gives walls height in the
 * top-down 3/4 view.
 */
export const TILE_SIZE = 32;
export const VARIANTS = 4;

const shade = ([r, g, b]: RGB, f: number): RGB => [
  Math.max(0, Math.min(255, Math.round(r * f))),
  Math.max(0, Math.min(255, Math.round(g * f))),
  Math.max(0, Math.min(255, Math.round(b * f))),
];

export function generateTile(def: TileDef, variant: number, front: boolean): PixelCanvas {
  const S = TILE_SIZE;
  const pc = new PixelCanvas(S, S);
  const base = hexToRgb(def.placeholder.color);
  const accent = def.placeholder.accent ? hexToRgb(def.placeholder.accent) : shade(base, 0.75);
  const rng = new Rng(hashInts(variant, def.id.length, def.id.charCodeAt(0), front ? 1 : 0));
  pc.rect(0, 0, S, S, base);

  switch (def.placeholder.style) {
    case 'noise':
      for (let i = 0; i < 70; i++) pc.set(rng.int(0, S - 1), rng.int(0, S - 1), rng.pick([accent, shade(base, 1.12), shade(base, 0.88)]));
      for (let i = 0; i < 3; i++) {
        const x = rng.int(2, S - 4);
        const y = rng.int(2, S - 4);
        pc.rect(x, y, 2, 1, shade(base, 1.2));
        pc.rect(x, y + 1, 2, 1, shade(base, 0.7));
      }
      break;
    case 'grass':
      for (let i = 0; i < 40; i++) pc.set(rng.int(0, S - 1), rng.int(0, S - 1), shade(base, rng.range(0.85, 1.1)));
      for (let i = 0; i < 26; i++) {
        const x = rng.int(0, S - 1);
        const y = rng.int(2, S - 1);
        pc.set(x, y, shade(accent, 0.8));
        pc.set(x, y - 1, accent);
        if (rng.chance(0.4)) pc.set(x + rng.pick([-1, 1]), y - 2, shade(accent, 1.15));
      }
      break;
    case 'plate': {
      const hi = shade(base, 1.15);
      pc.hline(0, 0, S, hi);
      pc.vline(0, 0, S, hi);
      pc.hline(0, S - 1, S, accent);
      pc.vline(S - 1, 0, S, accent);
      for (const [x, y] of [
        [3, 3],
        [S - 4, 3],
        [3, S - 4],
        [S - 4, S - 4],
      ] as const) {
        pc.set(x, y, accent);
        pc.set(x - 1, y - 1, hi);
      }
      for (let i = 0; i < 12; i++) pc.set(rng.int(1, S - 2), rng.int(1, S - 2), shade(base, rng.range(0.9, 1.05)));
      if (variant === 1) pc.hline(6, S / 2, S - 12, accent);
      if (variant === 2) pc.vline(S / 2, 6, S - 12, accent);
      break;
    }
    case 'grate':
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (x % 4 === 0 || y % 4 === 0) pc.set(x, y, shade(base, 1.2));
      for (let y = 2; y < S; y += 4) for (let x = 2; x < S; x += 4) pc.set(x, y, accent);
      break;
    case 'hazard':
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (((x + y) >> 3) % 2 === 0) pc.set(x, y, accent);
      pc.hline(0, 0, S, shade(base, 1.2));
      pc.hline(0, S - 1, S, shade(base, 0.6));
      break;
    case 'rock': {
      const top = shade(base, 1.15);
      pc.rect(0, 0, S, S, top);
      for (let i = 0; i < 6; i++) {
        const x = rng.int(0, S - 8);
        const y = rng.int(0, S - 8);
        pc.rect(x, y, rng.int(3, 7), rng.int(2, 5), base);
      }
      for (let i = 0; i < 30; i++) pc.set(rng.int(0, S - 1), rng.int(0, S - 1), shade(top, 1.1));
      if (front) {
        const face = 14;
        pc.rect(0, S - face, S, face, accent);
        for (let y = S - face; y < S; y += 4) pc.hline(0, y, S, shade(accent, 0.8));
        for (let i = 0; i < 10; i++) pc.set(rng.int(0, S - 1), rng.int(S - face, S - 1), shade(accent, 1.25));
        pc.hline(0, S - face, S, shade(base, 0.6));
      }
      break;
    }
    case 'wall': {
      const top = shade(base, 1.1);
      pc.rect(0, 0, S, S, top);
      pc.hline(0, 0, S, shade(top, 1.25));
      pc.rect(4, 4, S - 8, S - 8, base);
      if (front) {
        const face = 16;
        pc.rect(0, S - face, S, face, shade(base, 0.8));
        pc.hline(0, S - face, S, accent);
        pc.vline(variant % 2 ? 10 : 22, S - face + 2, face - 3, shade(base, 0.6));
        pc.hline(3, S - 6, S - 6, shade(base, 0.65));
        if (variant === 3) pc.rect(13, S - face + 4, 6, 2, [214, 168, 72]);
      }
      break;
    }
  }
  return pc;
}
