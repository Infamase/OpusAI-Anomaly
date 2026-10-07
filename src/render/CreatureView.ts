import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { creatureModel, frameSize, paintCreature, poseCreature, type CreatureAction, type CreatureModel, type CreaturePose } from './creatureBody';
import type { CreatureDef } from '../content/types/creature';
import { PixelCanvas } from './PixelCanvas';
import { Rig } from './placeholder/rig';

/** Pose redraws per second while it's moving or attacking (pixel-art frame rate), and while it idles. */
const POSE_HZ = 15;
const IDLE_HZ = 5;
const HIT_FLASH = 0.09;

/** What the game tells the view each frame. */
export interface CreatureViewState {
  heading: number;
  speed: number;
  action: CreatureAction;
  actionT: number;
  attack?: string;
  /** Height off the ground (a pounce), px. */
  lift: number;
  /** 0 visible .. 1 nearly invisible (a shade's cloak). */
  cloak: number;
  /** Serpents: 0 surfaced .. 1 under the ground. */
  buried: number;
}

const models = new Map<string, CreatureModel>();
function modelFor(def: CreatureDef): CreatureModel {
  let m = models.get(def.id);
  if (!m) {
    m = creatureModel(def);
    models.set(def.id, m);
  }
  return m;
}

/**
 * One creature on screen. Its skeleton is posed and painted in code (see
 * creatureBody.ts) into a small canvas, a few times a second while it moves,
 * and shown as a sprite at 1 px per world px, so it scales up with the camera
 * as crisply as the hand-pixeled characters.
 */
export class CreatureView {
  /** Set false in tests (no DOM): the view keeps its state but paints nothing. */
  static enabled = typeof document !== 'undefined';

  readonly root = new Container({ label: 'creature' });
  readonly model: CreatureModel;
  private sprite = new Sprite();
  private shadow = new Graphics();
  private mound = new Graphics();
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private texture: Texture | null = null;
  private rig: Rig | null = null;
  private pixels: PixelCanvas | null = null;
  private image: ImageData | null = null;
  private phase = 0;
  private time = Math.random() * 10;
  private redrawIn = 0;
  private dead = false;
  private flashLeft = 0;
  private trail: { x: number; y: number }[] = [];
  private x = 0;
  private y = 0;
  private state: CreatureViewState = { heading: Math.PI / 2, speed: 0, action: 'none', actionT: 0, lift: 0, cloak: 0, buried: 0 };
  /** Glowing eyes this frame, world px. */
  eyes: { x: number; y: number }[] = [];
  private glowLocal: { x: number; y: number }[] = [];
  /** The last pose painted (tests, debugging). */
  pose: CreaturePose | null = null;
  /** Off screen: skip painting. */
  visibleOnScreen = true;

  constructor(readonly def: CreatureDef) {
    this.model = modelFor(def);
    const { ox, oy, w, h } = frameSize(this.model);
    this.sprite.anchor.set(ox / w, oy / h);
    const r = this.model.shadow;
    this.shadow.ellipse(0, 0, r, Math.max(2, r * 0.38)).fill({ color: 0x000000, alpha: 0.3 });
    this.root.addChild(this.shadow, this.mound, this.sprite);
  }

  /** Advances the animation; repaints a few times a second. Returns true when a foot came down. */
  update(dt: number, s: CreatureViewState): boolean {
    this.state = s;
    this.time += dt;
    const m = this.model;
    const walk = this.def.speed.walk;
    const run = this.def.speed.run;
    const gait = this.dead ? 0 : s.speed < walk * 1.15 ? s.speed / walk : 1 + Math.min(1, (s.speed - walk) / Math.max(1, run - walk));
    const stride = gait > 1 ? m.stride.walk + (m.stride.run - m.stride.walk) * (gait - 1) : m.stride.walk;
    const before = Math.floor(this.phase * 2);
    if (!this.dead) this.phase += (s.speed * dt) / Math.max(4, stride);
    this.flashLeft = Math.max(0, this.flashLeft - dt);
    // Visibility: cloaked creatures are a faint shimmer; buried ones only a moving mound.
    const shimmer = s.cloak > 0 ? 0.16 + (1 - s.cloak) * 0.84 + Math.sin(this.time * 9) * 0.04 * s.cloak : 1;
    this.sprite.alpha = Math.max(0, Math.min(1, shimmer));
    this.sprite.tint = this.flashLeft > 0 ? 0xff7070 : this.dead ? 0x9a9a9a : 0xffffff;
    this.sprite.position.set(0, -s.lift);
    this.shadow.alpha = (1 - s.buried) * (1 - s.cloak * 0.8) * (s.lift > 0 ? Math.max(0.4, 1 - s.lift / 60) : 1);
    this.drawMound(s);
    this.redrawIn -= dt;
    if (this.redrawIn <= 0 || this.pose === null) {
      this.redrawIn = this.dead ? 1e9 : 1 / (s.speed > 3 || s.action !== 'none' || s.lift > 0 ? POSE_HZ : IDLE_HZ);
      this.paint(gait);
    }
    this.eyes = this.glowLocal.map((p) => ({ x: this.x + p.x, y: this.y + p.y - s.lift }));
    return !this.dead && s.speed > 4 && s.buried < 0.5 && Math.floor(this.phase * 2) !== before;
  }

