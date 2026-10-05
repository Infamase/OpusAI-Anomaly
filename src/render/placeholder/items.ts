import { hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { PLACEHOLDER_OUTLINE } from './characters';

/** Stand-in art for item icons and world props. All sprites are outlined like the characters. */

const shade = ([r, g, b]: RGB, f: number): RGB => [Math.min(255, Math.round(r * f)), Math.min(255, Math.round(g * f)), Math.min(255, Math.round(b * f))];

function finish(pc: PixelCanvas): PixelCanvas {
  pc.outline(PLACEHOLDER_OUTLINE);
  return pc;
}

/** Cardboard/metal ammo box with a colored caliber band. 14x10. */
export function drawAmmoBox(colorHex: string): PixelCanvas {
  const pc = new PixelCanvas(14, 10);
  const c = hexToRgb(colorHex);
  pc.rect(1, 2, 12, 7, [104, 92, 64]);
  pc.hline(1, 2, 12, [140, 126, 90]);
  pc.rect(1, 4, 12, 2, c);
  pc.hline(1, 4, 12, shade(c, 1.25));
  pc.vline(12, 2, 7, [74, 64, 44]);
  pc.hline(1, 8, 12, [74, 64, 44]);
  for (let x = 3; x < 11; x += 2) pc.set(x, 1, [190, 160, 90]);
  return finish(pc);
}

export function drawConsumable(icon: string, colorHex: string): PixelCanvas {
  const c = hexToRgb(colorHex);
  switch (icon) {
    case 'bandage': {
      const pc = new PixelCanvas(12, 10);
      pc.rect(1, 2, 10, 6, c);
      pc.hline(1, 2, 10, shade(c, 1.1));
      pc.hline(1, 7, 10, shade(c, 0.8));
      for (let x = 2; x < 11; x += 3) pc.vline(x, 3, 4, shade(c, 0.85));
      pc.rect(4, 3, 3, 3, [200, 60, 50]);
      return finish(pc);
    }
    case 'medkit': {
      const pc = new PixelCanvas(14, 12);
      pc.rect(1, 3, 12, 8, c);
      pc.hline(1, 3, 12, shade(c, 1.25));
      pc.vline(12, 3, 8, shade(c, 0.7));
      pc.hline(1, 10, 12, shade(c, 0.7));
      pc.rect(5, 1, 4, 2, [60, 60, 60]);
      pc.rect(6, 4, 2, 6, [240, 240, 230]);
      pc.rect(4, 6, 6, 2, [240, 240, 230]);
      return finish(pc);
    }
    case 'injector': {
      const pc = new PixelCanvas(14, 8);
      pc.rect(1, 3, 8, 3, [210, 214, 220]);
      pc.rect(2, 3, 5, 2, c);
      pc.rect(9, 3, 2, 3, [90, 94, 100]);
      pc.hline(11, 4, 2, [180, 184, 190]);
      pc.rect(0, 2, 1, 5, [90, 94, 100]);
      return finish(pc);
    }
    case 'food': {
      const pc = new PixelCanvas(12, 12);
      pc.rect(2, 2, 8, 9, [150, 156, 164]);
      pc.rect(2, 4, 8, 5, c);
      pc.hline(2, 4, 8, shade(c, 1.2));
      pc.hline(2, 2, 8, [190, 196, 204]);
      pc.vline(9, 2, 9, [110, 114, 120]);
      return finish(pc);
    }
    default: {
      const pc = new PixelCanvas(10, 14);
      pc.rect(2, 2, 6, 11, c);
      pc.vline(2, 2, 11, shade(c, 1.25));
      pc.vline(7, 2, 11, shade(c, 0.75));
      pc.rect(3, 5, 4, 4, [230, 230, 220]);
      pc.hline(3, 1, 4, [160, 164, 170]);
      return finish(pc);
    }
  }
}

/** World crates: wooden supply crate or green military case. */
export function drawCrate(kind: 'supply' | 'military'): PixelCanvas {
  const pc = new PixelCanvas(22, 18);
  const base: RGB = kind === 'supply' ? [124, 88, 52] : [70, 84, 56];
  const dark = shade(base, 0.7);
  const light = shade(base, 1.25);
  pc.rect(1, 4, 20, 13, base);
  pc.rect(1, 1, 20, 4, light);
  pc.hline(1, 4, 20, dark);
  pc.vline(20, 1, 16, dark);
  pc.hline(1, 16, 20, dark);
  if (kind === 'supply') {
    for (let y = 7; y < 16; y += 3) pc.hline(2, y, 18, dark);
    pc.vline(4, 5, 11, dark);
    pc.vline(17, 5, 11, dark);
  } else {
    pc.rect(9, 7, 4, 3, [190, 170, 80]);
    pc.rect(3, 6, 2, 9, dark);
    pc.rect(17, 6, 2, 9, dark);
    pc.hline(2, 2, 18, shade(light, 1.1));
  }
  return finish(pc);
}

/** Generic fallback icon (unknown items). */
export function drawUnknown(): PixelCanvas {
  const pc = new PixelCanvas(10, 10);
  pc.rect(1, 1, 8, 8, [90, 90, 100]);
  pc.rect(4, 2, 2, 4, [220, 220, 220]);
  pc.rect(4, 7, 2, 1, [220, 220, 220]);
  return finish(pc);
}

/** Crops a canvas to its non-transparent pixels (plus a 1px margin). */
export function cropToContent(src: PixelCanvas, x0: number, y0: number, w: number, h: number): PixelCanvas {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!src.alpha(x0 + x, y0 + y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return drawUnknown();
  const out = new PixelCanvas(maxX - minX + 1, maxY - minY + 1);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const a = src.alpha(x0 + x, y0 + y);
      if (a) out.set(x - minX, y - minY, src.get(x0 + x, y0 + y), a);
    }
  }
  return out;
}
