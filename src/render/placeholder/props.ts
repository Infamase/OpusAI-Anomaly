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
const BIRCH_BARK = ramp('#c8c2b0');
const BIRCH_LEAVES = ramp('#6a7a34');
const BIRCH_LEAVES_LIGHT = ramp('#86903e');
const REED = ramp('#7a7a3a');
const CATTAIL = ramp('#6a4428');
const RUST = ramp('#7a4a30');
const PAINT = ramp('#5a6a64');
const GLASS = ramp('#2a3436');
const TYRE = ramp('#2a2826');
const CONCRETE = ramp('#7a766c');
const REBAR = ramp('#6a4a36');
const STEEL = ramp('#5a646c');
const STEEL_DARK = ramp('#3e464c');
const SCREEN = ramp('#2a6a5a');
const SCREEN_BLUE = ramp('#2a4a7a');
const HAZARD = ramp('#c8a030');
const FABRIC = ramp('#5a6a4a');
const SHEET = ramp('#a8a8a0');

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
    case 'leafy_tree':
      return leafyTree(rng, variant);
    case 'reeds':
      return reeds(rng, variant);
    case 'wreck':
      return wreck(rng, variant);
    case 'rubble':
      return rubble(rng, variant);
    case 'console':
      return consoleProp(rng, variant);
    case 'machine':
      return machine(rng, variant);
    case 'bunk':
      return bunk(variant);
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

/** A birch: pale trunk with dark marks, a rounded, layered canopy. */
function leafyTree(rng: Rng, variant: number): PropArt {
  const W = 56;
  const H = 84;
  const cx = 28;
  const base = 80;
  const rig = new Rig(W, H);
  const lean = rng.range(-2, 2);
  const trunk = rig.add({ region: 0, ramp: BIRCH_BARK }, [cap(v(cx, base), v(cx + lean, base - 50), 2.6, 1.8), ell(v(cx, base - 0.5), 3.4, 1.4)]);
  for (let i = 0; i < 6; i++) {
    const y = base - 6 - i * 7 - rng.range(0, 3);
    rig.decal(ramp('#3a3630'), [ell(v(cx + lean * ((base - y) / 50) + rng.range(-1, 1), y), rng.range(1.2, 2.2), 0.7)], { parts: [trunk] });
  }
  const top = base - 42 - variant * 3;
  const blobs = [];
  for (let i = 0; i < 9; i++) blobs.push(ell(v(cx + lean + rng.range(-16, 16), top + rng.range(-14, 16)), rng.range(8, 12), rng.range(7, 10)));
  rig.add({ region: 0, ramp: BIRCH_LEAVES, relief: 1.1 }, blobs);
  const hi = [];
  for (let i = 0; i < 4; i++) hi.push(ell(v(cx + lean + rng.range(-10, 6), top - 6 + rng.range(-5, 6)), rng.range(4, 7), rng.range(3.5, 5.5)));
  rig.add({ region: 0, ramp: BIRCH_LEAVES_LIGHT, relief: 1.1 }, hi);
  return { pixels: rig.finish(), anchor: [cx, base] };
}

/** A clump of reeds with a couple of cattail heads. */
function reeds(rng: Rng, variant: number): PropArt {
  const W = 30;
  const H = 36;
  const cx = 15;
  const base = 32;
  const rig = new Rig(W, H);
  const stalks = [];
  const heads = [];
  const n = 11 + variant * 3;
  for (let i = 0; i < n; i++) {
    const x = cx + rng.range(-9, 9);
    const h = rng.range(14, 26);
    const tip = v(x + rng.range(-4, 4), base - h);
    stalks.push(cap(v(x, base), tip, 1.1, 0.5));
    if (i % 3 === 0) heads.push(cap(v(tip.x, tip.y + 2), v(tip.x, tip.y + 7), 1.4, 1.4));
  }
  rig.add({ region: 0, ramp: REED }, stalks);
  if (heads.length) rig.add({ region: 0, ramp: CATTAIL }, heads);
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}

