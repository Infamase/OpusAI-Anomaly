import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { isItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    lootTable: LootTableDef;
  }
}

/**
 * What a crate or body can contain. Each entry is rolled independently
 * (`chance`), then `count` picks a stack size. `rolls` repeats the whole table.
 */
const schema = v.object({
  id: v.id(),
  rolls: v.optional(v.number({ int: true, min: 1 }), 1),
  entries: v.array(
    v.object({
      item: v.id(),
      chance: v.number({ min: 0, max: 1 }),
      count: v.optional(v.tuple2(v.number({ int: true, min: 1 }), v.number({ int: true, min: 1 })), [1, 1] as [number, number]),
      /** Condition range for weapons and armor. */
      condition: v.optional(v.tuple2(v.number({ min: 0, max: 1 }), v.number({ min: 0, max: 1 })), [1, 1] as [number, number]),
    }),
    { min: 1 },
  ),
});

export type LootTableDef = Infer<typeof schema>;

export const lootTableType: ContentTypeSpec<'lootTable'> = {
  type: 'lootTable',
  schema,
  crossCheck(def, ctx) {
    def.entries.forEach((e, i) => {
      if (!isItemId(ctx.registry, e.item)) ctx.error(`entries[${i}].item "${e.item}" is not an item`);
      if (e.count[0] > e.count[1]) ctx.error(`entries[${i}].count min > max`);
    });
  },
};
