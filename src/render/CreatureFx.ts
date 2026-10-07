import { Container, Graphics } from 'pixi.js';

interface Splash {
  x: number;
  y: number;
  r: number;
  color: number;
  age: number;
  drops: { dx: number; dy: number; vx: number; vy: number; z: number; vz: number }[];
}

interface Dust {
  x: number;
  y: number;
  age: number;
  life: number;
  puffs: { dx: number; dy: number; r: number; vx: number; vy: number }[];
  color: number;
}

const hex = (c: string) => parseInt(c.slice(1), 16);

/**
 * Creature effects: acid globs in flight and the puddles they leave, dust
 * kicked up by a pounce or a burrower breaking the surface, and eyes that
 * shine in the dark (drawn above the lightmap, in screen space).
 */
export class CreatureFx {
  /** World layer (above entities). */
  readonly layer = new Container({ label: 'creatureFx' });
  /** Screen layer, above the darkness. */
  readonly eyesLayer = new Graphics();
  private under = new Graphics();
  private over = new Graphics();
  private splashes: Splash[] = [];
  private dusts: Dust[] = [];

  constructor() {
    this.layer.addChild(this.under, this.over);
  }

  splash(x: number, y: number, radius: number, color: string): void {
    const drops = Array.from({ length: 10 }, () => {
      const a = Math.random() * Math.PI * 2;
      const s = 30 + Math.random() * 70;
      return { dx: 0, dy: 0, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6, z: 2, vz: 60 + Math.random() * 80 };
    });
    this.splashes.push({ x, y, r: radius, color: hex(color), age: 0, drops });
  }

  dust(x: number, y: number, size: number, color = '#8a7656'): void {
    const puffs = Array.from({ length: 9 }, () => {
      const a = Math.random() * Math.PI * 2;
      const s = 10 + Math.random() * 30;
      return { dx: Math.cos(a) * size * 0.3, dy: Math.sin(a) * size * 0.15, r: size * (0.25 + Math.random() * 0.25), vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.4 - 6 };
    });
    this.dusts.push({ x, y, age: 0, life: 0.9, puffs, color: hex(color) });
  }

  /** Draws globs (world px, with height) and the effects; ages everything. */
  render(dt: number, globs: { x: number; y: number; z: number; color: string }[]): void {
    const u = this.under.clear();
    const o = this.over.clear();
    for (const g of globs) {
      u.ellipse(g.x, g.y, 3, 1.4).fill({ color: 0x000000, alpha: 0.25 });
      const c = hex(g.color);
      o.circle(g.x, g.y - g.z, 2.6).fill({ color: c, alpha: 0.95 });
      o.circle(g.x - 0.8, g.y - g.z - 0.8, 1).fill({ color: 0xffffff, alpha: 0.6 });
      o.circle(g.x - g.z * 0.05, g.y - g.z + 3, 1.2).fill({ color: c, alpha: 0.5 });
    }
    this.splashes = this.splashes.filter((s) => (s.age += dt) < 4);
    for (const s of this.splashes) {
      // A fizzing puddle that soaks away.
      const fade = Math.max(0, 1 - s.age / 4);
      const grow = Math.min(1, s.age * 6);
      u.ellipse(s.x, s.y, s.r * 0.8 * grow, s.r * 0.36 * grow).fill({ color: s.color, alpha: 0.35 * fade });
      u.ellipse(s.x + 2, s.y - 1, s.r * 0.45 * grow, s.r * 0.2 * grow).fill({ color: s.color, alpha: 0.4 * fade });
      for (let i = 0; i < 3; i++) {
        const k = (s.age * 2 + i * 0.33) % 1;
        const bx = s.x + Math.sin(i * 2.4 + s.x) * s.r * 0.5;
        const by = s.y + Math.cos(i * 1.7) * s.r * 0.15;
        o.circle(bx, by - k * 6, 1 + k).stroke({ color: s.color, alpha: (1 - k) * fade * 0.8, width: 0.8 });
      }
      for (const d of s.drops) {
        if (d.z <= 0) continue;
        d.dx += d.vx * dt;
        d.dy += d.vy * dt;
        d.z += d.vz * dt;
        d.vz -= 400 * dt;
        o.rect(s.x + d.dx - 1, s.y + d.dy - d.z - 1, 2, 2).fill({ color: s.color, alpha: 0.9 });
      }
    }
    this.dusts = this.dusts.filter((d) => (d.age += dt) < d.life);
    for (const d of this.dusts) {
      const k = d.age / d.life;
      for (const p of d.puffs) {
        o.circle(d.x + p.dx + p.vx * d.age, d.y + p.dy + p.vy * d.age - k * 6, p.r * (0.6 + k * 0.8)).fill({ color: d.color, alpha: 0.4 * (1 - k) });
      }
    }
  }

  /** Eyes shining in the dark: `dark` 0 (daylight) .. 1 (pitch black). Points are already in screen px. */
  renderEyes(points: { x: number; y: number; color: number }[], dark: number, scale: number): void {
    const g = this.eyesLayer.clear();
    if (dark < 0.15) return;
    const a = Math.min(1, (dark - 0.15) * 1.6);
    const s = Math.max(2, scale * 1.2);
    for (const p of points) {
      g.circle(p.x, p.y, s * 3.2).fill({ color: p.color, alpha: a * 0.12 });
      g.circle(p.x, p.y, s * 1.7).fill({ color: p.color, alpha: a * 0.3 });
      g.rect(p.x - s / 2, p.y - s / 2, s, s).fill({ color: 0xffffff, alpha: a * 0.5 });
      g.rect(p.x - s / 2, p.y - s / 2, s, s).fill({ color: p.color, alpha: a * 0.7 });
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
    this.eyesLayer.destroy();
  }
}
