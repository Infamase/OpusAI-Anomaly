import { PUPPET_DIRS, PUPPET_PARTS, type PartId } from '../puppet';
import { KEY_COLORS, hexToRgb, rgbToHex } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { ATLAS_HEIGHT, ATLAS_WIDTH, blitPiece, BodyPart, FRAME, rigPiece, type PlaceholderRace } from './characters';
import type { Ramp } from './rig';

/**
 * Generates placeholder armor that fits each race's body exactly, as a piece
 * atlas laid out like the body's (see render/puppet.ts): each body piece gets
 * its own armor piece, so gear moves with the limb it's on.
 *
 * It draws each body piece, reads the per-pixel body-part tags
 * (head, ears, eyes, snout, hair, neck, torso, arms, hands, hips, legs, feet,
 * tail) and paints gear onto those parts. The same few rules therefore fit
 * humans, snouted lizardmen and big-eared sergals. Gear reuses the body's
 * lighting (each pixel keeps the tone of the body under it) and its contour
 * lines, so it looks wrapped around the figure, not pasted on.
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

const rgb = (...hex: string[]) => hex.map(hexToRgb) as unknown as Ramp;
const DYE: Ramp = KEY_COLORS.secondary.map(hexToRgb) as unknown as Ramp;
const LEATHER = rgb('#1c1210', '#3a2a20', '#523c2c', '#6a4e38', '#8a6a4c');
const METAL = rgb('#1e2228', '#4a525c', '#6a7480', '#8e98a4', '#c4ccd4');
const VISOR = rgb('#0c2a30', '#1e5864', '#2e7e8c', '#4aa6b2', '#a6e6ee');
const STRAP = rgb('#141010', '#2a2220', '#3a302a', '#4a3e36', '#5e5046');
const BRASS = rgb('#2e2210', '#6a5226', '#94763a', '#b8964e', '#e0c27a');

const enum Mat {
  None = 0,
  Dye = 1,
  Leather = 2,
  Metal = 3,
  Visor = 4,
  Strap = 5,
  Brass = 6,
}
const RAMPS: Record<Exclude<Mat, Mat.None>, Ramp> = {
  [Mat.Dye]: DYE,
  [Mat.Leather]: LEATHER,
  [Mat.Metal]: METAL,
  [Mat.Visor]: VISOR,
  [Mat.Strap]: STRAP,
  [Mat.Brass]: BRASS,
};

/** The darkest tone of every armor material: the only colors gear may put on a body edge it doesn't cover. */
export const ARMOR_OUTLINES = new Set(Object.values(RAMPS).map((r) => rgbToHex(r[0])));

const S = FRAME;
type Dir = 'down' | 'up' | 'right';

interface Body {
  dir: Dir;
  race: PlaceholderRace;
  region(x: number, y: number): number;
  is(x: number, y: number, ...parts: number[]): boolean;
  /** Lit tone of the body pixel (0 = contour line), or -1 if empty. */
  tone(x: number, y: number): number;
  pixels(...parts: number[]): [number, number][];
  rows(...parts: number[]): { top: number; bottom: number } | null;
  span(y: number, ...parts: number[]): { l: number; r: number } | null;
}

