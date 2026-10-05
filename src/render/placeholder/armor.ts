import type { SpriteLayoutDef } from '../../content/types';
import { layoutSheetSize } from '../../content/types/spriteLayout';
import { KEY_COLORS, hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { BodyPart, drawBodyFrame, PLACEHOLDER_OUTLINE, poseFor, type PlaceholderRace } from './characters';

/**
 * Generates placeholder armor sheets that fit each race's body exactly.
 *
 * It draws the race's body for every frame, reads the per-pixel body-part tags
 * (head, ears, eyes, torso, arms, hands, legs, feet, tail) and paints gear onto
 * those parts. The same few rules therefore fit humans, snouted lizardmen and
 * wedge-headed, big-eared sergals. And because tails drawn in front of the body
 * overwrite the tags beneath them, gear never covers a tail that is in front.
 *
 * Main fabric/plating uses the SECONDARY key colors, so each armor item is
 * recolored ("dyed") by its content definition like any palette swap.
 */
export const ARMOR_SLOTS = ['head', 'torso', 'legs'] as const;
export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

export const ARMOR_STYLES = {
  head: ['hood', 'helmet'],
  torso: ['jacket', 'plate_vest'],
  legs: ['pants', 'plate_legs'],
} as const satisfies Record<ArmorSlot, readonly string[]>;
export type ArmorStyle = (typeof ARMOR_STYLES)[ArmorSlot][number];
export const ALL_ARMOR_STYLES = Object.values(ARMOR_STYLES).flat() as ArmorStyle[];

const DYE = KEY_COLORS.secondary.map(hexToRgb) as [RGB, RGB, RGB, RGB];
const LEATHER: [RGB, RGB, RGB, RGB] = [
  [34, 26, 22],
  [52, 40, 32],
  [70, 55, 42],
  [92, 74, 56],
];
const METAL: [RGB, RGB, RGB, RGB] = [
  [58, 63, 70],
  [86, 93, 102],
  [120, 128, 138],
  [168, 176, 184],
];
const VISOR: [RGB, RGB, RGB, RGB] = [
  [30, 82, 96],
  [44, 118, 134],
  [72, 160, 176],
  [150, 226, 236],
];
const STRAP: [RGB, RGB, RGB, RGB] = [
  [26, 22, 20],
  [34, 28, 24],
  [40, 33, 28],
  [52, 44, 36],
];

const enum Mat {
  None = 0,
  Dye = 1,
  Leather = 2,
  Metal = 3,
  Visor = 4,
  Strap = 5,
}
const RAMPS: Record<Exclude<Mat, Mat.None>, readonly [RGB, RGB, RGB, RGB]> = {
  [Mat.Dye]: DYE,
  [Mat.Leather]: LEATHER,
  [Mat.Metal]: METAL,
  [Mat.Visor]: VISOR,
  [Mat.Strap]: STRAP,
};

const S = 48;
type Dir = 'down' | 'up' | 'right';

/** Material map for one frame, then shaded into pixels. */
class MatMap {
  readonly m = new Uint8Array(S * S);
  get(x: number, y: number): Mat {
    return x < 0 || y < 0 || x >= S || y >= S ? Mat.None : (this.m[y * S + x] as Mat);
  }
  set(x: number, y: number, mat: Mat): void {
    if (x >= 0 && y >= 0 && x < S && y < S) this.m[y * S + x] = mat;
  }
  /** Light from the top-left: exposed top = highlight, right = shade, bottom = deep shade. */
  render(out: PixelCanvas): void {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const mat = this.get(x, y);
        if (mat === Mat.None) continue;
        let shade = 2;
        if (this.get(x, y - 1) !== mat) shade = 3;
        if (this.get(x + 1, y) !== mat) shade = 1;
        if (this.get(x, y + 1) !== mat) shade = 0;
        out.set(x, y, RAMPS[mat][shade]!);
      }
    }
  }
}

interface Parts {
  body: PixelCanvas;
  is(x: number, y: number, ...parts: number[]): boolean;
  /** All pixels tagged with any of `parts`. */
  pixels(...parts: number[]): [number, number][];
  rows(...parts: number[]): { top: number; bottom: number } | null;
  /** Leftmost/rightmost column of `parts` in row y. */
  span(y: number, ...parts: number[]): { l: number; r: number } | null;
}

function partsOf(body: PixelCanvas): Parts {
  const is = (x: number, y: number, ...parts: number[]) => body.alpha(x, y) > 0 && parts.includes(body.regionAt(x, y));
  return {
    body,
    is,
    pixels(...parts) {
      const out: [number, number][] = [];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (is(x, y, ...parts)) out.push([x, y]);
      return out;
    },
    rows(...parts) {
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (!is(x, y, ...parts)) continue;
          if (top < 0) top = y;
          bottom = y;
          break;
        }
      }
      return top < 0 ? null : { top, bottom };
    },
    span(y, ...parts) {
      let l = -1;
      let r = -1;
      for (let x = 0; x < S; x++) {
        if (!is(x, y, ...parts)) continue;
        if (l < 0) l = x;
        r = x;
      }
      return l < 0 ? null : { l, r };
    },
  };
}

