import { Container, Graphics, Sprite, type Texture } from 'pixi.js';

/** A small static world sprite with a shadow (items on the ground, crates, ...). */
export class PropView {
  readonly root = new Container({ label: 'prop' });
  private sprite: Sprite;
  private glow: Graphics;

  constructor(texture: Texture, opts: { shadow?: number } = {}) {
    const shadowW = opts.shadow ?? Math.max(4, texture.width / 2);
    this.glow = new Graphics().ellipse(0, -2, shadowW + 3, 4).stroke({ width: 1, color: 0xf3e4b0, alpha: 0.85 });
    this.glow.visible = false;
    this.root.addChild(new Graphics().ellipse(0, 0, shadowW, 2.5).fill({ color: 0x000000, alpha: 0.35 }), this.glow);
    this.sprite = new Sprite(texture);
    this.sprite.anchor.set(0.5, 1);
    this.root.addChild(this.sprite);
  }

  setPosition(x: number, y: number): void {
    this.root.position.set(Math.round(x), Math.round(y));
    this.root.zIndex = y;
  }

  /** Hidden props (undetected artifacts) aren't drawn at all. */
  setHidden(hidden: boolean): void {
    this.root.visible = !hidden;
  }

  /** A brief pale flash when struck. */
  flash(): void {
    this.sprite.tint = 0xffe0c0;
    setTimeout(() => {
      if (!this.sprite.destroyed) this.sprite.tint = 0xffffff;
    }, 70);
  }

  /** Outline shown when it's the thing E would interact with. */
  setHighlight(on: boolean): void {
    this.glow.visible = on;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
