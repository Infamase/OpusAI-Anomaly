import { Rectangle, Texture } from 'pixi.js';
import type { SpriteLayoutDef } from '../content/types';
import { layoutRow, layoutSheetSize } from '../content/types/spriteLayout';
import { buildSwapMap, recolorPixels, swapCacheKey, type ChannelColors } from './palette';
import { PixelCanvas } from './PixelCanvas';
import type { PuppetRig } from './puppet';
import { generateArmorAtlas, isArmorStyleForSlot, type ArmorSlot } from './placeholder/armor';
import { generatePuppetAtlas, isPlaceholderRace, placeholderRig } from './placeholder/characters';

/** A sliced, recolored sheet ready to draw. */
export class SpriteSheet {
  constructor(
    readonly layout: SpriteLayoutDef,
    private frames: Texture[][],
  ) {}

  /** Texture for an animation frame; falls back to the first animation if `anim` is missing. */
  frame(anim: string, dir: string, index: number): Texture {
    let row = layoutRow(this.layout, anim, dir);
    let count = this.layout.animations.find((a) => a.id === anim)?.frames ?? 0;
    if (row < 0) {
      row = layoutRow(this.layout, this.layout.animations[0]!.id, dir);
      count = this.layout.animations[0]!.frames;
    }
    return this.frames[Math.max(0, row)]![index % Math.max(1, count)]!;
  }
}

/**
 * Loads sprite sheets (generated placeholders or PNGs from public/), applies
 * palette swaps, and caches the result per (sheet, colors). Body sheets and armor
 * sheets go through the same path, so paper-doll layers share one pipeline.
 */
export class SpriteSheetCache {
  private sources = new Map<string, PixelCanvas>();
  private sheets = new Map<string, SpriteSheet>();
  private recolored = new Map<string, PixelCanvas>();
  private rigs = new Map<string, PuppetRig>();

  /** Loads a sheet's pixels. Must be awaited before get() for PNG sheets. */
  async prepare(src: string, layout: SpriteLayoutDef): Promise<void> {
    const key = `${src}@${layout.id}`;
    if (this.sources.has(key)) return;
    this.sources.set(key, await loadPixels(src, layout));
  }

  /** Recolored pixels of a prepared sheet (for DOM portraits). Cached. */
  pixels(src: string, layout: SpriteLayoutDef, colors: ChannelColors): PixelCanvas {
    const key = swapCacheKey(`${src}@${layout.id}`, colors);
    const cached = this.recolored.get(key);
    if (cached) return cached;
    const pixels = this.sources.get(`${src}@${layout.id}`);
    if (!pixels) throw new Error(`Sprite sheet "${src}" was not prepared`);
    const copy = new PixelCanvas(pixels.width, pixels.height);
    copy.data.set(pixels.data);
    recolorPixels(copy.data, buildSwapMap(colors));
    this.recolored.set(key, copy);
    return copy;
  }

  get(src: string, layout: SpriteLayoutDef, colors: ChannelColors): SpriteSheet {
    const key = swapCacheKey(`${src}@${layout.id}`, colors);
    const cached = this.sheets.get(key);
    if (cached) return cached;
    const copy = this.pixels(src, layout, colors);
    const base = Texture.from(copy.toCanvas(), true);
    const size = layout.frameSize;
    const rows = layout.animations.length * layout.directions.length;
    const cols = Math.max(...layout.animations.map((a) => a.frames));
    const frames: Texture[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: Texture[] = [];
      for (let c = 0; c < cols; c++) row.push(new Texture({ source: base.source, frame: new Rectangle(c * size, r * size, size, size) }));
      frames.push(row);
    }
    // NOTE: no eviction yet. NPC generation (Phase 1) should draw colors from
    // race presets so the number of unique combinations stays bounded.
    const sheet = new SpriteSheet(layout, frames);
    this.sheets.set(key, sheet);
    return sheet;
  }

  /**
   * The cutout rig (joints and pivots) for a body sheet. Generated races
   * compute it; drawn PNG atlases will ship a rig JSON next to the image.
   */
  rig(src: string): PuppetRig | null {
    if (!src.startsWith('placeholder:') || src.startsWith('placeholder:armor:')) return null;
    const id = src.slice('placeholder:'.length);
    if (!isPlaceholderRace(id)) return null;
    let rig = this.rigs.get(id);
    if (!rig) {
      rig = placeholderRig(id);
      this.rigs.set(id, rig);
    }
    return rig;
  }

  get cachedCount(): number {
    return this.sheets.size;
  }
}

/** Placeholder armor art id: fitted to a placeholder body race, for one slot and style. */
export function placeholderArmorSrc(bodyRace: string, slot: ArmorSlot, style: string): string {
  return `placeholder:armor:${bodyRace}:${slot}:${style}`;
}

async function loadPixels(src: string, layout: SpriteLayoutDef): Promise<PixelCanvas> {
  if (src.startsWith('placeholder:armor:')) {
    const [race = '', slot = '', style = ''] = src.slice('placeholder:armor:'.length).split(':');
    if (!isPlaceholderRace(race) || !(slot === 'head' || slot === 'torso' || slot === 'legs') || !isArmorStyleForSlot(slot, style)) {
      throw new Error(`Bad placeholder armor sheet "${src}"`);
    }
    return generateArmorAtlas(race, slot, style);
  }
  if (src.startsWith('placeholder:')) {
    const id = src.slice('placeholder:'.length);
    if (!isPlaceholderRace(id)) throw new Error(`No placeholder generator for "${id}"`);
    return generatePuppetAtlas(id);
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to load sprite sheet ${src}: ${res.status}`);
  // Skip color management so key colors survive byte-exact for palette swapping.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const expected = layoutSheetSize(layout);
  if (bitmap.width < expected.width || bitmap.height < expected.height) {
    console.warn(`[sprites] ${src} is ${bitmap.width}x${bitmap.height}, layout "${layout.id}" expects ${expected.width}x${expected.height}`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const pc = new PixelCanvas(bitmap.width, bitmap.height);
  pc.data.set(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
  return pc;
}
