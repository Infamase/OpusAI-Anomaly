import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { ALL_ARMOR_STYLES, ARMOR_SLOTS, isArmorStyleForSlot } from '../../render/placeholder/armor';

declare module '../Registry' {
  interface ContentMap {
    armor: ArmorDef;
  }
}

const modifier = v.object({
  stat: v.id(),
  op: v.literal('flat', 'percent', 'mult'),
  value: v.number(),
});

/**
 * One wearable armor piece. Each race needs its own pieces (different bodies),
 * matched through the race's armorTag. Art is either a PNG sheet using the
 * race's sprite layout, or generated placeholder art from `placeholder.style`.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  slot: v.literal(...ARMOR_SLOTS),
  /** Must equal a race's armorTag to be wearable by that race. */
  fitsRace: v.id(),
  spriteLayout: v.optional(v.id(), 'humanoid48'),
  /** PNG under public/ (same layout as the body). Omit to use placeholder art. */
  sheet: v.optional(v.string({ nonEmpty: true })),
  placeholder: v.optional(v.object({ style: v.literal(...ALL_ARMOR_STYLES) })),
  /** Color applied to the secondary key-color regions of the art. */
  dye: v.optional(v.color(), '#5d6340'),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  /** Stat changes while worn (e.g. +0.2 ballistic_resist, -0.05 move_speed percent). */
  modifiers: v.optional(v.array(modifier), []),
});

export type ArmorDef = Infer<typeof schema>;

export const armorType: ContentTypeSpec<'armor'> = {
  type: 'armor',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('spriteLayout', def.spriteLayout, 'spriteLayout');
    def.modifiers.forEach((m, i) => ctx.ref('stat', m.stat, `modifiers[${i}].stat`));
    if (!ctx.registry.all('race').some((r) => r.armorTag === def.fitsRace)) {
      ctx.error(`fitsRace "${def.fitsRace}" matches no race's armorTag`);
    }
    if (!def.sheet && !def.placeholder) ctx.error('needs either "sheet" or "placeholder"');
    if (def.placeholder && !isArmorStyleForSlot(def.slot, def.placeholder.style)) {
      ctx.error(`placeholder style "${def.placeholder.style}" is not a ${def.slot} style`);
    }
  },
};