function bodyOf(race: PlaceholderRace, dir: Dir, part: PartId): Body | null {
  const rig = rigPiece(race, dir, part);
  if (!rig) return null;
  const canvas = rig.finish();
  const tones = rig.tone!;
  const painted = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S && rig.part[y * S + x]! >= 0;
  const region = (x: number, y: number) => (painted(x, y) ? canvas.regionAt(x, y) : 0);
  const is = (x: number, y: number, ...parts: number[]) => painted(x, y) && parts.includes(region(x, y));
  return {
    dir,
    race,
    region,
    is,
    tone: (x, y) => (painted(x, y) ? tones[y * S + x]! : -1),
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

/** Material per pixel, then shaded with the body's lighting. */
class MatMap {
  readonly m = new Uint8Array(S * S);
  /** Tone overrides (seams, highlights). */
  readonly t = new Int8Array(S * S).fill(-1);
  get(x: number, y: number): Mat {
    return x < 0 || y < 0 || x >= S || y >= S ? Mat.None : (this.m[y * S + x] as Mat);
  }
  set(x: number, y: number, mat: Mat): void {
    if (x >= 0 && y >= 0 && x < S && y < S) this.m[y * S + x] = mat;
  }
  /** Sets only where something is already painted. */
  over(x: number, y: number, mat: Mat): void {
    if (this.get(x, y) !== Mat.None) this.set(x, y, mat);
  }
  line(x: number, y: number, tone: number): void {
    if (this.get(x, y) !== Mat.None) this.t[y * S + x] = tone;
  }

  render(body: Body): PixelCanvas {
    const out = new PixelCanvas(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const mat = this.get(x, y);
        if (mat === Mat.None) continue;
        let tone = body.tone(x, y);
        if (tone < 0) tone = 2; // bulk standing off the body
        else if (tone === 0) tone = 0; // keep the body's contour lines (arm over chest)
        // Layering: a lip of light where a material starts, shade where it tucks under another.
        if (tone > 0) {
          const above = this.get(x, y - 1);
          const below = this.get(x, y + 1);
          if (above !== mat && above !== Mat.None) tone = Math.min(4, tone + 1);
          if (below !== mat && below !== Mat.None && mat !== Mat.Visor) tone = Math.max(1, tone - 1);
        }
        const forced = this.t[y * S + x]!;
        if (forced >= 0) tone = forced;
        out.set(x, y, RAMPS[mat][tone]!);
      }
    }
    // Colored outline around the gear (it also separates gear from bare skin/fur).
    const marks: [number, number, Mat][] = [];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (this.get(x, y) !== Mat.None) continue;
        for (const [dx, dy] of [
          [0, -1],
          [-1, 0],
          [1, 0],
          [0, 1],
        ] as const) {
          const n = this.get(x + dx, y + dy);
          if (n !== Mat.None) {
            marks.push([x, y, n]);
            break;
          }
        }
      }
    }
    for (const [x, y, m] of marks) out.set(x, y, RAMPS[m as Exclude<Mat, Mat.None>][0]);
    return out;
  }
}

const HEADISH = [BodyPart.HEAD, BodyPart.EYE, BodyPart.HAIR, BodyPart.MOUTH];

function eyeInfo(b: Body, rows: { top: number; bottom: number }) {
  const eyes = b.pixels(BodyPart.EYE);
  const hh = rows.bottom - rows.top + 1;
  return {
    row: eyes.length ? Math.min(...eyes.map(([, y]) => y)) : rows.top + Math.round(hh * 0.5),
    minX: eyes.length ? Math.min(...eyes.map(([x]) => x)) : 32,
    maxX: eyes.length ? Math.max(...eyes.map(([x]) => x)) : 32,
  };
}

