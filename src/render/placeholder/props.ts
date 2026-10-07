import { hashInts, Rng } from '../../core/rng';
import type { PropStyle } from '../../content/types/tile';
import { buildRamp } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { cap, ell, Rig, tri, v, type Ramp, type Shape } from './rig';

/**
 * Tall world decorations (trees, boulders, shrubs), built with the same clay
 * rasterizer as the characters so lighting and outlines match. Each comes in
 * a few variants; `anchor` is the pixel that stands on the tile's base point.
 */
export const PROP_VARIANTS = 3;
/** Props that line up with their neighbors (fences): drawn exactly on the tile, never nudged or mirrored. */
export const ALIGNED_PROPS: ReadonlySet<PropStyle> = new Set(['fence_h', 'fence_v', 'fence_broken', 'barricade', 'sign', 'campfire', 'lamp_post']);

export interface PropArt {
  pixels: PixelCanvas;
  anchor: [number, number];
}

const ramp = (hex: string) => buildRamp(hex) as unknown as Ramp;
const NEEDLES = ramp('#3e5a2e');
const NEEDLES_LIGHT = ramp('#58703a');
const BARK = ramp('#6a3c26');
const DEAD_WOOD = ramp('#6e6052');
const CHARCOAL = ramp('#2e2a28');
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
    case 'charred_tree':
      return deadTree(rng, CHARCOAL);
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
    case 'fence_h':
      return fenceH(rng, variant);
    case 'fence_v':
      return fenceV(rng, variant);
    case 'fence_broken':
      return fenceBroken(rng, variant);
    case 'barricade':
      return barricade(rng, variant);
    case 'sign':
      return mineSign(variant);
    case 'campfire':
      return campfire(rng);
    case 'lamp_post':
      return lampPost(variant);
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

function deadTree(rng: Rng, wood = DEAD_WOOD): PropArt {
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
  rig.add({ region: 0, ramp: wood }, shapes);
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

const WOOD = buildRamp('#7a5a3a');
const WOOD_GREY = buildRamp('#7a7062');
const NAIL = buildRamp('#8a8a84');

/** A weathered plank: lit top edge, dark bottom edge, grain flecks. Pixel art straight onto the canvas. */
function board(pc: PixelCanvas, rng: Rng, x0: number, y0: number, w: number, h: number, wood: typeof WOOD): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let tone = y === 0 ? 4 : y === h - 1 ? 1 : 3;
      if (tone === 3 && rng.chance(0.12)) tone = 2;
      pc.set(x0 + x, y0 + y, wood[tone]!);
    }
  }
}

/** A plank fence running east-west: a post at the left edge, two rails across the whole tile, pickets. */
function fenceH(rng: Rng, variant: number): PropArt {
  const W = 32;
  const H = 30;
  const base = 26;
  const pc = new PixelCanvas(W, H);
  const wood = WOOD;
  // Pickets (with gaps), rails over them, then the post.
  for (let x = 2; x < W; x += 5) {
    const top = base - 19 - (rng.chance(0.3) ? 2 : 0);
    if (variant === 1 && x === 17) continue; // a missing picket
    for (let y = top; y < base; y++) for (let k = 0; k < 3; k++) pc.set(x + k, y, wood[k === 0 ? 4 : k === 2 ? 1 : y === top ? 4 : 3]!);
    pc.set(x + 1, top - 1, wood[2]!);
  }
  board(pc, rng, 0, base - 15, W, 3, wood);
  board(pc, rng, 0, base - 7, W, 3, wood);
  for (let y = base - 22; y < base + 1; y++) for (let k = 0; k < 3; k++) pc.set(k, y, wood[k === 0 ? 3 : k === 2 ? 0 : 2]!);
  pc.set(1, base - 14, NAIL[4]!);
  pc.set(1, base - 6, NAIL[4]!);
  return { pixels: pc, anchor: [16, base] };
}

