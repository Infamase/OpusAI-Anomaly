import type { RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { PLACEHOLDER_OUTLINE } from './characters';

/**
 * Stand-in weapon art: side views pointing right. The character holds the gun
 * at `grip`, the gun turns freely toward the aim, and bullets leave from `muzzle`.
 * Real PNG weapon art uses the same three values (see the weapon content type).
 */
export const WEAPON_STYLES = ['pistol', 'smg', 'rifle', 'shotgun', 'sniper'] as const;
export type WeaponStyle = (typeof WEAPON_STYLES)[number];

export interface WeaponArt {
  pixels: PixelCanvas;
  grip: [number, number];
  muzzle: [number, number];
}

const M0: RGB = [40, 42, 48];
const M1: RGB = [66, 70, 78];
const M2: RGB = [112, 118, 128];
const W0: RGB = [86, 56, 34];
const W1: RGB = [124, 82, 48];
const GLASS: RGB = [120, 200, 220];

export function generateWeaponArt(style: WeaponStyle): WeaponArt {
  const size: Record<WeaponStyle, [number, number]> = { pistol: [13, 8], smg: [19, 9], rifle: [25, 9], shotgun: [25, 8], sniper: [31, 9] };
  const [w, h] = size[style];
  const pc = new PixelCanvas(w, h);
  // Draw at (1,1) so the outline fits inside the canvas.
  const r = (x: number, y: number, rw: number, rh: number, c: RGB) => pc.rect(x + 1, y + 1, rw, rh, c);
  let grip: [number, number];
  let muzzle: [number, number];
  switch (style) {
    case 'pistol':
      r(0, 0, 10, 2, M1);
      r(0, 0, 10, 1, M2);
      r(0, 2, 9, 1, M0);
      r(1, 3, 3, 3, M0);
      r(5, 3, 1, 1, M0);
      grip = [3, 5];
      muzzle = [11, 2];
      break;
    case 'smg':
      r(0, 1, 3, 2, M0);
      r(3, 1, 11, 3, M1);
      r(3, 1, 11, 1, M2);
      r(14, 2, 4, 1, M0);
      r(8, 4, 2, 3, M0);
      r(5, 4, 2, 2, M0);
      grip = [6, 5];
      muzzle = [18, 3];
      break;
    case 'rifle':
      r(0, 1, 5, 3, W0);
      r(0, 1, 5, 1, W1);
      r(5, 1, 9, 2, M0);
      r(5, 1, 9, 1, M1);
      r(14, 1, 6, 2, W0);
      r(14, 1, 6, 1, W1);
      r(20, 1, 4, 1, M0);
      r(19, 0, 1, 1, M0);
      r(10, 3, 2, 2, M0);
      r(11, 5, 2, 2, M0);
      r(7, 3, 2, 2, M0);
      grip = [8, 4];
      muzzle = [24, 2];
      break;
    case 'shotgun':
      r(0, 1, 6, 3, W0);
      r(0, 1, 6, 1, W1);
      r(6, 1, 6, 2, M1);
      r(6, 1, 6, 1, M2);
      r(12, 1, 12, 1, M0);
      r(12, 2, 9, 1, M1);
      r(13, 2, 5, 2, W0);
      r(7, 3, 2, 2, M0);
      grip = [8, 4];
      muzzle = [24, 2];
      break;
    case 'sniper':
      r(0, 1, 6, 3, W0);
      r(0, 1, 6, 1, W1);
      r(6, 1, 10, 2, M0);
      r(8, -1, 7, 2, M0);
      r(14, -1, 1, 1, GLASS);
      r(16, 1, 14, 1, M0);
      r(11, 3, 3, 2, M0);
      r(8, 3, 2, 2, M0);
      grip = [9, 4];
      muzzle = [30, 2];
      break;
  }
  pc.outline(PLACEHOLDER_OUTLINE);
  return { pixels: pc, grip, muzzle };
}