const HEADISH = [BodyPart.HEAD, BodyPart.EYE];

function paintHead(p: Parts, mm: MatMap, style: ArmorStyle, dir: Dir): void {
  const rows = p.rows(...HEADISH);
  if (!rows) return;
  const hh = rows.bottom - rows.top + 1;
  const eyes = p.pixels(BodyPart.EYE);
  const eyeRow = eyes.length ? Math.min(...eyes.map(([, y]) => y)) : rows.top + Math.round(hh * 0.55);
  const eyeX = eyes.length ? Math.min(...eyes.map(([x]) => x)) : 24;

  if (style === 'hood') {
    const sideLimit = rows.top + Math.round(hh * 0.8);
    for (const [x, y] of p.pixels(...HEADISH)) {
      const sp = p.span(y, ...HEADISH)!;
      let cover: boolean;
      if (dir === 'up') cover = y <= rows.top + Math.round(hh * 0.85);
      else if (dir === 'down') cover = y < eyeRow - 1 || ((x <= sp.l + 1 || x >= sp.r - 1) && y <= sideLimit);
      else cover = y < eyeRow - 1 || (x < eyeX - 2 && y <= sideLimit);
      if (cover) mm.set(x, y, Mat.Dye);
    }
    // Bulk: the hood sits a pixel proud of the skull on top and at the sides.
    for (let y = rows.top; y <= sideLimit; y++) {
      const sp = p.span(y, ...HEADISH);
      if (!sp) continue;
      if (mm.get(sp.l, y)) mm.set(sp.l - 1, y, Mat.Dye);
      if (mm.get(sp.r, y) && dir !== 'right') mm.set(sp.r + 1, y, Mat.Dye);
    }
    const top = p.span(rows.top, ...HEADISH);
    if (top) for (let x = top.l + 1; x < top.r; x++) mm.set(x, rows.top - 1, Mat.Dye);
    return;
  }

  // Helmet: covers the cranium (and ears, as ear guards) down past the eyes; visor over the eyes.
  const limit = Math.max(rows.top + Math.round(hh * 0.55), eyeRow + 1);
  const cranium = dir === 'up' ? rows.top + Math.round(hh * 0.75) : limit;
  for (const [x, y] of p.pixels(BodyPart.HEAD, BodyPart.EYE, BodyPart.EAR)) {
    if (y <= cranium || p.is(x, y, BodyPart.EAR)) mm.set(x, y, Mat.Dye);
  }
  for (let y = rows.top; y <= cranium; y++) {
    const sp = p.span(y, ...HEADISH);
    if (!sp) continue;
    mm.set(sp.l - 1, y, Mat.Dye);
    if (dir !== 'right') mm.set(sp.r + 1, y, Mat.Dye);
  }
  const top = p.span(rows.top, ...HEADISH);
  if (top) for (let x = top.l; x <= top.r; x++) mm.set(x, rows.top - 1, Mat.Dye);
  // Rim / chin strap line just under the shell.
  const rim = p.span(cranium, ...HEADISH);
  if (rim) for (let x = rim.l - 1; x <= rim.r + (dir === 'right' ? 0 : 1); x++) if (mm.get(x, cranium)) mm.set(x, cranium, Mat.Strap);
  if (dir === 'up' || !eyes.length) return;
  for (let y = eyeRow; y <= eyeRow + 1; y++) {
    const sp = p.span(y, ...HEADISH);
    if (!sp) continue;
    const from = dir === 'down' ? sp.l + 1 : eyeX - 1;
    const to = dir === 'down' ? sp.r - 1 : sp.r;
    for (let x = from; x <= to; x++) if (mm.get(x, y)) mm.set(x, y, Mat.Visor);
  }
}