/** A plank fence running north-south, seen end-on: posts and the rails' top edges in a narrow band. */
function fenceV(rng: Rng, variant: number): PropArt {
  const W = 32;
  const H = 52;
  const base = 46;
  const pc = new PixelCanvas(W, H);
  const wood = WOOD;
  const x0 = 13;
  // The pickets' tops seen from above form a strip, a tile tall, raised 18px off the ground.
  for (let y = base - 50; y < base - 18; y++) {
    for (let k = 0; k < 6; k++) pc.set(x0 + k, y, wood[k === 0 ? 4 : k === 5 ? 1 : (y + rng.int(0, 1)) % 5 === 0 ? 2 : 3]!);
  }
  // Its face, dropping to the ground along the strip's bottom end.
  for (let y = base - 18; y < base; y++) for (let k = 0; k < 6; k++) pc.set(x0 + k, y, wood[k === 0 ? 2 : k === 5 ? 0 : 1]!);
  // A post at the north end.
  for (let y = base - 52; y < base - 44; y++) for (let k = -1; k < 7; k++) pc.set(x0 + k, Math.max(0, y), wood[k < 0 ? 4 : k > 5 ? 0 : 2]!);
  return { pixels: pc, anchor: [16, base] };
}

/** What's left of a fence: stumps of posts and a snapped rail on the ground. */
function fenceBroken(rng: Rng, variant: number): PropArt {
  const W = 32;
  const H = 16;
  const base = 12;
  const pc = new PixelCanvas(W, H);
  const wood = WOOD;
  for (let i = 0; i < 4; i++) {
    const x = rng.int(1, W - 4);
    const h = rng.int(2, 6);
    for (let y = base - h; y <= base; y++) for (let k = 0; k < 3; k++) pc.set(x + k, y, wood[k === 0 ? 4 : k === 2 ? 1 : 3]!);
    pc.set(x + 1, base - h - 1, wood[2]!);
  }
  const len = rng.int(10, 18);
  const x0 = rng.int(0, W - len - 1);
  for (let i = 0; i < len; i++) {
    const y = base + 1 + Math.round((i / len) * 2);
    pc.set(x0 + i, y, wood[3]!);
    pc.set(x0 + i, y - 1, wood[4]!);
  }
  return { pixels: pc, anchor: [16, base] };
}

/** A barricade blocking a doorway: boards nailed across at angles over a cross brace, sandbags at the foot. */
function barricade(rng: Rng, variant: number): PropArt {
  const W = 34;
  const H = 40;
  const base = 34;
  const pc = new PixelCanvas(W, H);
  const wood = variant === 2 ? WOOD_GREY : WOOD;
  // The cross brace behind.
  for (let i = 0; i < 30; i++) {
    for (let k = 0; k < 3; k++) {
      pc.set(2 + i, base - 30 + i + k, wood[k === 0 ? 3 : 1]!);
      pc.set(31 - i, base - 30 + i + k, wood[k === 0 ? 2 : 1]!);
    }
  }
  // Boards across, each a little skewed.
  for (const y of [base - 26, base - 18, base - 10]) {
    const tilt = rng.range(-0.12, 0.12);
    for (let x = 0; x < W; x++) {
      const yy = Math.round(y + (x - W / 2) * tilt);
      for (let k = 0; k < 4; k++) pc.set(x, yy + k, wood[k === 0 ? 4 : k === 3 ? 1 : rng.chance(0.1) ? 2 : 3]!);
    }
    pc.set(3, y + 1, NAIL[4]!);
    pc.set(W - 4, y + 1, NAIL[4]!);
  }
  // Sandbags.
  const BAG = buildRamp(variant === 1 ? '#7a7454' : '#8a7a58');
  for (const bx of [1, 12, 23]) {
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) {
      const edge = (x === 0 || x === 9) && (y === 0 || y === 5);
      if (!edge) pc.set(bx + x, base - 5 + y, BAG[y === 0 ? 4 : y === 5 ? 1 : 3]!);
    }
  }
  return { pixels: pc, anchor: [17, base] };
}

