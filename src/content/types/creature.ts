import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { isItemId } from '../items';
import { checkSoundRefs, soundRefs } from './sound';
import { DAMAGE_TYPES } from './weapon';

declare module '../Registry' {
  interface ContentMap {
    creature: CreatureDef;
  }
}

/** Skeletons the creature renderer knows how to build and animate. */
export const BODY_PLANS = ['quadruped', 'hexapod', 'biped', 'serpent'] as const;
export type BodyPlan = (typeof BODY_PLANS)[number];

/** Extra body parts, drawn on top of the plan. */
export const BODY_FEATURES = [
  'tusks',
  'horns',
  'mandibles',
  'antennae',
  'spikes',
  'plates',
  'mane',
  'tailClub',
  'sac',
  'claws',
  'mask',
  'tentacles',
  'frill',
  'carapace',
] as const;

/** How it treats others: see game/ai/CreatureBrainSystem.ts. */
export const TEMPERAMENTS = ['passive', 'territorial', 'predator', 'ambush'] as const;
export type Temperament = (typeof TEMPERAMENTS)[number];

export const ATTACK_KINDS = ['bite', 'claw', 'charge', 'leap', 'spit', 'drain'] as const;
export type AttackKind = (typeof ATTACK_KINDS)[number];

const tuple = (min: number) => v.tuple2(v.number({ int: true, min }), v.number({ int: true, min }));

