import type { ContentRegistry, CrossCheckContext } from './Registry';
import type { AmmoDef, ArmorDef, ArtifactDef, ConsumableDef, DetectorDef, WeaponDef } from './types';

/**
 * Content types that are carryable items. They share one id namespace, so an
 * item in an inventory or save is just its id. Add new item kinds (consumables,
 * artifacts, junk...) here.
 */
export const ITEM_CONTENT_TYPES = ['armor', 'weapon', 'ammo', 'consumable', 'artifact', 'detector'] as const;
export type ItemKind = (typeof ITEM_CONTENT_TYPES)[number];

export type ItemInfo =
  | { kind: 'armor'; def: ArmorDef }
  | { kind: 'weapon'; def: WeaponDef }
  | { kind: 'ammo'; def: AmmoDef }
  | { kind: 'consumable'; def: ConsumableDef }
  | { kind: 'artifact'; def: ArtifactDef }
  | { kind: 'detector'; def: DetectorDef };

/** Looks an item up by id across every item content type. */
export function findItem(content: ContentRegistry, id: string): ItemInfo | undefined {
  for (const kind of ITEM_CONTENT_TYPES) {
    const def = content.tryGet(kind, id);
    if (def) return { kind, def } as ItemInfo;
  }
  return undefined;
}

/** How many of this item fit in one inventory stack. */
export function maxStack(info: ItemInfo): number {
  return info.kind === 'ammo' || info.kind === 'consumable' ? info.def.maxStack : 1;
}

/** crossCheck helper: reports an id used by two different item types. */
export function checkUniqueItemId(id: string, ownKind: ItemKind, ctx: CrossCheckContext): void {
  for (const kind of ITEM_CONTENT_TYPES) {
    if (kind !== ownKind && ctx.registry.has(kind, id)) ctx.error(`item id "${id}" is also used by a ${kind}`);
  }
}

export function isItemId(content: ContentRegistry, id: string): boolean {
  return findItem(content, id) !== undefined;
}
