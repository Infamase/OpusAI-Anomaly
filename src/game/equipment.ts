import type { ContentRegistry } from '../content/Registry';
import type { ArmorDef } from '../content/types';
import { WEAPON_SLOTS, type WeaponSlot } from '../content/types/weapon';
import type { Entity, World } from '../ecs/World';
import { ARMOR_SLOTS, type ArmorSlot } from '../render/placeholder/armor';
import { placeholderArmorSrc, type SpriteSheetCache } from '../render/SpriteSheets';
import type { BeltSlotId, EquipmentSave, ItemInstance } from '../save/types';
import type { ArtifactDef } from '../content/types';
import type { StatBlock, StatModifier } from '../stats/Stats';
import { Character, Equipment, Stats, View } from './components';
import { addItem, createItem, createLoadedWeapon } from './items';

export { ARMOR_SLOTS, WEAPON_SLOTS, createItem, type ArmorSlot, type WeaponSlot };

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

/** Protection left at a given condition: worn-out armor still gives 30%. */
export const conditionFactor = (condition: number): number => 0.3 + 0.7 * Math.max(0, Math.min(1, condition));

/** The item's stat modifiers; stats flagged scalesWithCondition shrink as the armor wears. */
export function armorModifiers(content: ContentRegistry, item: ItemInstance, armor: ArmorDef): StatModifier[] {
  return armor.modifiers.map((m) => {
    const scales = content.tryGet('stat', m.stat)?.scalesWithCondition && m.op === 'flat';
    return { ...m, value: scales ? m.value * conditionFactor(item.condition) : m.value, source: itemSource(item) };
  });
}

/** Artifact belt slots, in order. */
export const BELT_SLOTS = ['belt1', 'belt2', 'belt3'] as const satisfies readonly BeltSlotId[];
export const isBeltSlot = (slot: string): slot is BeltSlotId => (BELT_SLOTS as readonly string[]).includes(slot);

/** An artifact's stat modifiers (they don't wear out). */
export function artifactModifiers(item: ItemInstance, def: ArtifactDef): StatModifier[] {
  return def.modifiers.map((m) => ({ ...m, source: itemSource(item) }));
}

/** Adds the modifiers of every recognised worn item to a stat block. */
export function applyEquipmentStats(stats: StatBlock, content: ContentRegistry, equipment: EquipmentSave): void {
  for (const slot of ARMOR_SLOTS) {
    const item = equipment[slot];
    const def = item && content.tryGet('armor', item.defId);
    if (item && def) stats.addModifiers(armorModifiers(content, item, def));
  }
  for (const slot of BELT_SLOTS) {
    const item = equipment[slot];
    const def = item && content.tryGet('artifact', item.defId);
    if (item && def) stats.addModifiers(artifactModifiers(item, def));
  }
}

/** Puts an artifact on the belt: in `slot`, else the first free slot, else swapping out the first. */
export function equipArtifact(world: World, content: ContentRegistry, e: Entity, item: ItemInstance, slot?: BeltSlotId): EquipResult {
  const def = content.tryGet('artifact', item.defId);
  if (!def) return { ok: false, reason: `Unknown artifact "${item.defId}".` };
  const eq = world.req(e, Equipment);
  const stats = world.req(e, Stats);
  const target = slot ?? BELT_SLOTS.find((s) => !eq[s]) ?? 'belt1';
  const replaced = eq[target];
  if (replaced) stats.removeSource(itemSource(replaced));
  eq[target] = item;
  stats.addModifiers(artifactModifiers(item, def));
  return { ok: true, replaced };
}

export function unequipArtifact(world: World, e: Entity, slot: BeltSlotId): ItemInstance | undefined {
  const eq = world.req(e, Equipment);
  const item = eq[slot];
  if (!item) return undefined;
  world.req(e, Stats).removeSource(itemSource(item));
  delete eq[slot];
  return item;
}

/** Re-applies one worn item's modifiers (after its condition changed). */
export function refreshItemStats(stats: StatBlock, content: ContentRegistry, item: ItemInstance): void {
  const def = content.tryGet('armor', item.defId);
  stats.removeSource(itemSource(item));
  if (def) stats.addModifiers(armorModifiers(content, item, def));
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

/** Fresh starting kit (armor + loaded weapons) for a new character of `raceId`. */
export function startingEquipment(content: ContentRegistry, raceId: string): EquipmentSave {
  const out: EquipmentSave = {};
  for (const id of content.get('race', raceId).startingEquipment) {
    const armor = content.tryGet('armor', id);
    if (armor) out[armor.slot] = createItem(id);
    else out[content.get('weapon', id).slot] = createLoadedWeapon(content, id);
  }
  return out;
}

/** Fresh starting inventory (ammo, supplies) for a new character of `raceId`. */
export function startingInventory(content: ContentRegistry, raceId: string): ItemInstance[] {
  const inv: ItemInstance[] = [];
  for (const { item, count } of content.get('race', raceId).startingInventory) {
    addItem(content, inv, content.has('weapon', item) ? createLoadedWeapon(content, item) : createItem(item, count));
  }
  return inv;
}

/** The weapon slot to hold by default: primary if there is one. */
export function defaultActiveWeapon(equipment: EquipmentSave): WeaponSlot | null {
  return equipment.primary ? 'primary' : equipment.sidearm ? 'sidearm' : null;
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
  stats.addModifiers(armorModifiers(content, item, def));
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

/** Puts a weapon in its slot (primary or sidearm). Returns whatever it replaced. */
export function equipWeapon(world: World, content: ContentRegistry, e: Entity, item: ItemInstance): EquipResult {
  const def = content.tryGet('weapon', item.defId);
  if (!def) return { ok: false, reason: `Unknown weapon "${item.defId}".` };
  const eq = world.req(e, Equipment);
  const replaced = eq[def.slot];
  eq[def.slot] = item;
  return { ok: true, replaced };
}

export function unequipWeapon(world: World, e: Entity, slot: WeaponSlot): ItemInstance | undefined {
  const eq = world.req(e, Equipment);
  const item = eq[slot];
  delete eq[slot];
  return item;
}