/** A minefield warning: a red triangle with a skull, nailed to a leaning post. */
function mineSign(variant: number): PropArt {
  const W = 28;
  const H = 40;
  const base = 36;
  const pc = new PixelCanvas(W, H);
  const lean = variant === 1 ? 1 : variant === 2 ? -1 : 0;
  for (let y = 10; y <= base; y++) {
    const x = 13 + Math.round(((base - y) / 26) * lean);
    pc.set(x, y, WOOD[3]!);
    pc.set(x + 1, y, WOOD[1]!);
  }
  // The plate: a red triangle on white, with a skull.
  const RED = buildRamp('#b8322a');
  for (let y = 0; y < 15; y++) {
    const half = Math.floor((y + 1) * 0.85);
    for (let x = -half; x <= half; x++) pc.set(14 + x + lean, 2 + y, (Math.abs(x) >= half - 1 || y >= 13 ? RED[y >= 13 ? 1 : 3] : [226, 222, 206])!);
  }
  const skull: [number, number][] = [[-1, 7], [0, 7], [1, 7], [-2, 8], [2, 8], [-2, 9], [0, 9], [2, 9], [-1, 10], [1, 10], [-1, 12], [1, 12], [0, 11]];
  for (const [x, y] of skull) pc.set(14 + x + lean, 2 + y, [40, 34, 30]);
  pc.set(13 + lean, 9, [226, 222, 206]);
  pc.set(15 + lean, 9, [226, 222, 206]);
  return { pixels: pc, anchor: [14, base] };
}

/** A campfire: a ring of stones, crossed logs, flames and embers. */
function campfire(rng: Rng): PropArt {
  const W = 30;
  const H = 30;
  const base = 24;
  const pc = new PixelCanvas(W, H);
  const STONE_R = buildRamp('#7a7670');
  const LOG = buildRamp('#5a3a24');
  // Stones round the pit.
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const x = Math.round(15 + Math.cos(a) * 11);
    const y = Math.round(base - 2 + Math.sin(a) * 4);
    pc.rect(x - 1, y - 1, 3, 2, STONE_R[a > Math.PI ? 3 : 2]!);
    pc.set(x - 1, y - 1, STONE_R[4]!);
  }
  // Logs, crossed.
  for (let i = 0; i < 14; i++) {
    pc.set(8 + i, base - 2 - Math.round(i * 0.25), LOG[i % 3 ? 3 : 1]!);
    pc.set(8 + i, base - 1 - Math.round(i * 0.25), LOG[1]!);
    pc.set(21 - i, base - 2 - Math.round(i * 0.25), LOG[i % 3 ? 2 : 1]!);
    pc.set(21 - i, base - 1 - Math.round(i * 0.25), LOG[0]!);
  }
  // Flames: layered tongues, hot at the core.
  const FIRE: [number, number, number][] = [[200, 60, 20], [240, 120, 30], [255, 190, 60], [255, 240, 170]];
  for (let k = 0; k < 4; k++) {
    const h = 14 - k * 3;
    const w = 6 - k;
    for (let y = 0; y < h; y++) {
      const half = Math.max(0, Math.round(w * (1 - y / h) + (rng.next() - 0.5)));
      for (let x = -half; x <= half; x++) pc.set(15 + x + (y > h / 2 ? Math.round(Math.sin(y + k) * 1) : 0), base - 4 - y, FIRE[k]!);
    }
  }
  for (let i = 0; i < 5; i++) pc.set(rng.int(10, 20), rng.int(2, 8), [255, 170, 60]);
  return { pixels: pc, anchor: [15, base] };
}

/** A lamp post: a pole with a hooded lamp, glowing. */
function lampPost(variant: number): PropArt {
  const W = 20;
  const H = 66;
  const base = 62;
  const pc = new PixelCanvas(W, H);
  const POLE = buildRamp(variant === 1 ? '#4a5a4a' : '#55595c');
  for (let y = 8; y <= base; y++) {
    pc.set(9, y, POLE[3]!);
    pc.set(10, y, POLE[1]!);
  }
  pc.rect(7, base - 2, 6, 3, POLE[2]!);
  // Arm and hood.
  for (let x = 10; x <= 15; x++) pc.set(x, 8, POLE[3]!);
  pc.rect(12, 6, 6, 3, POLE[2]!);
  pc.hline(12, 6, 6, POLE[4]!);
  // The lamp itself, lit.
  pc.rect(13, 9, 4, 2, [255, 236, 170]);
  pc.hline(13, 11, 4, [255, 210, 120]);
  return { pixels: pc, anchor: [10, base] };
}
