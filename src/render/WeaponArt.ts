import { Texture } from 'pixi.js';
import type { WeaponDef } from '../content/types';
import type { PixelCanvas } from './PixelCanvas';
import { generateWeaponArt } from './placeholder/weapons';

export interface WeaponVisual {
  texture: Texture;
  pixels: PixelCanvas | null;
  grip: [number, number];
  muzzle: [number, number];
}

/** Held-weapon textures, from placeholder art or a PNG (`sprite.src`). Cached per weapon. */
export class WeaponArtCache {
  private cache = new Map<string, WeaponVisual>();

  async prepare(def: WeaponDef): Promise<void> {
    if (this.cache.has(def.id)) return;
    if (def.sprite) {
      const img = new Image();
      img.src = def.sprite.src;
      await img.decode();
      this.cache.set(def.id, { texture: Texture.from(img, true), pixels: null, grip: def.sprite.grip, muzzle: def.sprite.muzzle });
      return;
    }
    const art = generateWeaponArt(def.placeholder!.style);
    this.cache.set(def.id, { texture: Texture.from(art.pixels.toCanvas(), true), pixels: art.pixels, grip: art.grip, muzzle: art.muzzle });
  }

  get(id: string): WeaponVisual | undefined {
    return this.cache.get(id);
  }
}
