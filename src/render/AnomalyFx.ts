import { Container, Graphics } from 'pixi.js';
import type { AnomalyDef } from '../content/types/anomaly';
import { hashInts } from '../core/rng';

export interface AnomalyView {
  x: number;
  y: number;
  def: AnomalyDef;
  state: 'idle' | 'windup' | 'cooldown';
  /** Seconds left in the current state. */
  timer: number;
  sinceBurst: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: number;
  size: number;
  /** Rises (flames) instead of slowing down. */
  rise: number;
}

interface Arc {
  pts: number[];
  life: number;
  color: number;
  width: number;
}

const hex = (c: string) => parseInt(c.slice(1), 16);
/** Mixes two 0xRRGGBB colors. */
function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Anomaly visuals, all drawn as vector shapes each frame (no art needed):
 * ground marks under characters (scorch, acid, dust swirls) and effects over
 * them (heat flicker, electric arcs, flame columns, shock rings), plus bolts
 * in flight and the glow of revealed artifacts.
 */
export class AnomalyFx {
  /** Goes between the ground and the characters. */
  readonly under = new Container({ label: 'anomaly-ground' });
  /** Goes over the characters. */
  readonly over = new Container({ label: 'anomaly-fx' });
  private gu = new Graphics();
  private go = new Graphics();
  private particles: Particle[] = [];
  private arcs: Arc[] = [];
  private time = 0;
  private nextArc = new Map<string, number>();

  constructor() {
    this.under.addChild(this.gu);
    this.over.addChild(this.go);
  }

