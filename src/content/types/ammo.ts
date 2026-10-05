import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    ammo: AmmoDef;
  }
}

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  /** Short label shown on the HUD, e.g. "9×19". */
  caliber: v.string({ nonEmpty: true }),
  /** Multiplies weapon damage (hollow points > 1, AP < 1). */
  damageMult: v.optional(v.number({ min: 0 }), 1),
  /** Added to the weapon's armor piercing. */
  apBonus: v.optional(v.number({ min: -1, max: 1 }), 0),
  /** Per round. */
  weight: v.number({ min: 0 }),
  value: v.number({ min: 0 }),
  /** Rounds per inventory stack. */
  maxStack: v.optional(v.number({ int: true, min: 1 }), 60),
  /** Color of the generated box icon. */
  color: v.optional(v.color(), '#8a7a4a'),
});

export type AmmoDef = Infer<typeof schema>;

export const ammoType: ContentTypeSpec<'ammo'> = {
  type: 'ammo',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'ammo', ctx);
  },
};
