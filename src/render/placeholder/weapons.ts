import { hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';

/**
 * Stand-in weapon art: side views pointing right, sized for 64px characters.
 * The character holds the gun at `grip`, the gun turns freely toward the aim,
 * and bullets leave from `muzzle`. Real PNG weapon art uses the same three
 * values (see the weapon content type).
 *
 * Drawn as shaded blocks (highlight on top, shadow underneath) in a few
 * materials, then outlined in each material's darkest tone, matching the
 * character art.
 */
export const WEAPON_STYLES = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper'] as const;
export type WeaponStyle = (typeof WEAPON_STYLES)[number];

export interface WeaponArt {
  pixels: PixelCanvas;
  grip: [number, number];
  muzzle: [number, number];
}

type Ramp4 = [RGB, RGB, RGB, RGB]; // outline, shadow, base, highlight
const ramp = (...hex: string[]) => hex.map(hexToRgb) as Ramp4;
const STEEL = ramp('#121418', '#2c3036', '#424850', '#6a727c');
const BLUED = ramp('#0e1014', '#202429', '#30353c', '#4e565f');
const WOOD = ramp('#2a140a', '#5a321a', '#7a4a26', '#a26c3c');
const POLY = ramp('#141512', '#2a2c26', '#3a3d34', '#56594c');
const GLASS = ramp('#0c2a30', '#2e7e8c', '#5ab4c2', '#c6f2f8');

interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  m: Ramp4;
}

function render(w: number, h: number, blocks: Block[], details: [number, number, RGB][] = []): PixelCanvas {
  // Draw with a 1px margin for the outline.
  const pc = new PixelCanvas(w + 2, h + 2);
  const mat: (Ramp4 | null)[] = new Array((w + 2) * (h + 2)).fill(null);
  for (const b of blocks) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const tone = b.h === 1 ? 2 : y === b.y ? 3 : y === b.y + b.h - 1 ? 1 : 2;
        pc.set(x + 1, y + 1, b.m[tone]!);
        mat[(y + 1) * (w + 2) + x + 1] = b.m;
      }
    }
  }
  for (const [x, y, c] of details) pc.set(x + 1, y + 1, c);
  const marks: [number, number, RGB][] = [];
  for (let y = 0; y < h + 2; y++) {
    for (let x = 0; x < w + 2; x++) {
      if (mat[y * (w + 2) + x]) continue;
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [-1, 0],
        [1, 0],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w + 2 || ny >= h + 2) continue;
        const m = mat[ny * (w + 2) + nx];
        if (m) {
          marks.push([x, y, m[0]]);
          break;
        }
      }
    }
  }
  for (const [x, y, c] of marks) pc.set(x, y, c);
  return pc;
}

const b = (x: number, y: number, w: number, h: number, m: Ramp4): Block => ({ x, y, w, h, m });

export function generateWeaponArt(style: WeaponStyle): WeaponArt {
  // Coordinates are inside the 1px outline margin; grip/muzzle are returned in canvas pixels (+1).
  let w: number;
  let h: number;
  let blocks: Block[];
  let details: [number, number, RGB][] = [];
  let grip: [number, number];
  let muzzle: [number, number];
  switch (style) {
    case 'pistol':
      w = 15;
      h = 9;
      blocks = [b(0, 0, 13, 3, STEEL), b(13, 1, 2, 1, BLUED), b(1, 3, 10, 1, BLUED), b(1, 4, 4, 5, POLY), b(5, 4, 3, 1, BLUED), b(7, 4, 1, 2, BLUED)];
      details = [
        [1, 0, STEEL[3]],
        [11, 0, STEEL[0]],
        [3, 6, POLY[1]],
        [3, 7, POLY[1]],
      ];
      grip = [3, 6];
      muzzle = [15, 2];
      break;
    case 'smg':
      w = 24;
      h = 11;
      blocks = [
        b(0, 2, 4, 3, POLY),
        b(4, 1, 13, 4, STEEL),
        b(17, 2, 6, 2, BLUED),
        b(23, 2, 1, 1, BLUED),
        b(11, 5, 3, 6, BLUED),
        b(6, 5, 3, 4, POLY),
        b(8, 0, 4, 1, BLUED),
      ];
      details = [
        [5, 2, STEEL[1]],
        [14, 2, STEEL[1]],
        [12, 7, BLUED[1]],
        [12, 9, BLUED[1]],
      ];
      grip = [8, 6];
      muzzle = [24, 3];
      break;
    case 'rifle':
      w = 32;
      h = 11;
      blocks = [
        b(0, 2, 7, 4, WOOD),
        b(7, 1, 12, 3, BLUED),
        b(19, 2, 7, 2, WOOD),
        b(26, 2, 5, 1, BLUED),
        b(31, 1, 1, 3, BLUED),
        b(24, 0, 1, 2, BLUED),
        b(12, 4, 3, 3, BLUED),
        b(13, 7, 3, 3, BLUED),
        b(9, 4, 2, 4, WOOD),
        b(9, 0, 3, 1, BLUED),
      ];
      details = [
        [0, 3, WOOD[1]],
        [1, 4, WOOD[1]],
        [20, 3, WOOD[1]],
        [22, 3, WOOD[1]],
        [14, 8, BLUED[1]],
      ];
      grip = [10, 5];
      muzzle = [32, 3];
      break;
    case 'shotgun':
      w = 33;
      h = 9;
      blocks = [
        b(0, 2, 8, 4, WOOD),
        b(8, 1, 9, 3, STEEL),
        b(17, 1, 15, 1, BLUED),
        b(17, 2, 12, 2, BLUED),
        b(18, 3, 7, 2, WOOD),
        b(10, 4, 2, 3, WOOD),
        b(31, 0, 1, 1, STEEL),
      ];
      details = [
        [1, 3, WOOD[1]],
        [19, 4, WOOD[1]],
        [21, 4, WOOD[1]],
        [23, 4, WOOD[1]],
      ];
      grip = [11, 5];
      muzzle = [33, 2];
      break;
    case 'sniper':
      w = 40;
      h = 12;
      blocks = [
        b(0, 3, 8, 4, WOOD),
        b(8, 3, 13, 3, BLUED),
        b(21, 3, 18, 1, BLUED),
        b(21, 4, 6, 2, WOOD),
        b(10, 0, 10, 3, STEEL),
        b(9, 1, 1, 1, STEEL),
        b(20, 1, 1, 1, STEEL),
        b(14, 6, 3, 3, BLUED),
        b(11, 6, 2, 4, WOOD),
        b(3, 7, 4, 1, WOOD),
      ];
      details = [
        [20, 1, GLASS[3]],
        [9, 1, GLASS[1]],
        [1, 4, WOOD[1]],
        [2, 5, WOOD[1]],
        [12, 1, STEEL[3]],
      ];
      grip = [12, 7];
      muzzle = [40, 4];
      break;
  }
  return { pixels: render(w, h, blocks, details), grip: [grip[0] + 1, grip[1] + 1], muzzle: [muzzle[0] + 1, muzzle[1] + 1] };
}