const attack = v.object({
  /**
   * bite / claw: a strike at `range` px after `windup`; charge: a run at the
   * target that hits (and knocks back) whoever is in the way; leap: a pounce
   * from up to `range` px; spit: a glob of `type` damage lobbed at the
   * target (it can be dodged); drain: a bite that keeps feeding (bleeding,
   * and heals the attacker).
   */
  kind: v.literal(...ATTACK_KINDS),
  damage: v.number({ min: 0 }),
  type: v.optional(v.literal(...DAMAGE_TYPES), 'rupture'),
  ap: v.optional(v.number({ min: 0, max: 1 }), 0),
  /** Reach (bite, claw) or the farthest it's used from (charge, leap, spit), px. */
  range: v.number({ min: 4 }),
  /** Not used closer than this, px (a pounce needs a run-up). */
  minRange: v.optional(v.number({ min: 0 }), 0),
  /** The tell before it lands, seconds: a crouch, a lowered head, a rearing back. */
  windup: v.optional(v.number({ min: 0, max: 3 }), 0.3),
  cooldown: v.optional(v.number({ min: 0.1, max: 30 }), 1.2),
  /** Shoves the victim back, px. */
  knockback: v.optional(v.number({ min: 0 }), 0),
  /** Bleeding added on a hit (hp/s). */
  bleed: v.optional(v.number({ min: 0, max: 4 }), 0),
  /** spit: glob speed (px/s) and splash radius (px); drain: share of damage healed. */
  speed: v.optional(v.number({ min: 50 }), 260),
  splash: v.optional(v.number({ min: 0 }), 22),
  heal: v.optional(v.number({ min: 0, max: 2 }), 0),
  /** Glob / splash color. */
  color: v.optional(v.color(), '#9adc3a'),
  /** Relative chance when more than one attack is in reach. */
  weight: v.optional(v.number({ min: 0 }), 1),
});

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  /** fauna: native wildlife; mutant: something the Zone made. For the UI and docs. */
  family: v.literal('fauna', 'mutant'),
  faction: v.id(),
  temperament: v.literal(...TEMPERAMENTS),
  health: v.number({ min: 1 }),
  /** Resistance per damage type (0..0.9). */
  resist: v.optional(v.record(v.number({ min: 0, max: 0.9 })), {} as Record<string, number>),
  speed: v.object({ walk: v.number({ min: 1 }), run: v.number({ min: 1 }) }),
  /** Turn rate, radians per second. */
  agility: v.optional(v.number({ min: 0.5, max: 30 }), 7),
  senses: v.optional(
    v.object({
      /** px; 0 = blind (hunts by ear and nose). */
      sight: v.optional(v.number({ min: 0 }), 300),
      hearing: v.optional(v.number({ min: 0 }), 420),
      /** Notices anyone this close, through walls and in the dark, px. */
      smell: v.optional(v.number({ min: 0 }), 90),
      /** Sees as well at night as by day. */
      nightVision: v.optional(v.boolean(), false),
    }),
    { sight: 300, hearing: 420, smell: 90, nightVision: false },
  ),
  /** territorial: how close an intruder may come, px. */
  territory: v.optional(v.number({ min: 0 }), 150),
  /** Farthest it chases from home before giving up, px. */
  leash: v.optional(v.number({ min: 50 }), 700),
  /** Runs away below this share of health (0 = fights to the death). */
  flee: v.optional(v.number({ min: 0, max: 1 }), 0.25),
  /** Pack animals lose heart once this share of the pack is dead (0 = never). */
  morale: v.optional(v.number({ min: 0, max: 1 }), 0),
  /** When it's out and about; the rest of the time it rests at its den (and is slow to notice things). */
  activity: v.optional(v.literal('day', 'night', 'any'), 'any'),
  pack: v.optional(tuple(1), [1, 1] as [number, number]),
  attacks: v.optional(v.array(attack), []),
  abilities: v.optional(
    v.object({
      /** Nearly invisible until it strikes or is hurt. */
      cloak: v.optional(v.boolean(), false),
      /** Moves under the ground, surfacing to strike. */
      burrow: v.optional(v.boolean(), false),
      /** Heals hp per second when not hurt for a while. */
      regen: v.optional(v.number({ min: 0 }), 0),
    }),
    { cloak: false, burrow: false, regen: 0 },
  ),
  /** Feet collision box, px. */
  hitbox: v.object({ w: v.number({ min: 2 }), h: v.number({ min: 2 }) }),
  body: v.object({
    plan: v.literal(...BODY_PLANS),
    /** Body length (rump to chest), px. */
    length: v.number({ min: 4, max: 120 }),
    /** Back height at the hips, px. */
    height: v.number({ min: 2, max: 80 }),
    /** Girth: 1 = a dog's build. */
    build: v.optional(v.number({ min: 0.3, max: 3 }), 1),
    /** Neck length, as a share of body length. */
    neck: v.optional(v.number({ min: 0, max: 2 }), 0.35),
    /** Head size and snout length (1 = normal). */
    head: v.optional(v.number({ min: 0.2, max: 3 }), 1),
    snout: v.optional(v.number({ min: 0, max: 3 }), 1),
    /** Leg thickness (1 = normal). */
    legs: v.optional(v.number({ min: 0.2, max: 3 }), 1),
    /** Tail length (share of body length; 0 = none) and thickness. */
    tail: v.optional(v.number({ min: 0, max: 4 }), 0.6),
    tailWidth: v.optional(v.number({ min: 0.1, max: 3 }), 1),
    /** Shoulders higher (+) or lower (−) than the hips. */
    slope: v.optional(v.number({ min: -0.6, max: 0.8 }), 0.05),
    /** Bipeds: how far the spine leans forward (0 upright .. 1 horizontal). */
    hunch: v.optional(v.number({ min: 0, max: 1 }), 0.3),
    /** Serpents: body segments. */
    segments: v.optional(v.number({ int: true, min: 3, max: 24 }), 10),
    ears: v.optional(v.literal('none', 'pointed', 'long', 'round'), 'none'),
    eyes: v.optional(
      v.object({ count: v.optional(v.number({ int: true, min: 0, max: 8 }), 2), color: v.optional(v.color(), '#e8d040'), glow: v.optional(v.boolean(), false) }),
      { count: 2, color: '#e8d040', glow: false },
    ),
    features: v.optional(v.array(v.literal(...BODY_FEATURES)), []),
    colors: v.object({
      hide: v.color(),
      belly: v.optional(v.color()),
      accent: v.optional(v.color()),
      /** Claws, teeth, horns. */
      bone: v.optional(v.color(), '#d8ccb0'),
    }),
    pattern: v.optional(v.literal('none', 'stripes', 'spots', 'bands', 'mottled'), 'none'),
  }),
  /** Harvested from the carcass: each entry rolled on its own. */
  parts: v.optional(
    v.array(v.object({ item: v.id(), chance: v.number({ min: 0, max: 1 }), count: v.optional(tuple(1), [1, 1] as [number, number]) })),
    [],
  ),
  sounds: soundRefs('idle', 'alert', 'attack', 'hurt', 'death', 'step'),
});

export type CreatureDef = Infer<typeof schema>;
export type CreatureAttack = CreatureDef['attacks'][number];
export type CreatureBody = CreatureDef['body'];

export const creatureType: ContentTypeSpec<'creature'> = {
  type: 'creature',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('faction', def.faction, 'faction');
    checkSoundRefs(def.sounds, ctx);
    for (const t of Object.keys(def.resist)) {
      if (!(DAMAGE_TYPES as readonly string[]).includes(t)) ctx.error(`resist.${t}: not a damage type (${DAMAGE_TYPES.join(', ')})`);
    }
    def.parts.forEach((p, i) => {
      if (!isItemId(ctx.registry, p.item)) ctx.error(`parts[${i}].item "${p.item}" is not an item`);
    });
    if (def.pack[1] < def.pack[0]) ctx.error('pack: max is below min');
    if (def.temperament !== 'passive' && !def.attacks.length) ctx.error(`a ${def.temperament} creature needs at least one attack`);
    if (def.speed.run < def.speed.walk) ctx.error('speed.run is slower than speed.walk');
  },
};
