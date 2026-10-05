import { hashInts, Rng } from '../../core/rng';
import type { PropStyle } from '../../content/types/tile';
import { buildRamp } from '../palette';
import type { PixelCanvas } from '../PixelCanvas';
import { cap, ell, Rig, tri, v, type Ramp, type Shape } from './rig';

/**
 * Tall world decorations (trees, boulders, shrubs), built with the same clay
 * rasterizer as the characters so lighting and outlines match. Each comes in
 * a few variants; `anchor` is the pixel that stands on the tile's base point.
 */
export const PROP_VARIANTS = 3;

export interface PropArt {
  pixels: PixelCanvas;
  anchor: [number, number];
}

const ramp = (hex: string) => buildRamp(hex) as unknown as Ramp;
const NEEDLES = ramp('#3e5a2e');
const NEEDLES_LIGHT = ramp('#58703a');
const BARK = ramp('#6a3c26');
const DEAD_WOOD = ramp('#6e6052');
const STONE = ramp('#7a7670');
const MOSS = ramp('#6c6e34');
const LEAVES = ramp('#5a6a2e');
const LEAVES_DRY = ramp('#7a6a34');

export function generateProp(style: PropStyle, variant: number): PropArt {
  const rng = new Rng(hashInts(variant, style.length, style.charCodeAt(0)));
  switch (style) {
    case 'pine':
      return pine(rng, variant);
    case 'dead_tree':
      return deadTree(rng);
    case 'boulder':
      return boulder(rng, variant);
    case 'bush':
      return bush(rng, variant);
  }
}

function pine(rng: Rng, variant: number): PropArt {
  const W = 52;
  const H = 96;
  const cx = 26;
  const base = 92;
  const rig = new Rig(W, H);
  const height = 78 + variant * 4;
  const top = base - height;
  rig.add({ region: 0, ramp: BARK }, [cap(v(cx, base), v(cx, top + 30), 2.6, 1.6), ell(v(cx, base - 0.5), 3.4, 1.4)]);
  // Tiers from the bottom up, each a ragged cone; upper tiers overlap lower ones.
  const tiers = 6;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const bottom = base - 12 - t * (height - 22);
    const half = 21 - t * 15 + rng.range(-1, 1);
    const apex = bottom - (12 - t * 3);
    const shapes: Shape[] = [tri(v(cx - half, bottom), v(cx + half, bottom), v(cx + rng.range(-0.8, 0.8), apex), { dome: 0.7 })];
    // Drooping needle clumps along the bottom edge.
    for (let k = -2; k <= 2; k++) {
      const x = cx + (k / 2.4) * half;
      shapes.push(tri(v(x - 3.2, bottom - 2), v(x + 3.2, bottom - 2), v(x + rng.range(-1.5, 1.5), bottom + 2.6), { dome: 0.5 }));
    }
    rig.add({ region: 0, ramp: i % 2 ? NEEDLES_LIGHT : NEEDLES, relief: 0.8 }, shapes);
  }
  rig.add({ region: 0, ramp: NEEDLES_LIGHT }, [tri(v(cx - 3, top + 8), v(cx + 3, top + 8), v(cx, top - 1))]);
  return { pixels: rig.finish(), anchor: [cx, base] };
}

function deadTree(rng: Rng): PropArt {
  const W = 48;
  const H = 80;
  const cx = 24;
  const base = 76;
  const rig = new Rig(W, H);
  const shapes: Shape[] = [cap(v(cx, base), v(cx + rng.range(-2, 2), 22), 3, 1.4), ell(v(cx, base - 0.5), 4, 1.6)];
  // Bare branches reaching up and out, with twigs.
  for (let i = 0; i < 5; i++) {
    const y = 58 - i * 8 + rng.range(-2, 2);
    const side = i % 2 ? 1 : -1;
    const len = 9 + rng.range(0, 7) - i;
    const end = v(cx + side * len, y - len * 0.8);
    shapes.push(cap(v(cx, y), end, 1.4, 0.6));
    shapes.push(cap(end, v(end.x + side * 3, end.y - 4), 0.6, 0.4));
  }
  rig.add({ region: 0, ramp: DEAD_WOOD }, shapes);
  return { pixels: rig.finish(), anchor: [cx, base] };
}

function boulder(rng: Rng, variant: number): PropArt {
  const W = 40;
  const H = 34;
  const cx = 20;
  const base = 29;
  const rig = new Rig(W, H);
  const lumps: Shape[] = [ell(v(cx, base - 8), 13 + variant, 9)];
  for (let i = 0; i < 3; i++) lumps.push(ell(v(cx + rng.range(-8, 8), base - 8 - rng.range(0, 7)), rng.range(5, 8), rng.range(4, 6)));
  const rock = rig.add({ region: 0, ramp: STONE }, lumps);
  rig.decal(MOSS, [ell(v(cx - 3, base - 15), 8, 3.4)], { parts: [rock] });
  for (let i = 0; i < 4; i++) {
    const x = cx + rng.range(-9, 9);
    const y = base - rng.range(4, 12);
    rig.markLine(v(x, y), v(x + rng.range(-2, 2), y + 3), 1);
  }
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}

function bush(rng: Rng, variant: number): PropArt {
  const W = 36;
  const H = 28;
  const cx = 18;
  const base = 24;
  const rig = new Rig(W, H);
  const r = variant === 2 ? LEAVES_DRY : LEAVES;
  const blobs: Shape[] = [];
  for (let i = 0; i < 6; i++) blobs.push(ell(v(cx + rng.range(-9, 9), base - 5 - rng.range(0, 7)), rng.range(4, 6.5), rng.range(3.5, 5)));
  rig.add({ region: 0, ramp: r, relief: 1.2 }, blobs);
  const top: Shape[] = [];
  for (let i = 0; i < 3; i++) top.push(ell(v(cx + rng.range(-6, 6), base - 9 - rng.range(0, 5)), rng.range(3, 4.5), rng.range(2.5, 3.5)));
  rig.add({ region: 0, ramp: r, relief: 1.2 }, top);
  return { pixels: rig.finish(), anchor: [cx, base - 2] };
}
