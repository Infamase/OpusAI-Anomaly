import { Container, Graphics, Texture, TilingSprite } from 'pixi.js';

interface Drop {
  x: number;
  y: number;
  speed: number;
  len: number;
}

interface Splash {
  x: number;
  y: number;
  life: number;
}

/** What the weather draws this frame. Screen-space, CSS-independent device pixels. */
export interface WeatherDraw {
  rain: number;
  fog: number;
  /** Wind blowing toward this angle, 0..1 strong. */
  wind: number;
  windAngle: number;
  /** How lit the world is (0 night .. 1 day): rain and fog darken with it. */
  light: number;
  /** Ambient color (fog takes its tint), 0..1. */
  tint: [number, number, number];
  /** World offset of the view in device px (fog drifts with the world, not the screen). */
  camX: number;
  camY: number;
}

const FOG_SIZE = 256;

/**
 * Rain, fog and lightning, drawn over the view: slanted streaks and little
 * splashes, two layers of drifting fog banks anchored to the world, and a
 * lightning flash with a forked bolt.
 */
export class WeatherFx {
  readonly layer = new Container({ label: 'weather' });
  private rainG = new Graphics();
  private fogA: TilingSprite;
  private fogB: TilingSprite;
  private bolt = new Graphics();
  private drops: Drop[] = [];
  private splashes: Splash[] = [];
  private time = 0;
  private boltLeft = 0;

  constructor() {
    const tex = fogTexture();
    this.fogA = new TilingSprite({ texture: tex, width: 8, height: 8 });
    this.fogB = new TilingSprite({ texture: tex, width: 8, height: 8 });
    this.fogA.tileScale.set(2.5);
    this.fogB.tileScale.set(4.2);
    this.layer.addChild(this.fogA, this.fogB, this.rainG, this.bolt);
  }

  render(dt: number, w: number, h: number, d: WeatherDraw): void {
    this.time += dt;
    // ---- fog ----
    const tint = (Math.round(d.tint[0] * 210) << 16) | (Math.round(d.tint[1] * 214) << 8) | Math.round(d.tint[2] * 220);
    for (const [s, k, a] of [
      [this.fogA, 0.9, 0.55],
      [this.fogB, 0.6, 0.4],
    ] as const) {
      s.visible = d.fog > 0.02;
      if (!s.visible) continue;
      s.width = w;
      s.height = h;
      s.tint = tint;
      s.alpha = Math.min(1, d.fog * a);
      const drift = this.time * (8 + d.wind * 30) * k;
      s.tilePosition.set(-d.camX * k + Math.cos(d.windAngle) * drift, -d.camY * k + Math.sin(d.windAngle) * drift);
    }

    // ---- rain ----
    const g = this.rainG;
    g.clear();
    const want = Math.round(d.rain * (w * h) / 1700);
    while (this.drops.length < want) this.drops.push(this.newDrop(w, h, true));
    if (this.drops.length > want) this.drops.length = want;
    const slant = Math.cos(d.windAngle) * d.wind * 0.45;
    const alpha = 0.28 + 0.35 * d.light;
    const color = d.light > 0.5 ? 0xc8d4e0 : 0x8a9ab0;
    for (let i = 0; i < this.drops.length; i++) {
      const p = this.drops[i]!;
      p.y += p.speed * dt;
      p.x += p.speed * slant * dt;
      if (p.y > h + 20 || p.x < -40 || p.x > w + 40) {
        // Where it hit the ground: now and then a splash.
        if (Math.random() < 0.25) this.splashes.push({ x: p.x, y: Math.min(h, p.y), life: 0.18 });
        this.drops[i] = this.newDrop(w, h, false);
        continue;
      }
      g.moveTo(p.x, p.y).lineTo(p.x - p.len * slant, p.y - p.len);
    }
    if (this.drops.length) g.stroke({ width: 2, color, alpha });
    this.splashes = this.splashes.filter((s) => (s.life -= dt) > 0);
    for (const s of this.splashes) {
      const r = 2 + (1 - s.life / 0.18) * 5;
      g.ellipse(s.x, s.y, r, r * 0.4).stroke({ width: 1, color, alpha: alpha * (s.life / 0.18) * 1.5 });
    }

    // ---- lightning bolt ----
    this.boltLeft = Math.max(0, this.boltLeft - dt);
    this.bolt.alpha = Math.min(1, this.boltLeft / 0.1);
  }

  /** Draws a forked bolt from the top of the screen down to (x, y) (screen px). */
  lightning(x: number, y: number): void {
    const b = this.bolt;
    b.clear();
    let px = x + (Math.random() - 0.5) * 200;
    let py = -10;
    const pts: [number, number][] = [[px, py]];
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      px = px + (x - px) / (steps - i + 1) + (Math.random() - 0.5) * 40 * (1 - t);
      py = -10 + (y + 10) * t;
      pts.push([px, py]);
      if (Math.random() < 0.25) {
        const fx = px + (Math.random() - 0.5) * 80;
        b.moveTo(px, py).lineTo(fx, py + 30 + Math.random() * 40).stroke({ width: 1.5, color: 0xd8e4ff, alpha: 0.8 });
      }
    }
    for (const w of [6, 2.5]) {
      b.moveTo(pts[0]![0], pts[0]![1]);
      for (const [qx, qy] of pts.slice(1)) b.lineTo(qx, qy);
      b.stroke({ width: w, color: w > 3 ? 0x8aa8ff : 0xffffff, alpha: w > 3 ? 0.35 : 1 });
    }
    this.boltLeft = 0.25;
  }

  private newDrop(w: number, h: number, anywhere: boolean): Drop {
    return { x: Math.random() * (w + 80) - 40, y: anywhere ? Math.random() * h : -Math.random() * 60, speed: 900 + Math.random() * 500, len: 10 + Math.random() * 10 };
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}

/** Value noise on a lattice that wraps every `period` cells: tiles seamlessly. */
function periodicNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const v = (i: number, j: number) => {
    const a = ((i % period) + period) % period;
    const b = ((j % period) + period) % period;
    let h = (a * 374761393 + b * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * sx;
  const bot = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * sx;
  return top + (bot - top) * sy;
}

/** Soft, seamless fog banks: white with patchy transparency. */
function fogTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = FOG_SIZE;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(FOG_SIZE, FOG_SIZE);
  for (let y = 0; y < FOG_SIZE; y++) {
    for (let x = 0; x < FOG_SIZE; x++) {
      let v = 0;
      let amp = 0.55;
      let cells = 4;
      for (let o = 0; o < 4; o++) {
        v += amp * periodicNoise((x / FOG_SIZE) * cells, (y / FOG_SIZE) * cells, cells, o + 7);
        amp *= 0.5;
        cells *= 2;
      }
      const i = (y * FOG_SIZE + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.max(0, Math.min(1, (v - 0.3) * 1.8)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(c, true);
  tex.source.scaleMode = 'linear';
  return tex;
}
