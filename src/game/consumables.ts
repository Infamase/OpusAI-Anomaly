import type { ContentRegistry } from '../content/Registry';
import type { Entity, World } from '../ecs/World';
import type { ItemInstance } from '../save/types';
import { Health, Inventory, Stamina, Stats } from './components';
import { countOf } from './items';

/**
 * Uses one of a consumable stack from the entity's inventory. Returns a short
 * message for the HUD, or null if it can't be used (unknown or not consumable).
 */
export function useConsumable(world: World, content: ContentRegistry, e: Entity, item: ItemInstance): string | null {
  const def = content.tryGet('consumable', item.defId);
  const health = world.get(e, Health);
  if (!def || !health || health.dead) return null;
  const fx = def.effects;
  const max = world.get(e, Stats)?.get('max_health') ?? 100;
  health.hp = Math.min(max, health.hp + fx.heal);
  if (fx.healOverTime) health.regen.push({ rate: fx.healOverTime.amount / fx.healOverTime.seconds, left: fx.healOverTime.seconds });
  if (fx.stopBleed) health.bleed = Math.max(0, health.bleed - fx.stopBleed);
  if (fx.antiRad) health.rads = Math.max(0, health.rads - fx.antiRad);
  if (fx.rads) health.rads += fx.rads;
  const stamina = world.get(e, Stamina);
  if (fx.stamina && stamina) {
    stamina.current = Math.min(world.get(e, Stats)?.get('max_stamina') ?? 100, stamina.current + fx.stamina);
    stamina.exhausted = false;
  }
  // Consume one from the stack.
  const inv = world.get(e, Inventory);
  if (inv) {
    const left = countOf(item) - 1;
    if (left <= 0) {
      const i = inv.indexOf(item);
      if (i >= 0) inv.splice(i, 1);
    } else {
      item.count = left;
    }
  }
  return `Used ${def.name}`;
}

/**
 * Picks the most sensible medical item for the situation (quick-heal key):
 * a bandage when bleeding and not badly hurt, otherwise the strongest medkit,
 * otherwise anything that heals.
 */
export function pickQuickHeal(content: ContentRegistry, inv: ItemInstance[], hpFrac: number, bleed: number): ItemInstance | null {
  const meds = inv
    .map((item) => ({ item, def: content.tryGet('consumable', item.defId) }))
    .filter((m) => m.def && m.def.category === 'medical');
  const total = (m: (typeof meds)[number]) => m.def!.effects.heal + (m.def!.effects.healOverTime?.amount ?? 0);
  if (bleed > 0.3 && hpFrac > 0.5) {
    const bandage = meds.filter((m) => m.def!.effects.stopBleed > 0).sort((a, b) => total(a) - total(b))[0];
    if (bandage) return bandage.item;
  }
  if (hpFrac >= 0.98 && bleed <= 0.05) return null;
  const best = meds.filter((m) => total(m) > 0).sort((a, b) => total(b) - total(a))[0];
  return best?.item ?? null;
}
