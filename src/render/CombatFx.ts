import { Container, Graphics } from 'pixi.js';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
}

interface Flash {
  x: number;
  y: number;
  angle: number;
  life: number;
}

/**
 * Short-lived combat visuals, redrawn every frame into one Graphics object:
 * bullet tracers, muzzle flashes, impact sparks, blood, and health bars over
 * recently hit characters. Cheap, and needs no art.
 */
export class CombatFx {
  readonly layer = new Container({ label: 'combat-fx' });
  private g = new Graphics();
  private particles: Particle[] = [];
  private flashes: Flash[] = [];

  constructor() {
    this.layer.addChild(this.g);
  }

  muzzle(x: number, y: number, angle: number): void {
    this.flashes.push({ x, y, angle, life: 0.05 });
  }

  sparks(x: number, y: number, angle: number): void {
    this.burst(x, y, angle + Math.PI, 5, [0xffe08a, 0xffc040, 0xc0b8a0], 70, 0.25);
  }

  blood(x: number, y: number, angle: number, amount: number): void {
    this.burst(x, y, angle, Math.min(10, 3 + Math.round(amount / 6)), [0x9a1a1a, 0x701010, 0xc02a2a], 60, 0.45);
  }

  /** Chips and splinters of a struck or shattered object, in shades of its color ("#rrggbb"). */
  debris(x: number, y: number, angle: number, color: string, n: number): void {
    if (n <= 0) return;
    const c = parseInt(color.slice(1), 16);
    const shade = (k: number) => {
      const r = Math.min(255, Math.round(((c >> 16) & 255) * k));
      const g = Math.min(255, Math.round(((c >> 8) & 255) * k));
      const b = Math.min(255, Math.round((c & 255) * k));
      return (r << 16) | (g << 8) | b;
    };
    this.burst(x, y, angle, n, [shade(1), shade(0.7), shade(1.25), shade(0.5)], n > 8 ? 110 : 60, n > 8 ? 0.7 : 0.35);
  }

  private burst(x: number, y: number, angle: number, n: number, colors: number[], speed: number, life: number): void {
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() - 0.5) * 1.6;
      const s = speed * (0.4 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: life * (0.6 + Math.random() * 0.6),
        max: life,
        color: colors[i % colors.length]!,
        size: Math.random() < 0.3 ? 2 : 1,
      });
    }
  }

  /**
   * Draws this frame. `tracers` are bullet positions with velocity;
   * `bars` are health bars to show (feet position, fraction 0..1).
   */
  render(
    dt: number,
    tracers: Iterable<{ x: number; y: number; vx: number; vy: number }>,
    bars: Iterable<{ x: number; y: number; frac: number }>,
  ): void {
    const g = this.g;
    g.clear();
    for (const t of tracers) {
      const len = Math.hypot(t.vx, t.vy) || 1;
      const tail = 9;
      g.moveTo(t.x, t.y)
        .lineTo(t.x - (t.vx / len) * tail, t.y - (t.vy / len) * tail)
        .stroke({ width: 1, color: 0xffe7a0, alpha: 0.9 });
    }
    this.flashes = this.flashes.filter((f) => (f.life -= dt) > 0);
    for (const f of this.flashes) {
      const c = Math.cos(f.angle);
      const s = Math.sin(f.angle);
      g.poly([f.x - s * 2, f.y + c * 2, f.x + c * 6, f.y + s * 6, f.x + s * 2, f.y - c * 2]).fill({ color: 0xffd36a, alpha: 0.95 });
      g.circle(f.x, f.y, 2).fill({ color: 0xfff4c8 });
    }
    this.particles = this.particles.filter((p) => (p.life -= dt) > 0);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.9;
      p.vy *= 0.9;
      g.rect(Math.round(p.x), Math.round(p.y), p.size, p.size).fill({ color: p.color, alpha: Math.min(1, (p.life / p.max) * 1.5) });
    }
    for (const b of bars) {
      const w = 16;
      const x = Math.round(b.x - w / 2);
      const y = Math.round(b.y - 38);
      g.rect(x - 1, y - 1, w + 2, 4).fill({ color: 0x000000, alpha: 0.7 });
      g.rect(x, y, Math.max(0, Math.round(w * b.frac)), 2).fill({ color: b.frac > 0.35 ? 0xc8402e : 0xff2a1a });
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
