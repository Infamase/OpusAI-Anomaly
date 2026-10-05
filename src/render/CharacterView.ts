import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import type { SpriteSheet } from './SpriteSheets';

/**
 * Paper-doll draw order, bottom to top. Each layer is a full sheet with the same
 * layout as the body, so every armor piece lines up frame-for-frame.
 */
export const PAPER_DOLL_ORDER = ['body', 'legs', 'torso', 'head'] as const;
export type PaperDollSlot = (typeof PAPER_DOLL_ORDER)[number];

/** Gun pivot: chest height above the feet. Keep in sync with CHEST_HEIGHT in game/combat.ts. */
const PIVOT_Y = -26;
const HOLD_DISTANCE = 5;
const HIT_FLASH = 0.09;

/**
 * One character on screen: shadow, paper-doll layers and a held weapon that
 * rotates freely toward the aim (drawn behind the body when facing away).
 */
export class CharacterView {
  readonly root = new Container({ label: 'character' });
  /** Everything except the shadow; rotated to lie down on death. */
  private figure = new Container({ label: 'figure' });
  private shadow: Graphics;
  private layers = new Map<PaperDollSlot, { sprite: Sprite; sheet: SpriteSheet }>();
  private weapon: Sprite | null = null;
  private anchorX = 32;
  private anchorY = 60;
  private flashLeft = 0;
  private dead = false;

  constructor() {
    this.shadow = new Graphics().ellipse(0, 0, 11, 4).fill({ color: 0x000000, alpha: 0.35 });
    this.root.addChild(this.shadow, this.figure);
  }

  /** Sets (or clears, with null) the sheet drawn for one paper-doll slot. */
  setLayer(slot: PaperDollSlot, sheet: SpriteSheet | null): void {
    const existing = this.layers.get(slot);
    if (!sheet) {
      if (existing) {
        existing.sprite.destroy();
        this.layers.delete(slot);
      }
      return;
    }
    if (existing) {
      existing.sheet = sheet;
    } else {
      this.layers.set(slot, { sprite: new Sprite(), sheet });
      this.reorder(false);
    }
    if (slot === 'body') [this.anchorX, this.anchorY] = sheet.layout.anchor;
  }

  /** Shows a held weapon (texture points right; grip = pixel held in the hand), or hides it. */
  setWeapon(texture: Texture | null, grip: [number, number] = [0, 0]): void {
    if (!texture) {
      this.weapon?.destroy();
      this.weapon = null;
      return;
    }
    if (!this.weapon) this.weapon = new Sprite();
    this.weapon.texture = texture;
    this.weapon.anchor.set((grip[0] + 0.5) / texture.width, (grip[1] + 0.5) / texture.height);
    this.reorder(false);
  }

  /** Points the weapon along `angle` (radians); facing away puts it behind the body. */
  setAim(angle: number | null, facing: string): void {
    if (!this.weapon) return;
    this.weapon.visible = angle !== null && !this.dead;
    if (angle === null) return;
    const left = Math.cos(angle) < 0;
    this.weapon.rotation = angle;
    this.weapon.scale.set(1, left ? -1 : 1);
    this.weapon.position.set(Math.cos(angle) * HOLD_DISTANCE, PIVOT_Y + Math.sin(angle) * HOLD_DISTANCE);
    this.reorder(facing === 'up');
  }

  setFrame(anim: string, dir: string, index: number): void {
    for (const { sprite, sheet } of this.layers.values()) {
      sprite.texture = sheet.frame(anim, dir, index);
      sprite.position.set(-this.anchorX, -this.anchorY);
    }
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
    this.figure.rotation = dead ? Math.PI / 2 : 0;
    // Lying down: the body is centered on where the character stood.
    this.figure.position.set(dead ? -26 : 0, dead ? 5 : 0);
    if (this.weapon) this.weapon.visible = !dead;
    this.tint(dead ? 0x8a8a8a : 0xffffff);
  }

  /** Per-frame timers (hit flash). */
  tick(dt: number): void {
    if (this.flashLeft <= 0) return;
    this.flashLeft -= dt;
    this.tint(this.flashLeft > 0 ? 0xff7070 : this.dead ? 0x8a8a8a : 0xffffff);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }

  private tint(color: number): void {
    for (const { sprite } of this.layers.values()) sprite.tint = color;
  }

  /** Paper-doll layers in order, with the weapon in front of or behind them. */
  private reorder(weaponBehind: boolean): void {
    const order: Sprite[] = [];
    if (this.weapon && weaponBehind) order.push(this.weapon);
    for (const s of PAPER_DOLL_ORDER) {
      const l = this.layers.get(s);
      if (l) order.push(l.sprite);
    }
    if (this.weapon && !weaponBehind) order.push(this.weapon);
    order.forEach((child, i) => {
      if (child.parent !== this.figure) this.figure.addChild(child);
      if (this.figure.getChildIndex(child) !== i) this.figure.setChildIndex(child, i);
    });
  }
}