function paintHead(b: Body, mm: MatMap, style: ArmorStyle): void {
  const rows = b.rows(...HEADISH, BodyPart.SNOUT);
  if (!rows) return;
  const eye = eyeInfo(b, rows);
  const dir = b.dir;
  const skull = b.pixels(...HEADISH, BodyPart.NECK);
  const ears = b.pixels(BodyPart.EAR);
  const humanEars = b.race === 'human';

  if (style === 'hood') {
    // Covers the crown, back and sides of the head and the neck; the face stays open.
    const faceTop = eye.row - 2;
    const cx = (eye.minX + eye.maxX) / 2;
    for (const [x, y] of skull) {
      let open: boolean;
      if (dir === 'up') open = false;
      else if (dir === 'down') open = y >= faceTop && Math.abs(x - cx) <= (eye.maxX - eye.minX) / 2 + 2.5 && b.region(x, y) !== BodyPart.NECK;
      else open = y >= faceTop && x >= eye.minX - 2 && b.region(x, y) !== BodyPart.NECK;
      if (!open) mm.set(x, y, Mat.Dye);
    }
    if (humanEars) for (const [x, y] of ears) mm.set(x, y, Mat.Dye);
    // Fabric bulk: a pixel proud of the head all round (not over the face).
    const covered = skull.filter(([x, y]) => mm.get(x, y) === Mat.Dye);
    for (const [x, y] of covered) {
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
      ] as const) {
        if (!b.is(x + dx, y + dy, ...HEADISH, BodyPart.SNOUT, BodyPart.EAR) && !(dir === 'right' && dx === 1 && y >= faceTop)) mm.set(x + dx, y + dy, Mat.Dye);
      }
    }
    // Drawstring edge around the face opening.
    if (dir !== 'up') {
      for (const [x, y] of covered) {
        const nearFace = [
          [1, 0],
          [-1, 0],
          [0, 1],
        ].some(([dx, dy]) => b.is(x + dx!, y + dy!, ...HEADISH, BodyPart.SNOUT) && mm.get(x + dx!, y + dy!) === Mat.None);
        if (nearFace) mm.line(x, y, 4);
      }
    }
    return;
  }

  // Helmet: a shell over the cranium (and ears), visor across the eyes, chin strap.
  const shellBottom = dir === 'up' ? rows.top + Math.round((rows.bottom - rows.top) * 0.7) : eye.row - 1;
  for (const [x, y] of skull) if (y <= shellBottom && b.region(x, y) !== BodyPart.NECK) mm.set(x, y, Mat.Dye);
  for (const [x, y] of ears) if (y >= rows.top - 4 || humanEars) mm.set(x, y, Mat.Dye);
  // The shell stands off the head by a pixel on top and at the sides.
  for (let y = rows.top - 1; y <= shellBottom; y++) {
    const sp = b.span(Math.max(y, rows.top), ...HEADISH);
    if (!sp) continue;
    if (y < rows.top) {
      for (let x = sp.l; x <= sp.r; x++) mm.set(x, y, Mat.Dye);
      continue;
    }
    mm.set(sp.l - 1, y, Mat.Dye);
    if (dir !== 'right') mm.set(sp.r + 1, y, Mat.Dye);
  }
  // Rim at the shell's edge.
  const rim = b.span(shellBottom, ...HEADISH);
  if (rim) for (let x = rim.l - 1; x <= rim.r + 1; x++) if (mm.get(x, shellBottom) === Mat.Dye) mm.set(x, shellBottom, Mat.Strap);
  // A ridge along the top.
  const top = b.span(rows.top, ...HEADISH);
  if (top && dir !== 'right') mm.line(Math.round((top.l + top.r) / 2), rows.top - 1, 4);
  if (dir === 'up') return;
  // Visor band across the eyes.
  for (let y = eye.row; y <= eye.row + 1; y++) {
    const sp = b.span(y, ...HEADISH, BodyPart.SNOUT);
    if (!sp) continue;
    const from = dir === 'down' ? eye.minX - 1 : eye.minX - 1;
    const to = dir === 'down' ? eye.maxX + 1 : Math.min(sp.r, eye.maxX + 2);
    for (let x = from; x <= to; x++) if (b.is(x, y, ...HEADISH, BodyPart.SNOUT)) mm.set(x, y, Mat.Visor);
  }
  for (let x = eye.minX - 1; x <= eye.maxX + 1; x++) mm.line(x, eye.row, 4);
  // Chin strap down the side of the face.
  const strapX = dir === 'down' ? (rim ? [rim.l, rim.r] : []) : rim ? [rim.l + 1] : [];
  for (const sx of strapX) for (let y = shellBottom + 1; y <= shellBottom + 5; y++) if (b.is(sx, y, ...HEADISH, BodyPart.SNOUT)) mm.set(sx, y, Mat.Strap);
}

