import type { Rng } from '../core/rng';
import type { ContentRegistry } from '../content/Registry';
import type { ItemInstance } from '../save/types';
import { addItem, createItem } from './items';

/** Rolls a loot table into item stacks. Deterministic for a given Rng. */
export function rollLoot(content: ContentRegistry, tableId: string, rng: Rng): ItemInstance[] {
  const table = content.get('lootTable', tableId);
  const out: ItemInstance[] = [];
  for (let r = 0; r < table.rolls; r++) {
    for (const entry of table.entries) {
      if (!rng.chance(entry.chance)) continue;
      const n = rng.int(entry.count[0], entry.count[1]);
      const condition = Math.round(rng.range(entry.condition[0], entry.condition[1]) * 100) / 100;
      const weapon = content.tryGet('weapon', entry.item);
      if (weapon) {
        for (let i = 0; i < n; i++) {
          const loaded = rng.int(0, weapon.magazine);
          out.push({ ...createItem(entry.item), condition, loaded, loadedAmmo: weapon.ammo[0] });
        }
      } else if (content.has('armor', entry.item)) {
        for (let i = 0; i < n; i++) out.push({ ...createItem(entry.item), condition });
      } else {
        addItem(content, out, createItem(entry.item, n));
      }
    }
  }
  return out;
}
