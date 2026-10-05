import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { WEAPON_STYLES } from '../../render/placeholder/weapons';
import { checkUniqueItemId } from '../items';
import { checkSoundRefs, soundRefs } from './sound';

declare module '../Registry' {
  interface ContentMap {
    weapon: WeaponDef;
  }
}

/** Damage types; each is reduced by the matching `<type>_resist` stat. */
export const DAMAGE_TYPES = ['ballistic', 'rupture', 'thermal', 'chemical', 'electric', 'radiation', 'psi'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];
export const resistStat = (type: DamageType): string => `${type}_resist`;

export const WEAPON_SLOTS = ['primary', 'sidearm'] as const;
export type WeaponSlot = (typeof WEAPON_SLOTS)[number];

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  slot: v.literal(...WEAPON_SLOTS),
  /** Ammo item ids this weapon accepts; the first is its default. */
  ammo: v.array(v.id(), { min: 1 }),
  magazine: v.number({ int: true, min: 1 }),
  fireMode: v.literal('semi', 'auto', 'burst'),
  burstCount: v.optional(v.number({ int: true, min: 2 }), 3),
  /** Rounds per minute. */
  fireRate: v.number({ min: 1 }),
  /** Damage per projectile, before ammo and resistances. */
  damage: v.number({ min: 0 }),
  damageType: v.optional(v.literal(...DAMAGE_TYPES), 'ballistic'),
  /** Projectiles per shot (shotguns > 1). */
  pellets: v.optional(v.number({ int: true, min: 1 }), 1),
  /** Base cone of fire, in degrees (full width). */
  spread: v.number({ min: 0 }),
  /** Extra spread while moving at full speed. */
  moveSpread: v.optional(v.number({ min: 0 }), 3),
  /** Spread added per shot, the cap, and how fast it recovers (degrees per second). */
  bloomPerShot: v.optional(v.number({ min: 0 }), 1),
  bloomMax: v.optional(v.number({ min: 0 }), 6),
  bloomRecovery: v.optional(v.number({ min: 0 }), 12),
  /** Projectile speed (px/s) and maximum travel (px). 32 px = 1 tile. */
  projectileSpeed: v.number({ min: 50 }),
  range: v.number({ min: 16 }),
  reloadTime: v.number({ min: 0.1 }),
  /** Ignores this much of the target's resistance (0..1). */
  armorPiercing: v.optional(v.number({ min: 0, max: 1 }), 0),
  /** Camera kick per shot, in pixels. */
  recoil: v.optional(v.number({ min: 0 }), 1),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  /** Sound overrides (otherwise the shot / reload / … cues). */
  sounds: soundRefs('shot', 'reload', 'reloadDone', 'dry', 'equip'),
  /** Generated stand-in art, or a PNG pointing right with grip and muzzle pixel coordinates. */
  placeholder: v.optional(v.object({ style: v.literal(...WEAPON_STYLES) })),
  sprite: v.optional(
    v.object({
      src: v.string({ nonEmpty: true }),
      grip: v.tuple2(v.number({ int: true }), v.number({ int: true })),
      muzzle: v.tuple2(v.number({ int: true }), v.number({ int: true })),
    }),
  ),
});

export type WeaponDef = Infer<typeof schema>;

export const weaponType: ContentTypeSpec<'weapon'> = {
  type: 'weapon',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'weapon', ctx);
    checkSoundRefs(def.sounds, ctx);
    def.ammo.forEach((a, i) => ctx.ref('ammo', a, `ammo[${i}]`));
    ctx.ref('stat', resistStat(def.damageType), 'damageType (its resist stat)');
    if (!def.placeholder && !def.sprite) ctx.error('needs either "placeholder" or "sprite"');
    if (def.bloomMax < 0 || def.spread > 90) ctx.error('spread must be under 90 degrees');
  },
};