function paintTorso(b: Body, mm: MatMap, style: ArmorStyle): void {
  const torso = b.rows(BodyPart.TORSO);
  if (!torso) return;
  const dir = b.dir;
  const hip = b.rows(BodyPart.HIP);
  const hemY = hip ? hip.top + 1 : torso.bottom;
  for (const [x, y] of b.pixels(BodyPart.TORSO, BodyPart.ARM)) mm.set(x, y, Mat.Dye);
  // Collar: the lower neck.
  for (const [x, y] of b.pixels(BodyPart.NECK)) if (y >= torso.top - 2) mm.set(x, y, style === 'jacket' ? Mat.Leather : Mat.Dye);
  // Hem covers the top of the hips.
  for (const [x, y] of b.pixels(BodyPart.HIP)) if (y <= hemY) mm.set(x, y, Mat.Dye);
  // Gloves.
  for (const [x, y] of b.pixels(BodyPart.HAND)) mm.set(x, y, Mat.Leather);
  // Cuffs just above the gloves.
  const hands = b.pixels(BodyPart.HAND);
  for (const [hx, hy] of hands) if (b.is(hx, hy - 1, BodyPart.ARM)) mm.set(hx, hy - 1, Mat.Strap);
  // Belt.
  const beltY = hemY;
  const belt = b.span(beltY, BodyPart.HIP, BodyPart.TORSO);
  if (belt) {
    for (let x = belt.l; x <= belt.r; x++) {
      if (!b.is(x, beltY, BodyPart.HIP, BodyPart.TORSO)) continue;
      mm.set(x, beltY, Mat.Strap);
      mm.set(x, beltY - 1, Mat.Strap);
    }
    if (dir === 'down') {
      const mid = Math.round((belt.l + belt.r) / 2);
      mm.set(mid, beltY, Mat.Brass);
      mm.set(mid, beltY - 1, Mat.Brass);
    }
  }

  if (style === 'jacket') {
    const span = (y: number) => b.span(y, BodyPart.TORSO);
    if (dir === 'down') {
      const mid = 32;
      for (let y = torso.top + 1; y < beltY - 1; y++) if (b.is(mid, y, BodyPart.TORSO)) mm.line(mid, y, 1);
      // Chest pockets with flaps.
      const py = torso.top + 6;
      for (const sx of [-1, 1]) {
        const x0 = sx < 0 ? mid - 5 : mid + 2;
        for (let x = x0; x < x0 + 3; x++) {
          if (!b.is(x, py, BodyPart.TORSO)) continue;
          mm.line(x, py, 4);
          mm.line(x, py + 1, 2);
          mm.line(x, py + 2, 2);
          mm.line(x, py + 3, 1);
        }
      }
    }
    if (dir === 'up') {
      // Backpack, only where the back is visible (a tail may hang in front).
      const top = torso.top + 3;
      for (let y = top; y < top + 11; y++) {
        const sp = span(y);
        if (!sp) continue;
        for (let x = 27; x <= 37; x++) if (b.is(x, y, BodyPart.TORSO)) mm.set(x, y, Mat.Leather);
      }
      for (let x = 27; x <= 37; x++) mm.line(x, top + 4, 1);
      for (const x of [26, 38]) for (let y = torso.top; y < top + 11; y++) if (b.is(x, y, BodyPart.TORSO)) mm.set(x, y, Mat.Strap);
    }
    if (dir === 'right') {
      // The pack sticks out behind the back.
      for (let y = torso.top + 3; y < torso.top + 13; y++) {
        const sp = span(y);
        if (!sp) continue;
        for (let x = sp.l - 3; x <= sp.l + 1; x++) if (!b.is(x, y, BodyPart.ARM, BodyPart.HAND, BodyPart.HEAD, BodyPart.HAIR)) mm.set(x, y, Mat.Leather);
      }
      for (let y = torso.top + 1; y < torso.top + 13; y++) {
        const sp = span(y);
        if (sp) mm.over(sp.l + 2, y, Mat.Strap);
      }
    }
    // Elbow patches.
    const arms = b.pixels(BodyPart.ARM);
    if (arms.length) {
      const ys = arms.map(([, y]) => y);
      const elbowY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2) + 1;
      for (const [x, y] of arms) if (y === elbowY || y === elbowY + 1) mm.line(x, y, Math.max(1, b.tone(x, y) - 1));
    }
    return;
  }

  // Plate vest: chest and back plates over the fabric, shoulder pads, bracers.
  for (let y = torso.top + 3; y <= Math.min(beltY - 3, torso.top + 13); y++) {
    const sp = b.span(y, BodyPart.TORSO);
    if (!sp) continue;
    for (let x = sp.l + 1; x <= sp.r - 1; x++) if (b.is(x, y, BodyPart.TORSO)) mm.set(x, y, Mat.Metal);
  }
  // Plate seams.
  if (dir !== 'right') {
    for (const yy of [torso.top + 8]) {
      const sp = b.span(yy, BodyPart.TORSO);
      if (sp) for (let x = sp.l + 1; x <= sp.r - 1; x++) if (mm.get(x, yy) === Mat.Metal) mm.line(x, yy, 1);
    }
  }
  const arms = b.pixels(BodyPart.ARM);
  if (!arms.length) return;
  const armTop = Math.min(...arms.map(([, y]) => y));
  const handTop = hands.length ? Math.min(...hands.map(([, y]) => y)) : 99;
  for (const [x, y] of arms) {
    if (y <= armTop + 4) {
      mm.set(x, y, Mat.Metal);
      if (!b.is(x - 1, y, BodyPart.TORSO, BodyPart.ARM)) mm.set(x - 1, y, Mat.Metal);
      if (!b.is(x + 1, y, BodyPart.TORSO, BodyPart.ARM)) mm.set(x + 1, y, Mat.Metal);
    }
    if (y === armTop + 4) mm.line(x, y, 1);
    if (y >= handTop - 5 && y < handTop - 1) mm.set(x, y, Mat.Metal);
  }
  for (let x = 0; x < S; x++) if (mm.get(x, armTop) === Mat.Metal) mm.set(x, armTop - 1, Mat.Metal);
}