  /** The anomaly went off. */
  burst(def: AnomalyDef, x: number, y: number, radiusPx: number): void {
    const c = hex(def.color);
    switch (def.style) {
      case 'burner':
        for (let i = 0; i < 140; i++) {
          const a = Math.random() * Math.PI * 2;
          const d = Math.random() * radiusPx * 0.55;
          this.particles.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.5, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 140, life: 0.45 + Math.random() * 0.6, max: 1, color: [0xfff4b0, 0xffc050, c, 0xe0501a, 0x9a2a10][i % 5]!, size: Math.random() < 0.5 ? 4 : 3, rise: 1 });
        }
        for (let i = 0; i < 14; i++) this.particles.push({ x: x + (Math.random() - 0.5) * radiusPx * 0.6, y: y - 30 - Math.random() * 30, vx: (Math.random() - 0.5) * 12, vy: -30 - Math.random() * 30, life: 1.2 + Math.random() * 0.8, max: 2, color: 0x3a3430, size: 3, rise: 1 });
        break;
      case 'electro':
        for (let i = 0; i < 7; i++) this.arcs.push(this.makeArc(x, y - 8, x + (Math.random() - 0.5) * radiusPx * 2, y - 8 + (Math.random() - 0.5) * radiusPx, 0.3, i < 2 ? 0xffffff : c, 2));
        for (let i = 0; i < 24; i++) this.spark(x, y - 8, c, 120);
        break;
      case 'vortex':
        for (let i = 0; i < 40; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 120 + Math.random() * 160;
          this.particles.push({ x, y: y - 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6, life: 0.4 + Math.random() * 0.4, max: 0.8, color: [0x8a7a5a, 0x6a5a40, c][i % 3]!, size: 2, rise: 0 });
        }
        break;
      default:
        for (let i = 0; i < 16; i++) this.spark(x, y, c, 60);
    }
  }

  private spark(x: number, y: number, color: number, speed: number): void {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random());
    this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.25 + Math.random() * 0.3, max: 0.55, color, size: 1, rise: 0 });
  }

  private makeArc(x0: number, y0: number, x1: number, y1: number, life: number, color: number, width: number): Arc {
    const pts = [x0, y0];
    const n = 6;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push(x0 + (x1 - x0) * t + (Math.random() - 0.5) * 10, y0 + (y1 - y0) * t + (Math.random() - 0.5) * 10);
    }
    pts.push(x1, y1);
    return { pts, life, color, width };
  }

  render(
    dt: number,
    anomalies: Iterable<AnomalyView>,
    bolts: Iterable<{ x: number; y: number; z: number }>,
    artifacts: Iterable<{ x: number; y: number; color: string }>,
    tilePx: number,
  ): void {
    this.time += dt;
    const t = this.time;
    const gu = this.gu;
    const go = this.go;
    gu.clear();
    go.clear();

    for (const a of anomalies) {
      const { x, y, def } = a;
      const r = def.radius * tilePx;
      const c = hex(def.color);
      const vis = def.visibility;
      const seed = hashInts(Math.round(x), Math.round(y));
      const windup = a.state === 'windup' ? 1 - a.timer / Math.max(0.01, def.burst?.windup ?? 1) : 0;
      switch (def.style) {
        case 'burner': {
          gu.ellipse(x, y, r * 0.75, r * 0.42).fill({ color: 0x1a0f08, alpha: 0.28 * vis + 0.1 });
          gu.ellipse(x, y, r * 0.45, r * 0.25).fill({ color: 0x2a1408, alpha: 0.3 * vis });
          // Heat flicker: a few embers rising and fading.
          for (let i = 0; i < 4; i++) {
            const ph = (t * 0.8 + i / 4 + (seed % 97) / 97) % 1;
            const ex = x + Math.sin(i * 2.3 + seed) * r * 0.35;
            go.rect(Math.round(ex), Math.round(y - ph * 26), 1, 2).fill({ color: 0xffa040, alpha: (1 - ph) * 0.7 * vis });
          }
          if (windup > 0) {
            const fl = 0.7 + 0.3 * Math.sin(t * 40);
            gu.ellipse(x, y, r * (0.25 + windup * 0.45), r * (0.15 + windup * 0.26)).fill({ color: 0xff7a1a, alpha: (0.15 + windup * 0.35) * fl });
            gu.ellipse(x, y, r * (0.1 + windup * 0.2), r * (0.06 + windup * 0.12)).fill({ color: 0xfff0a0, alpha: (0.2 + windup * 0.5) * fl });
            for (let i = 0; i < 6; i++) go.rect(Math.round(x + (Math.random() - 0.5) * r), Math.round(y - Math.random() * 12 * windup), 1, 2).fill({ color: 0xffd060, alpha: 0.8 });
          }
          if (a.sinceBurst < 0.8) {
            // The column of fire: stacked flickering tongues, brightest at the base.
            const k = 1 - a.sinceBurst / 0.8;
            for (let i = 0; i < 5; i++) {
              const h = (14 + i * 12) * (0.6 + 0.4 * k);
              const w = r * (0.5 - i * 0.07) * (0.8 + 0.2 * Math.sin(t * 30 + i));
              go.ellipse(x + Math.sin(t * 25 + i * 2) * 2, y - h * 0.6, w, h * 0.55).fill({ color: [0xfff0a0, 0xffc050, 0xff8a2a, 0xe0501a, 0x9a2a10][i]!, alpha: 0.55 * k });
            }
            gu.ellipse(x, y, r * 1.1, r * 0.6).fill({ color: 0xffa040, alpha: 0.25 * k });
          }
          break;
        }
        case 'electro': {
          gu.ellipse(x, y, r * 0.85, r * 0.5).fill({ color: c, alpha: 0.06 * vis + 0.03 * Math.sin(t * 6 + seed) });
          gu.ellipse(x, y, r * 0.85, r * 0.5).stroke({ width: 1, color: c, alpha: 0.3 * vis });
          go.circle(x, y - 8, 2 + Math.sin(t * 9 + seed) * 0.8).fill({ color: 0xe8f8ff, alpha: 0.5 * vis });
          // Idle crackle: short arcs now and then.
          const key = `${seed}`;
          if ((this.nextArc.get(key) ?? 0) < t) {
            this.nextArc.set(key, t + 0.2 + Math.random() * 0.6);
            const a1 = Math.random() * Math.PI * 2;
            const a2 = a1 + 1 + Math.random() * 2;
            this.arcs.push(this.makeArc(x, y - 8, x + Math.cos(a1) * r * 0.6, y - 8 + Math.sin(a1) * r * 0.35, 0.12, c, 1));
            if (Math.random() < 0.5) this.arcs.push(this.makeArc(x + Math.cos(a1) * r * 0.5, y - 8 + Math.sin(a1) * r * 0.3, x + Math.cos(a2) * r * 0.5, y - 8 + Math.sin(a2) * r * 0.3, 0.1, 0xe8f8ff, 1));
          }
          if (windup > 0) go.circle(x, y - 8, 4 + windup * 10).fill({ color: 0xe0f4ff, alpha: 0.25 + windup * 0.5 });
          if (a.sinceBurst < 0.3) go.circle(x, y - 8, r * 0.8).fill({ color: 0xd0f0ff, alpha: 0.35 * (1 - a.sinceBurst / 0.3) });
          break;
        }
        case 'vortex': {
          // Dust and leaves circling, faster and tighter as it winds up.
          const speed = 1.4 + windup * 6;
          gu.ellipse(x, y, r * 0.75, r * 0.42).fill({ color: 0x000000, alpha: 0.06 + windup * 0.08 });
          for (let i = 0; i < 26; i++) {
            const ring = 0.18 + (i % 6) * 0.13;
            const ang = t * speed * (1.25 - ring) * 2 + i * 2.39 + seed;
            const rr = r * ring * (1 - windup * 0.6);
            const lift = i % 4 === 0 ? 6 + Math.sin(t * 3 + i) * 3 : 0;
            go.rect(Math.round(x + Math.cos(ang) * rr), Math.round(y + Math.sin(ang) * rr * 0.55 - lift), 2, 2).fill({ color: [0xd8cfa0, 0x9aa850, 0xb8b0a0, 0xe8e0b8][i % 4]!, alpha: 0.6 * vis + 0.35 + windup * 0.2 });
          }
          // A faint warped ring where the air bends.
          for (let k = 0; k < 8; k++) {
            const a0 = t * 0.9 + (k / 8) * Math.PI * 2;
            gu.moveTo(x + Math.cos(a0) * r * 0.7, y + Math.sin(a0) * r * 0.38)
              .lineTo(x + Math.cos(a0 + 0.35) * r * 0.66, y + Math.sin(a0 + 0.35) * r * 0.36)
              .stroke({ width: 1, color: 0xf0e8d0, alpha: 0.18 * vis + 0.08 });
          }
          gu.ellipse(x, y, r * 0.2, r * 0.11).fill({ color: 0x000000, alpha: 0.18 + windup * 0.3 });
          if (a.sinceBurst < 0.45) {
            const k = a.sinceBurst / 0.45;
            go.ellipse(x, y, r * (0.3 + k * 1.2), r * (0.18 + k * 0.7)).stroke({ width: 3 * (1 - k) + 1, color: 0xe8e0c0, alpha: 0.6 * (1 - k) });
          }
          break;
        }
        case 'acid': {
          gu.ellipse(x, y, r * 0.8, r * 0.48).fill({ color: mix(c, 0x203010, 0.5), alpha: 0.35 * vis + 0.15 });
          gu.ellipse(x, y, r * 0.8, r * 0.48).stroke({ width: 1, color: c, alpha: 0.5 * vis });
          gu.ellipse(x - r * 0.2, y - r * 0.1, r * 0.3, r * 0.12).fill({ color: 0xe8ffb0, alpha: 0.15 * vis });
          for (let i = 0; i < 4; i++) {
            const ph = (t * 0.7 + i * 0.27 + (seed % 53) / 53) % 1;
            const bx = x + Math.cos(i * 1.9 + seed) * r * 0.5;
            const by = y + Math.sin(i * 1.9 + seed) * r * 0.28;
            gu.circle(bx, by, 0.5 + ph * 2).stroke({ width: 1, color: 0xd8ff8a, alpha: (1 - ph) * 0.6 * vis });
          }
          break;
        }
        case 'radiation':
          if (vis > 0) gu.ellipse(x, y, r * 0.6, r * 0.35).fill({ color: c, alpha: 0.08 * vis });
          break;
      }
    }

    // Revealed artifacts glow and pulse.
    for (const a of artifacts) {
      const p = 0.5 + 0.5 * Math.sin(t * 3 + a.x * 0.1);
      gu.ellipse(a.x, a.y, 9 + p * 3, 4.5 + p * 1.5).fill({ color: hex(a.color), alpha: 0.18 + p * 0.15 });
    }

    // Bolts: a shadow on the ground, the bolt above it.
    for (const b of bolts) {
      gu.ellipse(b.x, b.y, 2.5, 1.2).fill({ color: 0x000000, alpha: 0.35 });
      go.rect(Math.round(b.x - 2), Math.round(b.y - b.z - 1), 4, 2).fill({ color: 0x9a9890 });
      go.rect(Math.round(b.x - 2), Math.round(b.y - b.z - 1), 1, 1).fill({ color: 0xe0dccc });
    }

    // Draw, then age: even at a low frame rate everything shows for at least a frame.
    for (const a of this.arcs) {
      go.moveTo(a.pts[0]!, a.pts[1]!);
      for (let i = 2; i < a.pts.length; i += 2) go.lineTo(a.pts[i]!, a.pts[i + 1]!);
      go.stroke({ width: a.width, color: a.color, alpha: 0.9 });
    }
    this.arcs = this.arcs.filter((a) => (a.life -= dt) > 0);
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.rise) p.vx *= 0.97;
      else {
        p.vx *= 0.9;
        p.vy *= 0.9;
      }
      go.rect(Math.round(p.x), Math.round(p.y), p.size, p.size).fill({ color: p.color, alpha: Math.min(1, (p.life / p.max) * 1.4) });
    }
  }

  destroy(): void {
    this.under.destroy({ children: true });
    this.over.destroy({ children: true });
  }
}
