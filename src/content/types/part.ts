import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    part: PartDef;
  }
}

export const PART_ART = ['tail', 'claw', 'eye', 'hide', 'gland', 'tooth', 'spine', 'mandible', 'tentacle', 'hoof', 'chitin', 'heart'] as const;

/**
 * Something harvested from a dead creature (a hound's tail, an acid gland):
 * proof of the kill and a trade good. Carried like any item; worth `value`.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  maxStack: v.optional(v.number({ int: true, min: 1 }), 5),
  art: v.object({ shape: v.literal(...PART_ART), color: v.color(), accent: v.optional(v.color()) }),
});

export type PartDef = Infer<typeof schema>;

export const partType: ContentTypeSpec<'part'> = {
  type: 'part',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'part', ctx);
  },
};