/** Sleeves, gloves and shoulder pads / bracers on an arm piece. */
function paintArm(b: Body, mm: MatMap, style: ArmorStyle, lower: boolean): void {
  const arm = b.pixels(BodyPart.ARM);
  for (const [x, y] of arm) mm.set(x, y, Mat.Dye);
  const rows = b.rows(BodyPart.ARM);
  if (!rows) return;
  if (!lower) {
    if (style === 'plate_vest') {
      // Shoulder pad: the top of the arm, standing a pixel proud.
      for (const [x, y] of arm) {
        if (y > rows.top + 4) continue;
        mm.set(x, y, Mat.Metal);
        if (!b.is(x - 1, y, BodyPart.ARM)) mm.set(x - 1, y, Mat.Metal);
        if (!b.is(x + 1, y, BodyPart.ARM)) mm.set(x + 1, y, Mat.Metal);
        if (y === rows.top) mm.set(x, y - 1, Mat.Metal);
        if (y === rows.top + 4) mm.line(x, y, 1);
      }
    } else {
      // Elbow patch at the bottom of the sleeve.
      for (const [x, y] of arm) if (y >= rows.bottom - 2) mm.line(x, y, Math.max(1, b.tone(x, y) - 1));
    }
    return;
  }
  const hands = b.pixels(BodyPart.HAND);
  for (const [x, y] of hands) mm.set(x, y, Mat.Leather);
  const handTop = hands.length ? Math.min(...hands.map(([, y]) => y)) : rows.bottom;
  for (const [x, y] of arm) {
    if (style === 'plate_vest' && y >= handTop - 5 && y < handTop - 1) mm.set(x, y, Mat.Metal);
    if (y === handTop - 1) mm.set(x, y, Mat.Strap);
  }
}