/** A rusted-out car seen from the side and above: boxy body, cabin, dark windows, flat tyres. */
function wreck(rng: Rng, variant: number): PropArt {
  const W = 72;
  const H = 44;
  const cx = 36;
  const base = 38;
  const rig = new Rig(W, H);
  const f = variant % 2 ? -1 : 1;
  const box = (x0: number, y0: number, x1: number, y1: number, inset = 0) => [
    tri(v(x0, y1), v(x1, y1), v(x1 - inset, y0), { dome: 0.25 }),
    tri(v(x0, y1), v(x1 - inset, y0), v(x0 + inset, y0), { dome: 0.25 }),
  ];
  rig.add({ region: 0, ramp: TYRE }, [ell(v(cx - 18, base - 3), 4.6, 3.6), ell(v(cx + 18, base - 3), 4.6, 3.6)]);
  const paint = variant === 2 ? RUST : PAINT;
  // Lower body (bonnet at the front is lower), then the cabin on top, set back.
  const body = rig.add({ region: 0, ramp: paint }, [...box(cx - 30, base - 15, cx + 30, base - 4, 2)]);
  const cabin = rig.add({ region: 0, ramp: paint }, box(cx - 14 - 4 * f, base - 25, cx + 12 - 4 * f, base - 14, 5));
  rig.decal(GLASS, box(cx - 11 - 4 * f, base - 23, cx - 1 - 4 * f, base - 16, 3), { parts: [cabin] });
  rig.decal(GLASS, box(cx + 1 - 4 * f, base - 23, cx + 9 - 4 * f, base - 16, 3), { parts: [cabin] });
  for (let i = 0; i < 6; i++) rig.decal(RUST, [ell(v(cx + rng.range(-26, 26), base - rng.range(6, 20)), rng.range(2.5, 5.5), rng.range(1.5, 3))], { parts: [body, cabin] });
  rig.markLine(v(cx - 29, base - 9), v(cx + 29, base - 9), 1);
  return { pixels: rig.finish(), anchor: [cx, base - 2] };
}

/** A low heap of broken concrete with a bent bar sticking out. */
function rubble(rng: Rng, variant: number): PropArt {
  const W = 40;
  const H = 26;
  const cx = 20;
  const base = 22;
  const rig = new Rig(W, H);
  const chunks = [];
  for (let i = 0; i < 7 + variant; i++) chunks.push(ell(v(cx + rng.range(-8, 8), base - rng.range(3, 8)), rng.range(4, 7), rng.range(3, 4.5)));
  rig.add({ region: 0, ramp: CONCRETE }, chunks);
  rig.add({ region: 0, ramp: REBAR }, [cap(v(cx + rng.range(-6, 2), base - 6), v(cx + rng.range(4, 10), base - 16), 0.7, 0.6)]);
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}

const box = (x0: number, y0: number, x1: number, y1: number, inset = 0) => [
  tri(v(x0, y1), v(x1, y1), v(x1 - inset, y0), { dome: 0.2 }),
  tri(v(x0, y1), v(x1 - inset, y0), v(x0 + inset, y0), { dome: 0.2 }),
];

/** A computer console: a cabinet with a glowing screen and a row of buttons. */
function consoleProp(rng: Rng, variant: number): PropArt {
  const W = 36;
  const H = 40;
  const cx = 18;
  const base = 36;
  const rig = new Rig(W, H);
  const cab = rig.add({ region: 0, ramp: STEEL }, box(cx - 14, base - 30, cx + 14, base, 1));
  rig.decal(variant === 1 ? SCREEN_BLUE : SCREEN, box(cx - 10, base - 27, cx + 10, base - 15, 0), { parts: [cab] });
  for (let i = 0; i < 5; i++) rig.decal(rng.chance(0.4) ? HAZARD : STEEL_DARK, [ell(v(cx - 9 + i * 4.5, base - 9), 1.3, 1)], { parts: [cab] });
  rig.markLine(v(cx - 13, base - 13), v(cx + 13, base - 13), 1);
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}

/** Machinery: a squat generator drum with pipes and a hazard band. */
function machine(rng: Rng, variant: number): PropArt {
  const W = 40;
  const H = 52;
  const cx = 20;
  const base = 48;
  const rig = new Rig(W, H);
  rig.add({ region: 0, ramp: STEEL_DARK }, box(cx - 16, base - 10, cx + 16, base, 0));
  const drum = rig.add({ region: 0, ramp: STEEL, relief: 1.2 }, [cap(v(cx, base - 10), v(cx, base - 38), 12, 12), ell(v(cx, base - 38), 12, 5)]);
  rig.decal(HAZARD, [cap(v(cx - 12, base - 22), v(cx + 12, base - 22), 1.6, 1.6)], { parts: [drum] });
  const pipeX = variant % 2 ? cx - 15 : cx + 15;
  rig.add({ region: 0, ramp: STEEL_DARK }, [cap(v(pipeX, base - 2), v(pipeX, base - 30 - rng.range(0, 6)), 2.2, 2.2)]);
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}

/** A bunk: metal frame, a thin mattress and a pillow. */
function bunk(variant: number): PropArt {
  const W = 36;
  const H = 26;
  const cx = 18;
  const base = 22;
  const rig = new Rig(W, H);
  rig.add({ region: 0, ramp: STEEL_DARK }, [...box(cx - 15, base - 8, cx + 15, base, 0)]);
  const mat = rig.add({ region: 0, ramp: variant === 2 ? SHEET : FABRIC, relief: 0.8 }, box(cx - 14, base - 13, cx + 14, base - 6, 1));
  rig.decal(SHEET, [ell(v(cx - 10, base - 10), 3.5, 2)], { parts: [mat] });
  return { pixels: rig.finish(), anchor: [cx, base - 1] };
}
