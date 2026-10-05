import type { RGB } from './palette';

/**
 * A plain RGBA pixel buffer for generating and editing sprite art in code.
 * Works without a DOM (unit-testable); convert with toCanvas() when needed.
 */
export class PixelCanvas {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  /**
   * Optional per-pixel tag recording which body part last painted each pixel
   * (see BodyPart in placeholder/characters.ts). Armor generation uses it to fit
   * gear to any body shape.
   */
  regions: Uint8Array | null = null;
  /** Tag written by set() while regions are enabled. */
  region = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, c: RGB, a = 255): void {
    x = Math.round(x);
    y = Math.round(y);
    if (!this.inBounds(x, y)) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
    if (this.regions) this.regions[i >> 2] = this.region;
  }

  enableRegions(): this {
    this.regions = new Uint8Array(this.width * this.height);
    return this;
  }

  regionAt(x: number, y: number): number {
    if (!this.regions || !this.inBounds(x, y)) return 0;
    return this.regions[y * this.width + x]!;
  }

  /** Re-tags already painted pixels in a rectangle without changing their color. */
  tag(x: number, y: number, w: number, h: number, region: number): void {
    if (!this.regions) return;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) if (this.alpha(xx, yy) > 0) this.regions[yy * this.width + xx] = region;
    }
  }

  alpha(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 0;
    return this.data[(y * this.width + x) * 4 + 3]!;
  }

  get(x: number, y: number): RGB {
    const i = (y * this.width + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
  }

  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.set(x + xx, y + yy, c);
  }

  hline(x: number, y: number, w: number, c: RGB): void {
    this.rect(x, y, w, 1, c);
  }

  vline(x: number, y: number, h: number, c: RGB): void {
    this.rect(x, y, 1, h, c);
  }

  /** Copies another canvas onto this one (alpha > 0 pixels only). */
  blit(src: PixelCanvas, dx: number, dy: number, flipX = false): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const sx = flipX ? src.width - 1 - x : x;
        const a = src.alpha(sx, y);
        if (a > 0) this.set(dx + x, dy + y, src.get(sx, y), a);
      }
    }
  }

  /** Adds a 1px outline around every opaque shape within a region. */
  outline(c: RGB, x0 = 0, y0 = 0, w = this.width, h = this.height): void {
    const marks: [number, number][] = [];
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (this.alpha(x, y) > 0) continue;
        const near = (dx: number, dy: number) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx >= x0 && ny >= y0 && nx < x0 + w && ny < y0 + h && this.alpha(nx, ny) > 0;
        };
        if (near(1, 0) || near(-1, 0) || near(0, 1) || near(0, -1)) marks.push([x, y]);
      }
    }
    for (const [x, y] of marks) this.set(x, y, c);
  }

  toCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(this.data), this.width, this.height), 0, 0);
    return canvas;
  }
}
