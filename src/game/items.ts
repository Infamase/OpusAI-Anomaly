import { findItem, maxStack, type ItemInfo } from '../content/items';
import type { ContentRegistry } from '../content/Registry';
import type { ItemInstance } from '../save/types';

/**
 * Item instances and inventory lists. An inventory is a plain array of
 * ItemInstance (what saves store). These helpers keep stacks tidy: stackable
 * items (ammo) merge up to their max stack, everything else is one per entry.
 */

/**
 * Unique item id. Uses getRandomValues (not randomUUID) because randomUUID is
 * missing on plain-http pages, e.g. when testing from another PC on the LAN.
 */
export function newItemUid(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Date.now().toString(36) + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createItem(defId: string, count = 1): ItemInstance {
  const item: ItemInstance = { uid: newItemUid(), defId, condition: 1 };
  if (count !== 1) item.count = count;
  return item;
}

/** A weapon with a full magazine of its default ammo. */
export function createLoadedWeapon(content: ContentRegistry, defId: string): ItemInstance {
  const def = content.get('weapon', defId);
  return { ...createItem(defId), loaded: def.magazine, loadedAmmo: def.ammo[0] };
}

export const countOf = (item: ItemInstance): number => item.count ?? 1;

export function itemInfo(content: ContentRegistry, item: ItemInstance): ItemInfo | undefined {
  return findItem(content, item.defId);
}

/** Total of one item id across the inventory. */
export function countItem(inv: readonly ItemInstance[], defId: string): number {
  let n = 0;
  for (const it of inv) if (it.defId === defId) n += countOf(it);
  return n;
}

/** Adds an item, topping up existing stacks first. Mutates `inv`. */
export function addItem(content: ContentRegistry, inv: ItemInstance[], item: ItemInstance): void {
  const info = findItem(content, item.defId);
  const max = info ? maxStack(info) : 1;
  let left = countOf(item);
  if (max > 1) {
    for (const it of inv) {
      if (it.defId !== item.defId || countOf(it) >= max) continue;
      const take = Math.min(max - countOf(it), left);
      it.count = countOf(it) + take;
      left -= take;
      if (left === 0) return;
    }
  }
  // Remaining amount becomes new stacks (the original instance keeps its uid for the first one).
  let first = true;
  while (left > 0) {
    const n = Math.min(left, max);
    const stack: ItemInstance = first ? { ...item } : createItem(item.defId);
    if (n === 1) delete stack.count;
    else stack.count = n;
    inv.push(stack);
    left -= n;
    first = false;
  }
}

/** Removes up to `amount` of an item id (smallest stacks first). Returns how many were removed. */
export function takeItem(inv: ItemInstance[], defId: string, amount: number): number {
  let taken = 0;
  const stacks = inv.filter((it) => it.defId === defId).sort((a, b) => countOf(a) - countOf(b));
  for (const s of stacks) {
    if (taken >= amount) break;
    const take = Math.min(countOf(s), amount - taken);
    taken += take;
    const left = countOf(s) - take;
    if (left <= 0) inv.splice(inv.indexOf(s), 1);
    else s.count = left;
  }
  return taken;
}

/** Removes one specific instance (by uid). */
export function removeInstance(inv: ItemInstance[], uid: string): ItemInstance | undefined {
  const i = inv.findIndex((it) => it.uid === uid);
  return i < 0 ? undefined : inv.splice(i, 1)[0];
}

/** Carried weight in kg (ammo weight is per round). */
export function inventoryWeight(content: ContentRegistry, items: Iterable<ItemInstance>): number {
  let kg = 0;
  for (const it of items) {
    const info = findItem(content, it.defId);
    if (info) kg += info.def.weight * countOf(it);
  }
  return kg;
}
