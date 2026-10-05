import type { ContentRegistry } from '../content/Registry';
import { armorSheetSrc, ARMOR_SLOTS } from '../game/equipment';
import { resolveColors } from '../game/characters';
import type { ChannelColors } from '../render/palette';
import { PixelCanvas } from '../render/PixelCanvas';
import { composePuppet, restState, solvePose } from '../render/puppet';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave } from '../save/types';

/**
 * Still image of a character (standing, facing the camera) with its armor layered
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
  const rig = sheets.rig(race.sheet);
  const atlases = [sheets.pixels(race.sheet, layout, resolveColors(race, colors))];
  for (const slot of ARMOR_SLOTS) {
    const def = equipment[slot] && content.tryGet('armor', equipment[slot]!.defId);
    if (def) atlases.push(sheets.pixels(armorSheetSrc(content, def), layout, { secondary: def.dye }));
  }
  const out = new PixelCanvas(64, 64);
  if (rig) composePuppet({ rig, atlases }, solvePose(rig, restState('down')), out, 32, 60);
  const canvas = out.toCanvas();
  canvas.className = 'portrait';
  return canvas;
}