function paintTorso(p: Parts, mm: MatMap, style: ArmorStyle, dir: Dir): void {
  const torso = p.rows(BodyPart.TORSO);
  if (!torso) return;
  for (const [x, y] of p.pixels(BodyPart.TORSO, BodyPart.ARM)) mm.set(x, y, Mat.Dye);
  const handRows = p.rows(BodyPart.HAND);
  for (const [x, y] of p.pixels(BodyPart.HAND)) mm.set(x, y, Mat.Leather);
  // Belt / hem along the bottom of the torso.
  const hem = p.span(torso.bottom - 1, BodyPart.TORSO);
  if (hem) for (let x = hem.l; x <= hem.r; x++) if (p.is(x, torso.bottom - 1, BodyPart.TORSO)) mm.set(x, torso.bottom - 1, Mat.Strap);

  if (style === 'jacket') {
    const collar = p.span(torso.top, BodyPart.TORSO);
    if (collar) for (let x = collar.l; x <= collar.r; x++) if (p.is(x, torso.top, BodyPart.TORSO)) mm.set(x, torso.top, Mat.Leather);
    if (dir === 'down') for (let y = torso.top + 1; y < torso.bottom - 1; y++) if (p.is(23, y, BodyPart.TORSO)) mm.set(23, y, Mat.Strap);
    if (dir === 'up') {
      // Small backpack, only where the back is actually visible (a tail may hang in front of it).
      for (let y = torso.top + 2; y < torso.top + 9; y++) for (let x = 20; x < 28; x++) if (p.is(x, y, BodyPart.TORSO)) mm.set(x, y, Mat.Leather);
    }
    return;
  }

  // Plate vest: chest/back plate, shoulder pads, bracers.
  for (let y = torso.top + 2; y <= torso.top + 7; y++) {
    const sp = p.span(y, BodyPart.TORSO);
    if (!sp) continue;
    for (let x = sp.l + 1; x <= sp.r - 1; x++) if (p.is(x, y, BodyPart.TORSO)) mm.set(x, y, Mat.Metal);
  }
  if (dir !== 'up') {
    const mid = p.span(torso.top + 4, BodyPart.TORSO);
    if (mid) for (let x = mid.l + 1; x <= mid.r - 1; x++) if (p.is(x, torso.top + 5, BodyPart.TORSO)) mm.set(x, torso.top + 5, Mat.Dye);
  }
  const arms = p.pixels(BodyPart.ARM);
  const armTop = arms.length ? Math.min(...arms.map(([, y]) => y)) : torso.top;
  for (const [x, y] of arms) {
    if (y <= armTop + 2) {
      mm.set(x, y, Mat.Metal);
      // Pads stick out a pixel away from the torso.
      if (!p.is(x - 1, y, BodyPart.TORSO, BodyPart.ARM)) mm.set(x - 1, y, Mat.Metal);
      if (!p.is(x + 1, y, BodyPart.TORSO, BodyPart.ARM)) mm.set(x + 1, y, Mat.Metal);
    }
    if (handRows && y >= handRows.top - 2 && y < handRows.top) mm.set(x, y, Mat.Metal);
  }
  if (arms.length) for (let x = 0; x < S; x++) if (mm.get(x, armTop) === Mat.Metal) mm.set(x, armTop - 1, Mat.Metal);
}

function paintLegs(p: Parts, mm: MatMap, style: ArmorStyle): void {
  const legs = p.pixels(BodyPart.LEG);
  for (const [x, y] of legs) mm.set(x, y, Mat.Dye);
  for (const [x, y] of p.pixels(BodyPart.FOOT)) mm.set(x, y, style === 'plate_legs' ? Mat.Metal : Mat.Leather);
  if (style !== 'plate_legs' || !legs.length) return;
  // Knee pads: two rows a little below the top of each leg column.
  const topOf = new Map<number, number>();
  for (const [x, y] of legs) topOf.set(x, Math.min(topOf.get(x) ?? 99, y));
  for (const [x, top] of topOf) {
    for (const y of [top + 4, top + 5]) if (mm.get(x, y) === Mat.Dye) mm.set(x, y, Mat.Metal);
  }
}

/** One armor frame for a race, facing down/up/right. Exposed for tests. */
export function drawArmorFrame(race: PlaceholderRace, slot: ArmorSlot, style: ArmorStyle, dir: Dir, anim: string, frame: number): PixelCanvas {
  const body = drawBodyFrame(race, dir, poseFor(anim, frame));
  const parts = partsOf(body);
  const mm = new MatMap();
  if (slot === 'head') paintHead(parts, mm, style, dir);
  else if (slot === 'torso') paintTorso(parts, mm, style, dir);
  else paintLegs(parts, mm, style);
  const out = new PixelCanvas(S, S);
  mm.render(out);
  out.outline(PLACEHOLDER_OUTLINE);
  return out;
}

export function generateArmorSheet(race: PlaceholderRace, slot: ArmorSlot, style: ArmorStyle, layout: SpriteLayoutDef): PixelCanvas {
  const { width, height } = layoutSheetSize(layout);
  const size = layout.frameSize;
  const off = (size - S) / 2;
  const sheet = new PixelCanvas(width, height);
  layout.animations.forEach((anim, a) => {
    layout.directions.forEach((dir, d) => {
      for (let f = 0; f < anim.frames; f++) {
        const frame = drawArmorFrame(race, slot, style, dir === 'left' ? 'right' : dir, anim.id, f);
        sheet.blit(frame, f * size + off, (a * layout.directions.length + d) * size + off, dir === 'left');
      }
    });
  });
  return sheet;
}

export function isArmorStyleForSlot(slot: ArmorSlot, style: string): style is ArmorStyle {
  return (ARMOR_STYLES[slot] as readonly string[]).includes(style);
}
