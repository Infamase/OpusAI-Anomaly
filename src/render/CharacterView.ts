import { Container, Graphics, Rectangle, RenderTexture, Sprite, Texture, type Renderer } from 'pixi.js';
import { poseKey, PUPPET_PARTS, solvePose, type PartId, type PuppetPose, type PuppetRig, type PuppetState } from './puppet';
import type { SpriteSheet } from './SpriteSheets';

/**
 * Paper-doll draw order, bottom to top. Each layer is a piece atlas with the
 * same layout as the body, so every armor piece moves with its body piece.
 */
export const PAPER_DOLL_ORDER = ['body', 'legs', 'torso', 'head'] as const;
export type PaperDollSlot = (typeof PAPER_DOLL_ORDER)[number];

const HIT_FLASH = 0.09;
const RECOIL_TIME = 0.14;
/** The posed character is drawn into a texture this big; character-space (0,0) (the feet) sits at ORIGIN. */
const RT_W = 112;
const RT_H = 96;
const ORIGIN_X = 56;
const ORIGIN_Y = 80;
/** Distance (px) covered by one walk / sprint cycle. */
const WALK_CYCLE = 46;
const SPRINT_CYCLE = 70;

/** What the game tells the view each frame; the view turns it into a pose. */
export interface CharacterViewState {
  facing: PuppetState['facing'];
  /** Current speed and the character's normal walking speed (px/s). */
  speed: number;
  walkSpeed: number;
  sprint: boolean;
  /** Aim angle (radians) or null when not aiming. */
  aim: number | null;
  /** 0..1 reload progress, or null. */
  reload: number | null;
}

/** Slot spacing in the shared texture (a gutter keeps long guns from bleeding into neighbors). */
const SLOT_W = RT_W + 16;
const SLOT_H = RT_H + 16;
/** Max pose redraws per second. */
const POSE_HZ = 30;

/**
 * All posed characters share one big render texture, one slot each, redrawn in
 * a single pass per frame (only when something changed). One pass instead of
 * one per character keeps GPU target switches to a minimum.
 */
class PuppetBatch {
  readonly root = new Container({ label: 'puppets' });
  private rt: RenderTexture | null = null;
  private size = 512;
  private used: boolean[] = [];
  private dirty = false;
  private lastFlush = -Infinity;
  private views = new Set<CharacterView>();

  private get perRow(): number {
    return Math.floor(this.size / SLOT_W);
  }

  private get capacity(): number {
    return this.perRow * Math.floor(this.size / SLOT_H);
  }

  /** Reserves a slot; returns its index. */
  add(view: CharacterView): number {
    let i = this.used.indexOf(false);
    if (i < 0) i = this.used.length;
    this.used[i] = true;
    this.views.add(view);
    if (i >= this.capacity && this.size < 4096) this.grow();
    this.dirty = true;
    return i;
  }

  remove(view: CharacterView, slot: number): void {
    this.used[slot] = false;
    this.views.delete(view);
    this.dirty = true;
  }

  /** Top-left of a slot, and the texture showing it. */
  slot(i: number): { x: number; y: number; texture: Texture } {
    const x = (i % this.perRow) * SLOT_W + 8;
    const y = Math.floor(i / this.perRow) * SLOT_H + 8;
    const rt = this.target();
    return { x, y, texture: new Texture({ source: rt.source, frame: new Rectangle(x, y, RT_W, RT_H) }) };
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Draws every puppet into its slot if anything changed, at most POSE_HZ times
   * a second (plenty for pixel-art animation; old sheets ran at 10 fps).
   */
  flush(gpu: Renderer): void {
    if (!this.dirty) return;
    const now = performance.now();
    if (now - this.lastFlush < 1000 / POSE_HZ) return;
    this.lastFlush = now;
    this.dirty = false;
    gpu.render({ container: this.root, target: this.target(), clear: true });
    CharacterView.redraws++;
  }

  private target(): RenderTexture {
    this.rt ??= RenderTexture.create({ width: this.size, height: this.size, resolution: 1, scaleMode: 'nearest', antialias: false });
    return this.rt;
  }

  private grow(): void {
    this.size *= 2;
    this.rt?.destroy(true);
    this.rt = null;
    for (const v of this.views) v.reslot();
  }
}

/**
 * One character on screen, as a cutout puppet: each body piece (and the armor
 * pieces on it) is a sprite rotated about its joint. The pieces are drawn at
 * 1x into a slot of a shared render texture, which the world then scales up
 * with the camera, so rotated pieces keep crisp, square pixels like
 * hand-drawn frames. The slot is only redrawn when the pose changes.
 */
export class CharacterView {
  /** Set once at startup; without it (tests) the view keeps its state but draws nothing. */
  static gpu: Renderer | null = null;
  /** Batch redraws so far (dev stats). */
  static redraws = 0;
  private static batch = new PuppetBatch();