/** Pants, knee patches / plates, and boots on a leg piece; the belt on the torso's hips. */
function paintLegPiece(b: Body, mm: MatMap, style: ArmorStyle, part: PartId): void {
  if (part === 'torso') {
    for (const [x, y] of b.pixels(BodyPart.HIP)) mm.set(x, y, Mat.Dye);
    const hip = b.rows(BodyPart.HIP);
    if (hip) {
      const sp = b.span(hip.top + 1, BodyPart.HIP);
      if (sp) for (let x = sp.l; x <= sp.r; x++) mm.over(x, hip.top + 1, Mat.Strap);
    }
    return;
  }
  const leg = b.pixels(BodyPart.LEG);
  for (const [x, y] of leg) mm.set(x, y, Mat.Dye);
  const rows = b.rows(BodyPart.LEG, BodyPart.FOOT);
  if (!rows) return;
  if (part.startsWith('upper')) {
    // The knee is at the bottom of the thigh piece.
    for (const [x, y] of leg) {
      if (y < rows.bottom - 4) continue;
      if (style === 'plate_legs') mm.set(x, y, Mat.Metal);
      else if (y >= rows.bottom - 3 && y <= rows.bottom - 2) mm.line(x, y, Math.max(1, b.tone(x, y) - 1));
    }
    return;
  }
  // Lower leg: boots (or wraps for digitigrade feet) over the bottom part.
  const len = rows.bottom - rows.top;
  const bootTop = rows.bottom - Math.round(len * (b.race === 'human' ? 0.45 : 0.55));
  for (const [x, y] of b.pixels(BodyPart.FOOT)) mm.set(x, y, style === 'plate_legs' ? Mat.Metal : Mat.Leather);
  for (const [x, y] of leg) if (y >= bootTop) mm.set(x, y, Mat.Leather);
  for (const [x, y] of leg) if (y === bootTop) mm.line(x, y, 4);
  // Toes of digitigrade feet stay free (claws poke out of the wraps).
  if (b.race !== 'human') {
    const footRows = b.rows(BodyPart.FOOT);
    if (footRows) for (const [x, y] of b.pixels(BodyPart.FOOT)) if (y >= footRows.bottom - 1) mm.set(x, y, Mat.None);
  }
  if (style === 'plate_legs') {
    // Shin guard.
    for (const [x, y] of leg) if (y > rows.top + 2 && y < bootTop - 1 && b.is(x - 1, y, BodyPart.LEG) && b.is(x + 1, y, BodyPart.LEG)) mm.set(x, y, Mat.Metal);
  }
}

/** Which body pieces each armor slot covers. */
const SLOT_PARTS: Record<ArmorSlot, PartId[]> = {
  head: ['head', 'headAlt'],
  torso: ['torso', 'upperArmA', 'lowerArmA', 'upperArmB', 'lowerArmB'],
  legs: ['torso', 'upperLegA', 'lowerLegA', 'upperLegB', 'lowerLegB'],
};

/** One armor piece for a race, facing down/up/right, in the 64px frame. Null if the slot doesn't cover the piece. Exposed for tests. */
export function drawArmorPiece(race: PlaceholderRace, slot: ArmorSlot, style: ArmorStyle, dir: Dir, part: PartId): PixelCanvas | null {
  if (!SLOT_PARTS[slot].includes(part)) return null;
  const body = bodyOf(race, dir, part);
  if (!body) return null;
  const mm = new MatMap();
  if (slot === 'head') paintHead(body, mm, style);
  else if (slot === 'torso') {
    if (part === 'torso') paintTorso(body, mm, style);
    else paintArm(body, mm, style, part.startsWith('lower'));
  } else paintLegPiece(body, mm, style, part);
  return mm.render(body);
}

/** A full armor atlas for one race, slot and style: same cells as the body atlas. */
export function generateArmorAtlas(race: PlaceholderRace, slot: ArmorSlot, style: ArmorStyle): PixelCanvas {
  const atlas = new PixelCanvas(ATLAS_WIDTH, ATLAS_HEIGHT);
  for (const dir of PUPPET_DIRS) {
    for (const part of PUPPET_PARTS) {
      const piece = drawArmorPiece(race, slot, style, dir, part);
      if (piece) blitPiece(atlas, piece, race, dir, part);
    }
  }
  return atlas;
}

export function isArmorStyleForSlot(slot: ArmorSlot, style: string): style is ArmorStyle {
  return (ARMOR_STYLES[slot] as readonly string[]).includes(style);
}
