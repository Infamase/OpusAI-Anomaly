import { Container, Graphics } from 'pixi.js';

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  grow: number;
  life: number;
  max: number;
  color: number;
  alpha: number;
}

interface Blast {
  x: number;
  y: number;
  radius: number;
  age: number;
}

interface Scorch {
  x: number;
  y: number;
  r: number;
  seed: number;
}

/** A thing to draw a warning for: a live grenade's danger ring, or a claymore's laser. */
export interface DangerMark {
  x: number;
  y: number;
  /** Grenades: blast radius (px) and 0..1 how close it is to going off. */
  radius?: number;
  urgency?: number;
  /** Claymores: the tripwire line. */
  laser?: { angle: number; length: number };
}

const MAX_SCORCH = 48;

/**
 * Explosions and the warnings before them: a flash and shockwave ring, a
 * fireball that rolls up into smoke, flying grit, scorch marks left on the
 * ground (for the visit), red danger rings under live grenades and the faint
 * laser of a claymore's tripwire. `under` sits below characters; `over` above.
 */
export class ExplosionFx {
  readonly under = new Container({ label: 'explosion-under' });
  readonly over = new Container({ label: 'explosion-over' });
  private ground = new Graphics();
  private marks = new Graphics();
  private air = new Graphics();
  private puffs: Puff[] = [];
  private blasts: Blast[] = [];
  private scorches: Scorch[] = [];
  private scorchDirty = false;
  private time = 0;

  constructor() {
    this.under.addChild(this.ground, this.marks);
    this.over.addChild(this.air);
  }

  /** A blast of `radius` px at (x, y). `heavy` for big charges. */
  burst(x: number, y: number, radius: number, heavy = false): void {
    this.blasts.push({ x, y, radius, age: 0 });
    const n = heavy ? 26 : 18;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (20 + Math.random() * 60) * (heavy ? 1.3 : 1);
      // Fire first, then smoke that drifts up and spreads.
      this.puffs.push({ x, y: y - 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6 - 20, r: 5 + Math.random() * 6, grow: 18, life: 0.35 + Math.random() * 0.25, max: 0.6, color: i % 3 ? 0xffa030 : 0xfff0a0, alpha: 0.95 });
      this.puffs.push({ x: x + Math.cos(a) * 6, y: y - 8, vx: Math.cos(a) * s * 0.5, vy: Math.sin(a) * s * 0.3 - 26, r: 8 + Math.random() * 8, grow: 14, life: 1.4 + Math.random() * 1.2, max: 2.6, color: i % 2 ? 0x4a4640 : 0x6a655c, alpha: 0.55 });
    }
    for (let i = 0; i < (heavy ? 30 : 20); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 120 + Math.random() * 200;
      this.puffs.push({ x, y: y - 4, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 1, grow: 0, life: 0.25 + Math.random() * 0.3, max: 0.55, color: i % 2 ? 0x2a2620 : 0xffd27a, alpha: 1 });
    }
    this.scorches.push({ x, y, r: radius * 0.32, seed: Math.random() * 1000 });
    if (this.scorches.length > MAX_SCORCH) this.scorches.shift();
    this.scorchDirty = true;
  }

  render(dt: number, danger: DangerMark[]): void {
    this.time += dt;
    if (this.scorchDirty) {
      this.scorchDirty = false;
      const g = this.ground;
      g.clear();
      for (const s of this.scorches) {
        for (let k = 0; k < 7; k++) {
          const a = s.seed + k * 2.1;
          const off = s.r * 0.35;
          g.ellipse(s.x + Math.cos(a) * off, s.y + Math.sin(a) * off * 0.6, s.r * (0.55 + (k % 3) * 0.15), s.r * (0.35 + (k % 2) * 0.1)).fill({ color: 0x14100c, alpha: 0.22 });
        }
        g.ellipse(s.x, s.y, s.r * 0.45, s.r * 0.28).fill({ color: 0x0a0806, alpha: 0.4 });
      }
    }

    const m = this.marks;
    m.clear();
    for (const d of danger) {
      if (d.radius) {
        // Pulses faster as the fuse runs out.
        const u = d.urgency ?? 0;
        const pulse = 0.5 + 0.5 * Math.sin(this.time * (6 + u * 14));
        m.ellipse(d.x, d.y, d.radius, d.radius * 0.62).fill({ color: 0xff2a10, alpha: 0.05 + u * 0.08 });
        m.ellipse(d.x, d.y, d.radius, d.radius * 0.62).stroke({ width: 1.5, color: 0xff4a20, alpha: 0.35 + pulse * 0.45 });
        m.circle(d.x, d.y - 3, 2 + pulse * 1.5).fill({ color: 0xff3a20, alpha: 0.8 });
      }
      if (d.laser) {
        const x1 = d.x + Math.cos(d.laser.angle) * d.laser.length;
        const y1 = d.y - 3 + Math.sin(d.laser.angle) * d.laser.length;
        m.moveTo(d.x, d.y - 3).lineTo(x1, y1).stroke({ width: 1, color: 0xff2020, alpha: 0.28 + 0.12 * Math.sin(this.time * 3) });
        m.circle(x1, y1, 1).fill({ color: 0xff4040, alpha: 0.6 });
      }
    }

    const g = this.air;
    g.clear();
    this.blasts = this.blasts.filter((b) => (b.age += dt) < 0.45);
    for (const b of this.blasts) {
      const f = b.age / 0.45;
      if (b.age < 0.08) g.circle(b.x, b.y - 8, b.radius * (0.35 + b.age * 4)).fill({ color: 0xfff6d0, alpha: 0.85 * (1 - b.age / 0.08) });
      g.ellipse(b.x, b.y, b.radius * (0.2 + f * 0.9), b.radius * (0.12 + f * 0.55)).stroke({ width: 3 * (1 - f) + 1, color: 0xfff0c0, alpha: 0.6 * (1 - f) });
    }
    this.puffs = this.puffs.filter((p) => (p.life -= dt) > 0);
    for (const p of this.puffs) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 2.5;
      p.vy *= 1 - dt * 2.5;
      p.r += p.grow * dt;
      const a = p.alpha * Math.min(1, p.life / (p.max * 0.5));
      if (p.grow === 0) g.rect(Math.round(p.x), Math.round(p.y), 2, 2).fill({ color: p.color, alpha: a });
      else g.circle(p.x, p.y, p.r).fill({ color: p.color, alpha: a });
    }
  }

  destroy(): void {
    this.under.destroy({ children: true });
    this.over.destroy({ children: true });
  }
}
