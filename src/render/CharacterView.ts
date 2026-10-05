import { Container, Graphics, Sprite } from 'pixi.js';
import type { SpriteSheet } from './SpriteSheets';

/**
 * Paper-doll draw order, bottom to top. Each layer is a full sheet with the same
 * layout as the body, so every armor piece lines up frame-for-frame.
 * Phase 1 fills in the armor slots; the body is always present.
 */
export const PAPER_DOLL_ORDER = ['body', 'legs', 'torso', 'head'] as const;
export type PaperDollSlot = (typeof PAPER_DOLL_ORDER)[number];

export class CharacterView {
  readonly root = new Container({ label: 'character' });
  private shadow: Graphics;
  private layers = new Map<PaperDollSlot, { sprite: Sprite; sheet: SpriteSheet }>();
  private anchorX = 24;
  private anchorY = 44;

  constructor() {
    this.shadow = new Graphics().ellipse(0, 0, 8, 3).fill({ color: 0x000000, alpha: 0.35 });
    this.root.addChild(this.shadow);
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
      const sprite = new Sprite();
      this.layers.set(slot, { sprite, sheet });
      // Re-add in paper-doll order.
      for (const s of PAPER_DOLL_ORDER) {
        const l = this.layers.get(s);
        if (l) this.root.addChild(l.sprite);
      }
    }
    if (slot === 'body') {
      [this.anchorX, this.anchorY] = sheet.layout.anchor;
    }
  }

  setFrame(anim: string, dir: string, index: number): void {
    for (const { sprite, sheet } of this.layers.values()) {
      sprite.texture = sheet.frame(anim, dir, index);
      sprite.position.set(-this.anchorX, -this.anchorY);
    }
  }

  setPosition(x: number, y: number): void {
    this.root.position.set(x, y);
    // Depth sort by feet position.
    this.root.zIndex = y;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