  setPosition(x: number, y: number): void {
    // Serpents remember where they've been, so the body follows the head's path.
    if (this.model.plan === 'serpent' && !this.dead) {
      const last = this.trail[0];
      if (!last || Math.hypot(x - last.x, y - last.y) > 2) {
        this.trail.unshift({ x, y });
        let total = 0;
        for (let i = 1; i < this.trail.length; i++) {
          total += Math.hypot(this.trail[i]!.x - this.trail[i - 1]!.x, this.trail[i]!.y - this.trail[i - 1]!.y);
          if (total > this.model.L * 1.3) {
            this.trail.length = i + 1;
            break;
          }
        }
      }
    }
    this.x = x;
    this.y = y;
    this.root.position.set(x, y);
    this.root.zIndex = this.dead ? y - 1000 : y;
  }

  flash(): void {
    this.flashLeft = HIT_FLASH;
  }

  setDead(dead: boolean): void {
    if (this.dead === dead) return;
    this.dead = dead;
    this.state = { ...this.state, speed: 0, action: 'none', lift: 0, cloak: 0, buried: 0 };
    this.redrawIn = 0;
    this.paint(0);
    this.root.zIndex = dead ? this.y - 1000 : this.y;
  }

  get isDead(): boolean {
    return this.dead;
  }

  destroy(): void {
    this.texture?.destroy(true);
    this.root.destroy({ children: true });
  }

  private paint(gait: number): void {
    const s = this.state;
    const pose: CreaturePose = {
      heading: s.heading,
      gait,
      phase: this.phase,
      time: this.time,
      action: this.dead ? 'none' : s.action,
      actionT: s.actionT,
      attack: s.attack,
      dead: this.dead,
      buried: s.buried,
      trail: this.trail.map((p) => ({ x: p.x - this.x, y: p.y - this.y })),
    };
    this.pose = pose;
    if (!CreatureView.enabled || (!this.visibleOnScreen && !this.dead && this.texture)) return;
    const { w, h } = frameSize(this.model);
    this.rig ??= new Rig(w, h);
    this.pixels ??= new PixelCanvas(w, h);
    const frame = paintCreature(this.model, poseCreature(this.model, pose), pose.heading, this.dead, this.rig, this.pixels);
    const { ox, oy } = frameSize(this.model);
    this.glowLocal = frame.glow.map((p) => ({ x: p.x - ox, y: p.y - oy }));
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = this.canvas.getContext('2d');
      this.image = new ImageData(this.pixels.data as unknown as Uint8ClampedArray<ArrayBuffer>, w, h);
      this.texture = Texture.from(this.canvas);
      this.texture.source.scaleMode = 'nearest';
      this.sprite.texture = this.texture;
    }
    this.ctx!.putImageData(this.image!, 0, 0);
    this.texture!.source.update();
  }

  /** A ripple of earth over a burrowing creature. */
  private drawMound(s: CreatureViewState): void {
    this.mound.clear();
    if (s.buried <= 0.05 || this.dead) return;
    const r = this.model.shadow * 0.55;
    const wob = Math.sin(this.time * 14) * 0.6;
    const a = Math.min(1, s.buried * 1.5) * (s.speed > 5 ? 1 : 0.55);
    this.mound
      .ellipse(0, -1, r + wob, r * 0.42)
      .fill({ color: 0x6a5434, alpha: 0.85 * a })
      .ellipse(-r * 0.2, -2, r * 0.6, r * 0.22)
      .fill({ color: 0x9a805a, alpha: 0.8 * a });
    for (let i = 0; i < 4; i++) {
      const k = (this.time * 3 + i * 0.25) % 1;
      const dx = Math.cos(this.state.heading + Math.PI + (i - 1.5) * 0.4) * r * (0.6 + k * 1.2);
      const dy = Math.sin(this.state.heading + Math.PI + (i - 1.5) * 0.4) * r * (0.6 + k * 1.2) * 0.5;
      this.mound.rect(dx, dy - 1 - k * 2, 1.5, 1.5).fill({ color: 0x8a7050, alpha: (1 - k) * a * (s.speed > 5 ? 1 : 0) });
    }
  }
}
