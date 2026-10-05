import type { ContentRegistry } from '../content/Registry';
import { layoutRow } from '../content/types/spriteLayout';
import { armorSheetSrc, ARMOR_SLOTS } from '../game/equipment';
import { resolveColors } from '../game/characters';
import type { ChannelColors } from '../render/palette';
import { PixelCanvas } from '../render/PixelCanvas';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave } from '../save/types';

/**
 * Still image of a character (idle, facing the camera) with its armor layered
 * on top, as a canvas for DOM menus. Art must be prepared first
 * (prepareCharacterArt). Scale it with CSS; `image-rendering: pixelated` keeps it crisp.
 */
export function drawPortrait(
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  raceId: string,
  colors: ChannelColors,
  equipment: EquipmentSave,
): HTMLCanvasElement {
  const race = content.get('race', raceId);
  const layout = content.get('spriteLayout', race.spriteLayout);
  const size = layout.frameSize;
  const row = Math.max(0, layoutRow(layout, layout.animations[0]!.id, 'down'));
  const layers = [sheets.pixels(race.sheet, layout, resolveColors(race, colors))];
  for (const slot of ARMOR_SLOTS) {
    const def = equipment[slot] && content.tryGet('armor', equipment[slot]!.defId);
    if (def) layers.push(sheets.pixels(armorSheetSrc(content, def), layout, { secondary: def.dye }));
  }
  const out = new PixelCanvas(size, size);
  for (const src of layers) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = src.alpha(x, row * size + y);
        if (a) out.set(x, y, src.get(x, row * size + y), a);
      }
    }
  }
  const canvas = out.toCanvas();
  canvas.className = 'portrait';
  return canvas;
}
