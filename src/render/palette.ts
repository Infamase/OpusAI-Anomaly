/**
 * Palette swapping for hair / fur / scale colors.
 *
 * Artists paint recolorable regions using reserved "key" colors (4 shades per
 * channel, dark -> light). At load time each key shade is replaced with a shade
 * ramp generated from the chosen color. The result is cached per color combo, so
 * it costs nothing per frame and looks identical on WebGPU and WebGL.
 *
 * The same system colors NPC Stalkers: an NPC is just a race + random channel colors.
 */
export const PALETTE_CHANNELS = ['primary', 'secondary'] as const;
export type PaletteChannel = (typeof PALETTE_CHANNELS)[number];

/**
 * Reserved key colors, dark -> light: outline, shadow, mid, BASE, highlight.
 * The chosen color replaces shade 3. Never use these anywhere else in sprite art.
 */
export const KEY_COLORS: Record<PaletteChannel, readonly string[]> = {
  primary: ['#200020', '#400040', '#800080', '#c000c0', '#ff00ff'],
  secondary: ['#002020', '#004040', '#008080', '#00c0c0', '#00ffff'],
};
/** Index of the chosen ("base") color within a ramp. */
export const BASE_SHADE = 3;

export type RGB = [number, number, number];
export type ChannelColors = Partial<Record<PaletteChannel, string>>;

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  return rgb.map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255)) as RGB;
}

/** Moves hue `h` toward `target` by at most `amount` degrees along the short way. */
function shiftHue(h: number, target: number, amount: number): number {
  const diff = ((target - h + 540) % 360) - 180;
  return h + Math.sign(diff) * Math.min(Math.abs(diff), amount);
}

/**
 * Builds a 5-shade pixel-art ramp from one base color (base = shade 3):
 * outline, shadow, mid, base, highlight. Shadows drift toward blue/purple and
 * highlights toward yellow, a classic pixel-art technique that keeps recolors
 * from looking flat. The outline is a deep, saturated version of the color
 * (colored line art), not black.
 */
export function buildRamp(baseHex: string): RGB[] {
  const [h, s, l] = rgbToHsl(hexToRgb(baseHex));
  // Very light colors need bigger steps down to keep their outline readable.
  const k = l > 0.75 ? 1.25 : 1;
  const shades: [number, number, number, number][] = [
    // [lightness offset, hue target, hue shift, saturation scale]
    [-0.42 * k, 255, 22, 1.25],
    [-0.24 * k, 245, 14, 1.12],
    [-0.12 * k, 240, 7, 1.05],
    [0, h, 0, 1],
    [0.11, 55, 8, 0.95],
  ];
  return shades.map(([dl, target, amount, ss]) => {
    // Greys have no meaningful hue; don't tint them.
    const hue = s < 0.08 ? h : shiftHue(h, target, amount);
    const sat = Math.min(1, s * ss);
    return hslToRgb([hue, sat, Math.min(0.97, Math.max(0.03, l + dl))]);
  });
}

const rgbKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Builds the key-color -> replacement lookup for a set of channel colors. */
export function buildSwapMap(colors: ChannelColors): Map<number, RGB> {
  const map = new Map<number, RGB>();
  for (const channel of PALETTE_CHANNELS) {
    const hex = colors[channel];
    if (!hex) continue;
    const ramp = buildRamp(hex);
    KEY_COLORS[channel].forEach((key, i) => {
      const [r, g, b] = hexToRgb(key);
      map.set(rgbKey(r, g, b), ramp[i]!);
    });
  }
  return map;
}

/** Recolors RGBA pixel data in place. Returns how many pixels changed. */
export function recolorPixels(pixels: Uint8ClampedArray, swap: Map<number, RGB>): number {
  let changed = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const to = swap.get(rgbKey(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!));
    if (!to) continue;
    pixels[i] = to[0];
    pixels[i + 1] = to[1];
    pixels[i + 2] = to[2];
    changed++;
  }
  return changed;
}

/** Stable cache key for a sheet + color combination. */
export function swapCacheKey(sheetId: string, colors: ChannelColors): string {
  return sheetId + '|' + PALETTE_CHANNELS.map((c) => colors[c] ?? '-').join(',');
}
