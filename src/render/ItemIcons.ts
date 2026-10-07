import { Texture } from 'pixi.js';
import { findItem } from '../content/items';
import type { ContentRegistry } from '../content/Registry';
import { armorSheetSrc } from '../game/equipment';
import { PixelCanvas } from './PixelCanvas';
import { composePuppet, restState, solvePose } from './puppet';
import { cropToContent, drawAmmoBox, drawArtifact, drawConsumable, drawDetector, drawExplosive, drawKeycard, drawUnknown } from './placeholder/items';
import { generateWeaponArt } from './placeholder/weapons';
import type { SpriteSheetCache } from './SpriteSheets';

/**
 * Icons for every item, built from the same art the game draws: weapons from
 * their held sprite, armor posed on its body's rig (so dye colors
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
    await this.prepare(['armor', 'weapon', 'ammo', 'consumable', 'artifact', 'detector', 'keycard', 'explosive'].flatMap((t) => this.content.ids(t as 'armor')));
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
      case 'artifact':
        return drawArtifact(info.def.art.shape, info.def.art.color, info.def.art.glow);
      case 'detector':
        return drawDetector(info.def.color);
      case 'keycard':
        return drawKeycard(info.def.color);
      case 'explosive':
        return drawExplosive(info.def.art.style, info.def.art.color);
      case 'armor': {
        const layout = this.content.get('spriteLayout', info.def.spriteLayout);
        try {
          // Pose the armor alone on the body it was made for, standing, facing the camera.
          const body = this.content.all('race').find((r) => r.armorTag === info.def.fitsRace);
          const rig = body && this.sheets.rig(body.sheet);
          if (!rig) return drawUnknown();
          const atlas = this.sheets.pixels(armorSheetSrc(this.content, info.def), layout, { secondary: info.def.dye });
          const out = new PixelCanvas(64, 64);
          composePuppet({ rig, atlases: [atlas] }, solvePose(rig, restState('down')), out, 32, 60);
          return cropToContent(out, 0, 0, 64, 64);
        } catch {
          return drawUnknown();
        }
      }
    }
  }
}
