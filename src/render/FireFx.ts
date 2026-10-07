import { Container, Graphics } from 'pixi.js';
import { hashInts } from '../core/rng';

const T = 32;
const MAX_PARTICLES = 500;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  smoke: boolean;
}

/** A burning tile to draw: tile coords, how far through its fuel (0 fresh .. 1 out) and its heat. */
export interface FireDraw {
  tx: number;
  ty: number;
  burnt: number;
  heat: number;
}

/**
 * Flames: per burning tile, a scorch under it and a few flickering tongues
 * (bigger mid-burn, guttering at the end), with embers and smoke drifting
 * off downwind. Redrawn every frame into one Graphics.
 */
export class FireFx {
  readonly layer = new Container({ label: 'fire' });
  private g = new Graphics();
  private particles: Particle[] = [];
  private time = 0;

  constructor() {
    this.layer.addChild(this.g);
  }

  render(dt: number, cells: FireDraw[], wind: { x: number; y: number }): void {
    this.time += dt;
    const g = this.g;
    g.clear();
    for (const c of cells) {
      const x = (c.tx + 0.5) * T;
      const y = (c.ty + 0.8) * T;
      const life = c.burnt < 0.15 ? c.burnt / 0.15 : c.burnt > 0.7 ? (1 - c.burnt) / 0.3 : 1;
      const size = Math.max(0.15, life) * (0.65 + 0.35 * c.heat);
      g.ellipse(x, y, 15, 7).fill({ color: 0x140c08, alpha: 0.35 });
      for (let k = 0; k < 3; k++) {
        const seed = hashInts(c.tx, c.ty, k);
        const ox = ((seed % 17) - 8) * 1.1;
        const flick = 0.75 + 0.25 * Math.sin(this.time * (9 + (seed % 7)) + seed);
        const h = (14 + (seed % 9)) * size * flick;
        const w = (6 + (seed % 4)) * size;
        const sway = wind.x * 4 + Math.sin(this.time * 5 + seed) * 2;
        const bx = x + ox;
        const by = y - 2 + (k - 1) * 3;
        // Outer red, then orange, then a pale core.
        for (const [scale, color, alpha] of [
          [1, 0xc8381a, 0.85],
          [0.7, 0xf08a28, 0.9],
          [0.4, 0xffe08a, 0.95],
        ] as const) {
          g.poly([bx - w * scale, by, bx + w * scale, by, bx + sway * scale, by - h * scale]).fill({ color, alpha });
        }
      }
      // Embers and smoke.
      if (this.particles.length < MAX_PARTICLES && Math.random() < dt * 6 * size) {
        this.particles.push({ x: x + (Math.random() - 0.5) * 20, y: y - 10, vx: wind.x * 20 + (Math.random() - 0.5) * 10, vy: -40 - Math.random() * 30, life: 0.8, max: 0.8, r: 1, smoke: false });
      }
      if (this.particles.length < MAX_PARTICLES && Math.random() < dt * 2.5 * size) {
        this.particles.push({ x: x + (Math.random() - 0.5) * 16, y: y - 18, vx: wind.x * 26, vy: -22 + wind.y * 10, life: 2.2, max: 2.2, r: 5 + Math.random() * 4, smoke: true });
      }
    }
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const f = p.life / p.max;
      if (p.smoke) {
        p.r += dt * 9;
        g.circle(p.x, p.y, p.r).fill({ color: 0x3a3632, alpha: 0.28 * f });
      } else g.rect(Math.round(p.x), Math.round(p.y), 1, 1).fill({ color: f > 0.5 ? 0xffd070 : 0xe05a20, alpha: f });
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