  /** Draws all changed characters. Call once per frame before rendering the stage. */
  static flush(): void {
    if (CharacterView.gpu) CharacterView.batch.flush(CharacterView.gpu);
  }

  readonly root = new Container({ label: 'character' });
  /** Everything except the shadow; rotated to lie down on death. */
  private figure: Sprite;
  private shadow: Graphics;
  private slotIndex = -1;
  private puppet = new Container({ label: 'puppet', sortableChildren: true });
  private bones = new Map<PartId, { node: Container; sprites: Sprite[] }>();
  private weaponSprite: Sprite | null = null;
  private weaponGeo: PuppetState['weapon'] = null;
  private layers = new Map<PaperDollSlot, SpriteSheet>();
  private rig: PuppetRig | null = null;
  private dirty = true;
  private lastKey = '';
  private flashLeft = 0;
  private dead = false;
  private phase = 0;
  private time = Math.random() * 10;
  private recoilLeft = 0;
  private state: CharacterViewState = { facing: 'down', speed: 0, walkSpeed: 70, sprint: false, aim: null, reload: null };
  /** The last pose drawn (for tests and debugging). */
  pose: PuppetPose | null = null;

  constructor() {
    this.shadow = new Graphics().ellipse(0, 0, 11, 4).fill({ color: 0x000000, alpha: 0.35 });
    this.figure = new Sprite();
    this.figure.anchor.set(ORIGIN_X / RT_W, ORIGIN_Y / RT_H);
    this.root.addChild(this.shadow, this.figure);
    for (const part of PUPPET_PARTS) {
      const node = new Container({ label: part });
      this.puppet.addChild(node);
      this.bones.set(part, { node, sprites: [] });
    }
  }

  /** Sets (or clears, with null) one paper-doll layer. The body layer carries the rig. */
  setLayer(slot: PaperDollSlot, sheet: SpriteSheet | null, rig?: PuppetRig | null): void {
    if (sheet) this.layers.set(slot, sheet);
    else this.layers.delete(slot);
    if (slot === 'body' && rig !== undefined) this.rig = rig;
    // Rebuild each bone's sprite stack in paper-doll order.
    for (const { node, sprites } of this.bones.values()) {
      for (const s of sprites) s.destroy();
      sprites.length = 0;
      for (const layer of PAPER_DOLL_ORDER) {
        if (!this.layers.has(layer)) continue;
        const s = new Sprite();
        sprites.push(s);
        node.addChild(s);
      }
    }
    this.dirty = true;
  }

  /** Shows a held weapon (texture points right; grip = pixel held in the hand), or hides it. */
  setWeapon(texture: Texture | null, grip: [number, number] = [0, 0], muzzle: [number, number] = [grip[0] + 10, grip[1]]): void {
    if (!texture) {
      this.weaponSprite?.destroy();
      this.weaponSprite = null;
      this.weaponGeo = null;
      this.dirty = true;
      return;
    }
    if (!this.weaponSprite) {
      this.weaponSprite = new Sprite();
      this.puppet.addChild(this.weaponSprite);
    }
    this.weaponSprite.texture = texture;
    this.weaponSprite.anchor.set((grip[0] + 0.5) / texture.width, (grip[1] + 0.5) / texture.height);
    this.weaponGeo = { grip: { x: grip[0], y: grip[1] }, muzzle: { x: muzzle[0], y: muzzle[1] } };
    this.dirty = true;
  }

  /** A shot was fired: kick the arms and gun back. */
  fire(): void {
    this.recoilLeft = RECOIL_TIME;
  }

  /** Advances the animation and redraws if the pose changed. Returns true when a foot came down. */
  update(dt: number, state: CharacterViewState): boolean {
    this.state = state;
    this.time += dt;
    this.recoilLeft = Math.max(0, this.recoilLeft - dt);
    const step = Math.floor(this.phase / Math.PI);
    if (!this.dead) this.phase += ((state.speed * dt) / (state.sprint ? SPRINT_CYCLE : WALK_CYCLE)) * Math.PI * 2;
    this.redraw();
    // Feet plant twice per walk cycle, at phase 0 and π.
    return !this.dead && state.speed > 4 && Math.floor(this.phase / Math.PI) !== step;
  }

