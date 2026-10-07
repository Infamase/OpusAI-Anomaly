import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';
import { checkSoundRefs, soundRefs } from './sound';
import { DAMAGE_TYPES } from './weapon';

declare module '../Registry' {
  interface ContentMap {
    explosive: ExplosiveDef;
  }
}

export const EXPLOSIVE_ART = ['frag', 'pineapple', 'claymore', 'landmine', 'ied', 'molotov', 'incendiary'] as const;

/**
 * Something that goes bang: a grenade (thrown: it arcs, bounces and rolls to a
 * stop, and only then does the fuse burn down), or a charge you place (a mine
 * under foot, a claymore facing a doorway, an improvised bomb). Placed ones
 * also turn up in the world as hazards.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  maxStack: v.optional(v.number({ int: true, min: 1 }), 5),
  /** How it's used: thrown (grenades) or set down (charges). */
  use: v.literal('throw', 'place'),
  /**
   * What sets it off: a `fuse` (grenades: seconds after it stops rolling),
   * `impact` (a Molotov: it bursts where it lands or hits a wall),
   * `proximity` (anyone within `sense` tiles) or `tripwire` (anyone crossing
   * the line `sense` tiles out in front of it).
   */
  trigger: v.literal('fuse', 'impact', 'proximity', 'tripwire'),
  /** Grenades: seconds from coming to rest until the bang. */
  fuse: v.optional(v.number({ min: 0.2, max: 10 }), 1.8),
  /** Charges: trigger reach, tiles. */
  sense: v.optional(v.number({ min: 0.3, max: 12 }), 1),
  /** Charges: seconds between being set off (click, beep) and the bang — a last chance to dive away. */
  delay: v.optional(v.number({ min: 0, max: 5 }), 0.3),
  /** Placed by someone: seconds before it's live (time to walk away). */
  arming: v.optional(v.number({ min: 0, max: 10 }), 2.5),
  /** Hard to see: only noticed within `spotRange` tiles (landmines). */
  hidden: v.optional(v.boolean(), false),
  spotRange: v.optional(v.number({ min: 0.5 }), 2.5),
  blast: v.object({
    /** Reach, tiles; damage falls off toward the edge. */
    radius: v.number({ min: 0.5, max: 12 }),
    damage: v.number({ min: 0 }),
    damageType: v.optional(v.literal(...DAMAGE_TYPES), 'ballistic'),
    /** Armor piercing of the fragments (0..1). */
    ap: v.optional(v.number({ min: 0, max: 1 }), 0.15),
    /** Throws people back, px at the center. */
    knockback: v.optional(v.number({ min: 0 }), 40),
    /** Damage to breakable walls, fences, crates at the center. */
    shatter: v.optional(v.number({ min: 0 }), 120),
    /** Directional (claymores): full damage only within this cone, degrees. */
    cone: v.optional(v.number({ min: 10, max: 360 }), 360),
    /** Incendiaries: sets everything flammable within `radius` tiles alight, and spills burning fuel (`fuel` seconds) on bare ground. */
    fire: v.optional(v.object({ radius: v.number({ min: 0.5, max: 8 }), fuel: v.optional(v.number({ min: 0 }), 0) })),
  }),
  /** Grenades: farthest throw, tiles. */
  range: v.optional(v.number({ min: 1 }), 10),
  art: v.object({ style: v.literal(...EXPLOSIVE_ART), color: v.color() }),
  sounds: soundRefs('throw', 'bounce', 'arm', 'trigger', 'explode'),
});

export type ExplosiveDef = Infer<typeof schema>;

export const explosiveType: ContentTypeSpec<'explosive'> = {
  type: 'explosive',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'explosive', ctx);
    checkSoundRefs(def.sounds, ctx);
    if (def.use === 'throw' && def.trigger !== 'fuse' && def.trigger !== 'impact') ctx.error('thrown explosives need trigger "fuse" or "impact"');
    if (def.use === 'place' && (def.trigger === 'fuse' || def.trigger === 'impact')) ctx.error('placed explosives need a proximity or tripwire trigger');
  },
};
