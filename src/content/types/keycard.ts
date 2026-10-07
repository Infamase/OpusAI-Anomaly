import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    keycard: KeycardDef;
  }
}

/**
 * A keycard: opens every locked door whose tile names it (`door.key`). It is
 * never used up; carrying it is enough.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  weight: v.optional(v.number({ min: 0 }), 0.02),
  value: v.optional(v.number({ int: true, min: 0 }), 50),
  /** Card color (icon), usually matching the light on the doors it opens. */
  color: v.color(),
});

export type KeycardDef = Infer<typeof schema>;

export const keycardType: ContentTypeSpec<'keycard'> = {
  type: 'keycard',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'keycard', ctx);
  },
};
