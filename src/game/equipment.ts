import type { ContentRegistry } from '../content/Registry';
import type { ArmorDef } from '../content/types';
import type { Entity, World } from '../ecs/World';
import { ARMOR_SLOTS, type ArmorSlot } from '../render/placeholder/armor';
import { placeholderArmorSrc, type SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave, ItemInstance } from '../save/types';
import type { StatBlock, StatModifier } from '../stats/Stats';
import { Character, Equipment, Stats, View } from './components';

export { ARMOR_SLOTS, type ArmorSlot };

/**
 * Unique item id. Uses getRandomValues (not randomUUID) because randomUUID is
 * missing on plain-http pages, e.g. when testing an iPad against a LAN dev server.
 */
export function newItemUid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Date.now().toString(36) + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createItem(defId: string): ItemInstance {
  return { uid: newItemUid(), defId, condition: 1 };
}

export const itemSource = (item: ItemInstance): string => `item:${item.uid}`;

/** Why `raceId` can't wear `armor`, or null if it can. */
export function fitProblem(content: ContentRegistry, raceId: string, armor: ArmorDef): string | null {
  const race = content.get('race', raceId);
  if (armor.fitsRace !== race.armorTag) {
    const fits = content.all('race').find((r) => r.armorTag === armor.fitsRace)?.name ?? armor.fitsRace;
    return `${armor.name} is made for ${fits} bodies, not ${race.name}.`;
  }
  return null;
}

/** Every armor piece a race can wear in a slot. */
export function armorFor(content: ContentRegistry, raceId: string, slot: ArmorSlot): ArmorDef[] {
  const tag = content.get('race', raceId).armorTag;
  return content.all('armor').filter((a) => a.slot === slot && a.fitsRace === tag);
}

/** Sprite sheet id for an armor piece: its PNG, or placeholder art fitted to a placeholder body. */
export function armorSheetSrc(content: ContentRegistry, armor: ArmorDef): string {
  if (armor.sheet) return armor.sheet;
  const body = content
    .all('race')
    .find((r) => r.armorTag === armor.fitsRace && r.sheet.startsWith('placeholder:') && !r.sheet.startsWith('placeholder:armor:'));
  if (!body || !armor.placeholder) throw new Error(`No art for armor "${armor.id}"`);
  return placeholderArmorSrc(body.sheet.slice('placeholder:'.length), armor.slot, armor.placeholder.style);
}

export function armorModifiers(item: ItemInstance, armor: ArmorDef): StatModifier[] {
  return armor.modifiers.map((m) => ({ ...m, source: itemSource(item) }));
}

/** Adds the modifiers of every recognised worn item to a stat block. */
export function applyEquipmentStats(stats: StatBlock, content: ContentRegistry, equipment: EquipmentSave): void {
  for (const slot of ARMOR_SLOTS) {
    const item = equipment[slot];
    const def = item && content.tryGet('armor', item.defId);
    if (item && def) stats.addModifiers(armorModifiers(item, def));
  }
}

/** Loads art for every worn piece. Must finish before the pieces are drawn. */
export async function prepareEquipmentArt(content: ContentRegistry, sheets: SpriteSheetCache, equipment: EquipmentSave): Promise<void> {
  await Promise.all(
    ARMOR_SLOTS.map((slot) => {
      const def = equipment[slot] && content.tryGet('armor', equipment[slot]!.defId);
      return def ? sheets.prepare(armorSheetSrc(content, def), content.get('spriteLayout', def.spriteLayout)) : undefined;
    }),
  );
}

export async function prepareArmorArt(content: ContentRegistry, sheets: SpriteSheetCache, armorId: string): Promise<void> {
  const def = content.get('armor', armorId);
  await sheets.prepare(armorSheetSrc(content, def), content.get('spriteLayout', def.spriteLayout));
}

/** Fresh starting kit for a new character of `raceId`. */
export function startingEquipment(content: ContentRegistry, raceId: string): EquipmentSave {
  const out: EquipmentSave = {};
  for (const id of content.get('race', raceId).startingEquipment) out[content.get('armor', id).slot] = createItem(id);
  return out;
}

/** Points each paper-doll armor layer at the right sheet (or clears it). */
export function refreshArmorLayers(world: World, content: ContentRegistry, sheets: SpriteSheetCache, e: Entity): void {
  const view = world.get(e, View);
  const eq = world.get(e, Equipment);
  if (!view || !eq) return;
  for (const slot of ARMOR_SLOTS) {
    const def = eq[slot] && content.tryGet('armor', eq[slot]!.defId);
    view.setLayer(
      slot,
      def ? sheets.get(armorSheetSrc(content, def), content.get('spriteLayout', def.spriteLayout), { secondary: def.dye }) : null,
    );
  }
}

export type EquipResult = { ok: true; replaced?: ItemInstance } | { ok: false; reason: string };

/** Wears an item, swapping out whatever was in its slot. Art must already be prepared. */
export function equipArmor(world: World, content: ContentRegistry, sheets: SpriteSheetCache, e: Entity, item: ItemInstance): EquipResult {
  const def = content.tryGet('armor', item.defId);
  if (!def) return { ok: false, reason: `Unknown armor "${item.defId}".` };
  const problem = fitProblem(content, world.req(e, Character).raceId, def);
  if (problem) return { ok: false, reason: problem };
  const eq = world.req(e, Equipment);
  const stats = world.req(e, Stats);
  const replaced = eq[def.slot];
  if (replaced) stats.removeSource(itemSource(replaced));
  eq[def.slot] = item;
  stats.addModifiers(armorModifiers(item, def));
  refreshArmorLayers(world, content, sheets, e);
  return { ok: true, replaced };
}

export function unequipArmor(world: World, content: ContentRegistry, sheets: SpriteSheetCache, e: Entity, slot: ArmorSlot): ItemInstance | undefined {
  const eq = world.req(e, Equipment);
  const item = eq[slot];
  if (!item) return undefined;
  world.req(e, Stats).removeSource(itemSource(item));
  delete eq[slot];
  refreshArmorLayers(world, content, sheets, e);
  return item;
}
