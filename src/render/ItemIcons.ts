import { Texture } from 'pixi.js';
import { findItem } from '../content/items';
import type { ContentRegistry } from '../content/Registry';
import { layoutRow } from '../content/types/spriteLayout';
import { armorSheetSrc } from '../game/equipment';
import type { PixelCanvas } from './PixelCanvas';
import { cropToContent, drawAmmoBox, drawConsumable, drawUnknown } from './placeholder/items';
import { generateWeaponArt } from './placeholder/weapons';
import type { SpriteSheetCache } from './SpriteSheets';

/**
 * Icons for every item, built from the same art the game draws: weapons from
 * their held sprite, armor cropped from its paper-doll sheet (so dye colors
 * match), plus generated ammo boxes and supplies. Cached per item id; each icon
 * is available as pixels, a data URL (for the DOM) and a Pixi texture (for the
 * ground).
 */
export class ItemIcons {
  private pixels = new Map<string, PixelCanvas>();
  private urls = new Map<string, string>();
  private textures = new Map<string, Texture>();

  constructor(
    private content: ContentRegistry,
    private sheets: SpriteSheetCache,
  ) {}

  /** Loads any art needed for these items' icons (armor sheets). */
  async prepare(defIds: Iterable<string>): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const id of new Set(defIds)) {
      const armor = this.content.tryGet('armor', id);
      if (armor) jobs.push(this.sheets.prepare(armorSheetSrc(this.content, armor), this.content.get('spriteLayout', armor.spriteLayout)));
    }
    await Promise.all(jobs);
  }

  /** Preparing every item at once is cheap (a few dozen tiny sheets). */
  async prepareAll(): Promise<void> {
    await this.prepare(['armor', 'weapon', 'ammo', 'consumable'].flatMap((t) => this.content.ids(t as 'armor')));
  }

  get(defId: string): PixelCanvas {
    let pc = this.pixels.get(defId);
    if (!pc) {
      pc = this.build(defId);
      this.pixels.set(defId, pc);
    }
    return pc;
  }

  url(defId: string): string {
    let u = this.urls.get(defId);
    if (!u) {
      u = this.get(defId).toCanvas().toDataURL();
      this.urls.set(defId, u);
    }
    return u;
  }

  texture(defId: string): Texture {
    let t = this.textures.get(defId);
    if (!t) {
      t = Texture.from(this.get(defId).toCanvas(), true);
      this.textures.set(defId, t);
    }
    return t;
  }

  private build(defId: string): PixelCanvas {
    const info = findItem(this.content, defId);
    if (!info) return drawUnknown();
    switch (info.kind) {
      case 'weapon':
        return info.def.placeholder ? generateWeaponArt(info.def.placeholder.style).pixels : drawUnknown();
      case 'ammo':
        return drawAmmoBox(info.def.color);
      case 'consumable':
        return drawConsumable(info.def.icon, info.def.color);
      case 'armor': {
        const layout = this.content.get('spriteLayout', info.def.spriteLayout);
        try {
          const sheet = this.sheets.pixels(armorSheetSrc(this.content, info.def), layout, { secondary: info.def.dye });
          const row = Math.max(0, layoutRow(layout, layout.animations[0]!.id, 'down'));
          return cropToContent(sheet, 0, row * layout.frameSize, layout.frameSize, layout.frameSize);
        } catch {
          return drawUnknown();
        }
      }
    }
  }
}
