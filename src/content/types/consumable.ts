import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';
import { checkSoundRefs, soundRefs } from './sound';

declare module '../Registry' {
  interface ContentMap {
    consumable: ConsumableDef;
  }
}

export const CONSUMABLE_ICONS = ['bandage', 'medkit', 'injector', 'food', 'drink', 'pills', 'bottle'] as const;

/** Single-use items: medical supplies, food, stims. */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  category: v.literal('medical', 'food'),
  weight: v.number({ min: 0 }),
  value: v.number({ min: 0 }),
  maxStack: v.optional(v.number({ int: true, min: 1 }), 10),
  effects: v.object({
    /** Instant hit points. */
    heal: v.optional(v.number({ min: 0 }), 0),
    /** Hit points restored gradually. */
    healOverTime: v.optional(v.object({ amount: v.number({ min: 0 }), seconds: v.number({ min: 0.1 }) })),
    /** Reduces bleeding by this many hp/s. */
    stopBleed: v.optional(v.number({ min: 0 }), 0),
    stamina: v.optional(v.number({ min: 0 }), 0),
    /** Radiation dose flushed out. */
    antiRad: v.optional(v.number({ min: 0 }), 0),
  }),
  icon: v.literal(...CONSUMABLE_ICONS),
  color: v.optional(v.color(), '#c8c0a8'),
  /** Played when used (otherwise the use_item cue). */
  sounds: soundRefs('use'),
});

export type ConsumableDef = Infer<typeof schema>;

export const consumableType: ContentTypeSpec<'consumable'> = {
  type: 'consumable',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'consumable', ctx);
    checkSoundRefs(def.sounds, ctx);
  },
};
