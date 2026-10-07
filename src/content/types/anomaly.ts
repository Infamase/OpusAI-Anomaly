import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkSoundRefs, soundRefs } from './sound';
import { DAMAGE_TYPES, resistStat } from './weapon';

declare module '../Registry' {
  interface ContentMap {
    anomaly: AnomalyDef;
  }
}

/** How an anomaly looks and sounds; behavior comes from the numbers below. */
export const ANOMALY_STYLES = ['burner', 'electro', 'vortex', 'acid', 'radiation'] as const;
export type AnomalyStyle = (typeof ANOMALY_STYLES)[number];

/**
 * A hazard fixed in place. It can go off when something living (or a thrown
 * bolt) comes close (`burst`), drag things toward its center (`pull`), hurt
 * whoever stands in it (`dot`) and irradiate them (`radiation`). Combine them
 * freely: a vortex is pull + a burst with knockback; a burner is a burst.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  style: v.literal(...ANOMALY_STYLES),
  /** Damage type for burst and dot (each reduced by the matching resistance). */
  damageType: v.literal(...DAMAGE_TYPES),
  /** Reach, in tiles. */
  radius: v.number({ min: 0.3, max: 8 }),
  burst: v.optional(
    v.object({
      damage: v.number({ min: 0 }),
      /** Delay between the trigger and the blast: the moment to jump back. */
      windup: v.optional(v.number({ min: 0 }), 0.35),
      /** Rest before it can go off again. */
      cooldown: v.optional(v.number({ min: 0.1 }), 2),
      /** Push away from the center, px. Negative pulls in. */
      knockback: v.optional(v.number(), 0),
    }),
  ),
  /** Drag toward the center, px/s (strongest at the center). */
  pull: v.optional(v.number({ min: 0 }), 0),
  /** Damage per second while inside. */
  dot: v.optional(v.number({ min: 0 }), 0),
  /** Radiation dose per second at the center (fades toward the edge). */
  radiation: v.optional(v.number({ min: 0 }), 0),
  /** How visible it is when idle, 0 (invisible) .. 1. */
  visibility: v.optional(v.number({ min: 0, max: 1 }), 0.5),
  /** Effect tint. */
  color: v.color(),
  /** It glows in the dark (a burner's embers, an electro's sparks): color, strength, flicker. Reach is 1.6× its radius. */
  light: v.optional(v.object({ color: v.color(), intensity: v.optional(v.number({ min: 0, max: 2 }), 0.7), flicker: v.optional(v.number({ min: 0, max: 1 }), 0.3) })),
  sounds: soundRefs('idle', 'trigger'),
});

export type AnomalyDef = Infer<typeof schema>;

export const anomalyType: ContentTypeSpec<'anomaly'> = {
  type: 'anomaly',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('stat', resistStat(def.damageType), 'damageType (its resist stat)');
    checkSoundRefs(def.sounds, ctx);
    if (!def.burst && !def.pull && !def.dot && !def.radiation) ctx.error('does nothing: give it a burst, pull, dot or radiation');
  },
};
