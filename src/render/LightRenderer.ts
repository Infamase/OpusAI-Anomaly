import { Container, Graphics, Matrix, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import { falloff, type RGB01 } from '../game/lighting';

/** The lightmap is drawn at this fraction of the screen's resolution (soft edges for free). */
const RES = 0.25;
const GRADIENT = 128;

/** One light to draw: the area it reaches (polygon, world px) and how it shines. */
export interface LightDraw {
  poly: number[];
  x: number;
  y: number;
  radius: number;
  color: RGB01;
  intensity: number;
}

const toHex = (c: RGB01) => (Math.round(Math.min(1, c[0]) * 255) << 16) | (Math.round(Math.min(1, c[1]) * 255) << 8) | Math.round(Math.min(1, c[2]) * 255);

/**
 * Darkness. Each frame the ambient light fills a small render texture and
 * every light adds its glow on top (clipped to what it can reach); the result
 * is laid over the world with a multiply, so unlit places sink toward the
 * ambient color and lit ones keep their colors. Skipped entirely in daylight.
 */
export class LightRenderer {
  /** Screen-space sprite showing the lightmap; add it above the world. */
  readonly sprite: Sprite;
  private root = new Container();
  private ambient = new Graphics();
  private lights = new Graphics();
  private rt: RenderTexture;
  private gradient: Texture;
  private m = new Matrix();

  constructor(private pixi: Renderer) {
    this.rt = RenderTexture.create({ width: 8, height: 8, scaleMode: 'linear' });
    this.sprite = new Sprite(this.rt);
    this.sprite.blendMode = 'multiply';
    this.sprite.visible = false;
    this.lights.blendMode = 'add';
    this.root.addChild(this.ambient, this.lights);
    this.gradient = radialTexture();
  }

  /**
   * Draws this frame's lightmap. `world` is the camera-transformed world
   * container (its position / scale map world px to screen px).
   */
  render(world: Container, viewW: number, viewH: number, ambient: RGB01, lights: LightDraw[]): void {
    const day = ambient[0] > 0.985 && ambient[1] > 0.985 && ambient[2] > 0.985;
    this.sprite.visible = !day;
    if (day) return;
    const w = Math.max(8, Math.ceil(viewW * RES));
    const h = Math.max(8, Math.ceil(viewH * RES));
    if (this.rt.width !== w || this.rt.height !== h) this.rt.resize(w, h);
    this.sprite.scale.set(1 / RES);

    this.root.scale.set(world.scale.x * RES);
    this.root.position.set(world.position.x * RES, world.position.y * RES);
    const s = world.scale.x;
    const left = -world.position.x / s;
    const top = -world.position.y / s;
    this.ambient.clear().rect(left - 64, top - 64, viewW / s + 128, viewH / s + 128).fill(toHex(ambient));

    const g = this.lights;
    g.clear();
    for (const l of lights) {
      if (l.intensity <= 0.01 || l.poly.length < 6) continue;
      // The gradient texture (GRADIENT px wide) stretched over the light's circle.
      const k = (l.radius * 2) / GRADIENT;
      this.m.set(k, 0, 0, k, l.x - l.radius, l.y - l.radius);
      g.poly(l.poly).fill({ texture: this.gradient, textureSpace: 'global', matrix: this.m.clone(), color: toHex(l.color), alpha: Math.min(1, l.intensity) });
      // Very strong lights (explosions) blow out a second layer.
      if (l.intensity > 1) g.poly(l.poly).fill({ texture: this.gradient, textureSpace: 'global', matrix: this.m.clone(), color: toHex(l.color), alpha: Math.min(1, l.intensity - 1) });
    }
    this.pixi.render({ container: this.root, target: this.rt, clear: true });
  }

  destroy(): void {
    this.sprite.destroy();
    this.rt.destroy(true);
    this.root.destroy({ children: true });
    this.gradient.destroy(true);
  }
}

/** White in the middle fading out along `falloff`, for every light. */
function radialTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = GRADIENT;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(GRADIENT, GRADIENT);
  const mid = GRADIENT / 2;
  for (let y = 0; y < GRADIENT; y++) {
    for (let x = 0; x < GRADIENT; x++) {
      const t = Math.hypot(x + 0.5 - mid, y + 0.5 - mid) / mid;
      const i = (y * GRADIENT + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(falloff(t) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(c, true);
  tex.source.scaleMode = 'linear';
  return tex;
}
