import { findItem } from '../content/items';
import type { ContentRegistry } from '../content/Registry';
import type { Entity, World } from '../ecs/World';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { BeltSlotId, EquipmentSlot, ItemInstance } from '../save/types';
import { Character, Combatant, Equipment, Inventory } from './components';
import { useConsumable } from './consumables';
import { equipArmor, equipArtifact, equipWeapon, fitProblem, isBeltSlot, prepareArmorArt, unequipArmor, unequipArtifact, unequipWeapon } from './equipment';
import { addItem, createItem, removeInstance } from './items';

/**
 * Moving items between the backpack and equipment. Every function keeps the
 * item conserved: whatever an action displaces goes back into the backpack.
 * Returns an error message, or null on success.
 */

export async function equipFromInventory(
  world: World,
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  e: Entity,
  item: ItemInstance,
  /** For artifacts: which belt slot (default: the first free one). */
  beltSlot?: BeltSlotId,
): Promise<string | null> {
  const inv = world.req(e, Inventory);
  const info = findItem(content, item.defId);
  if (!info) return 'Unknown item.';
  if (info.kind === 'artifact') {
    removeInstance(inv, item.uid);
    const res = equipArtifact(world, content, e, item, beltSlot);
    if (!res.ok) {
      addItem(content, inv, item);
      return res.reason;
    }
    if (res.replaced) addItem(content, inv, res.replaced);
    return null;
  }
  if (info.kind === 'armor') {
    const problem = fitProblem(content, world.req(e, Character).raceId, info.def);
    if (problem) return problem;
    await prepareArmorArt(content, sheets, item.defId);
    removeInstance(inv, item.uid);
    const res = equipArmor(world, content, sheets, e, item);
    if (!res.ok) {
      addItem(content, inv, item);
      return res.reason;
    }
    if (res.replaced) addItem(content, inv, res.replaced);
    return null;
  }
  if (info.kind === 'weapon') {
    removeInstance(inv, item.uid);
    const res = equipWeapon(world, content, e, item);
    if (!res.ok) {
      addItem(content, inv, item);
      return res.reason;
    }
    if (res.replaced) addItem(content, inv, res.replaced);
    const c = world.get(e, Combatant);
    if (c) {
      if (c.active === info.def.slot || c.active === null) c.reloadLeft = 0;
      c.active ??= info.def.slot;
    }
    return null;
  }
  return `${info.def.name} can't be equipped.`;
}

export function unequipToInventory(world: World, content: ContentRegistry, sheets: SpriteSheetCache, e: Entity, slot: EquipmentSlot): void {
  const inv = world.req(e, Inventory);
  if (isBeltSlot(slot)) {
    const item = unequipArtifact(world, e, slot);
    if (item) addItem(content, inv, item);
    return;
  }
  if (slot === 'primary' || slot === 'sidearm') {
    const item = unequipWeapon(world, e, slot);
    if (!item) return;
    addItem(content, inv, item);
    const c = world.get(e, Combatant);
    if (c && c.active === slot) {
      c.reloadLeft = 0;
      const eq = world.req(e, Equipment);
      c.active = eq.primary ? 'primary' : eq.sidearm ? 'sidearm' : null;
    }
    return;
  }
  const item = unequipArmor(world, content, sheets, e, slot);
  if (item) addItem(content, inv, item);
}

/** Empties a weapon's magazine back into the backpack. Returns rounds removed. */
export function unloadWeapon(world: World, content: ContentRegistry, e: Entity, weapon: ItemInstance): number {
  const n = weapon.loaded ?? 0;
  if (n <= 0 || !weapon.loadedAmmo) return 0;
  addItem(content, world.req(e, Inventory), createItem(weapon.loadedAmmo, n));
  weapon.loaded = 0;
  return n;
}

export function useFromInventory(world: World, content: ContentRegistry, e: Entity, item: ItemInstance): string | null {
  return useConsumable(world, content, e, item) ? null : "That can't be used.";
}

/** Which equipment slot an item would go into, if any. */
export function slotFor(content: ContentRegistry, defId: string): EquipmentSlot | null {
  const info = findItem(content, defId);
  if (info?.kind === 'armor') return info.def.slot;
  if (info?.kind === 'weapon') return info.def.slot;
  if (info?.kind === 'artifact') return 'belt1';
  return null;
}