  setPosition(x: number, y: number): void {
    this.root.position.set(x, y);
    // Depth sort by feet position; corpses sit under the living.
    this.root.zIndex = this.dead ? y - 1000 : y;
  }

  /** Brief red tint when hit. */
  flash(): void {
    this.flashLeft = HIT_FLASH;
  }

  setDead(dead: boolean): void {
    this.dead = dead;
    this.state = { ...this.state, speed: 0, sprint: false, aim: null, reload: null };
    if (this.weaponSprite) this.weaponSprite.visible = !dead;
    // Lying down: the body is centered on where the character stood.
    this.figure.rotation = dead ? Math.PI / 2 : 0;
    this.figure.position.set(dead ? -26 : 0, dead ? 5 : 0);
    this.figure.tint = dead ? 0x8a8a8a : 0xffffff;
    this.dirty = true;
    this.redraw();
  }

  /** Per-frame timers (hit flash). */
  tick(dt: number): void {
    if (this.flashLeft <= 0) return;
    this.flashLeft -= dt;
    this.figure.tint = this.flashLeft > 0 ? 0xff7070 : this.dead ? 0x8a8a8a : 0xffffff;
  }

  destroy(): void {
    if (this.slotIndex >= 0) CharacterView.batch.remove(this, this.slotIndex);
    this.root.destroy({ children: true });
    this.puppet.destroy({ children: true });
  }

  private redraw(): void {
    const rig = this.rig;
    const body = this.layers.get('body');
    if (!rig || !body) return;
    const s = this.state;
    const moving = this.dead ? 0 : Math.min(1, s.speed / Math.max(1, s.walkSpeed));
    const pose = solvePose(rig, {
      facing: s.facing,
      phase: this.phase,
      moving: moving < 0.08 ? 0 : moving,
      sprint: s.sprint,
      aim: this.dead ? null : s.aim,
      weapon: this.dead ? null : this.weaponGeo,
      recoil: this.recoilLeft / RECOIL_TIME,
      reload: s.reload,
      time: this.dead ? 0 : this.time,
    });
    this.pose = pose;
    const key = poseKey(pose);
    if (!this.dirty && key === this.lastKey) return;
    this.lastKey = key;
    this.dirty = false;
    this.apply(rig, pose);
    this.render();
  }

  private apply(rig: PuppetRig, pose: PuppetPose): void {
    const dirRig = rig.dirs[pose.dir];
    const order = new Map(pose.order.map((id, i) => [id, i] as const));
    for (const part of PUPPET_PARTS) {
      const bone = this.bones.get(part)!;
      const b = pose.bones[part];
      const p = dirRig.parts[part];
      bone.node.visible = !!b && !!p;
      if (!b || !p) continue;
      bone.node.position.set(Math.round(b.x), Math.round(b.y));
      bone.node.rotation = b.angle;
      bone.node.zIndex = order.get(part) ?? 0;
      const col = PUPPET_PARTS.indexOf(part);
      let i = 0;
      for (const layer of PAPER_DOLL_ORDER) {
        const sheet = this.layers.get(layer);
        if (!sheet) continue;
        const sprite = bone.sprites[i++]!;
        sprite.texture = sheet.frame('parts', pose.dir, col);
        sprite.position.set(-Math.round(p.pivot.x), -Math.round(p.pivot.y));
      }
    }
    if (this.weaponSprite) {
      const w = pose.weapon;
      this.weaponSprite.visible = !!w && !this.dead;
      if (w) {
        this.weaponSprite.position.set(Math.round(w.x), Math.round(w.y));
        this.weaponSprite.rotation = w.angle;
        this.weaponSprite.scale.set(1, w.flipY ? -1 : 1);
        this.weaponSprite.zIndex = order.get('weapon') ?? 99;
      }
    }
    this.puppet.scale.x = pose.flip ? -1 : 1;
  }

  private render(): void {
    if (!CharacterView.gpu) return;
    if (this.slotIndex < 0) {
      this.slotIndex = CharacterView.batch.add(this);
      CharacterView.batch.root.addChild(this.puppet);
      this.reslot();
    }
    CharacterView.batch.markDirty();
  }

  /** (Re)binds this character to its slot in the shared texture. */
  reslot(): void {
    if (this.slotIndex < 0) return;
    const old = this.figure.texture;
    const { x, y, texture } = CharacterView.batch.slot(this.slotIndex);
    this.puppet.position.set(x + ORIGIN_X, y + ORIGIN_Y);
    this.figure.texture = texture;
    if (old !== Texture.EMPTY) old.destroy(false);
  }
}
