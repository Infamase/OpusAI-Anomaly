import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { PALETTE_CHANNELS } from '../../render/palette';
import { isItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    race: RaceDef;
  }
}

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  /** False for NPC-only species. */
  playable: v.optional(v.boolean(), true),
  spriteLayout: v.id(),
  /** "placeholder:<generatorId>" for generated art, or a path under public/ to a PNG sheet. */
  sheet: v.string({ nonEmpty: true }),
  /** Recolorable regions (hair / fur / scales...). Key colors are defined in docs/SPRITE_SPEC.md. */
  colorChannels: v.array(
    v.object({
      channel: v.literal(...PALETTE_CHANNELS),
      label: v.string({ nonEmpty: true }),
      default: v.color(),
      presets: v.optional(v.array(v.color()), []),
    }),
  ),
  /** Base values for stats; anything omitted uses the stat's default. */
  baseStats: v.record(v.number()),
  /** Armor is only wearable when its fitsRace tag matches this. */
  armorTag: v.id(),
  /** Armor and weapons equipped on a newly created character of this race. */
  startingEquipment: v.optional(v.array(v.id()), []),
  /** Items carried by a new character (ammo, supplies...). */
  startingInventory: v.optional(v.array(v.object({ item: v.id(), count: v.optional(v.number({ int: true, min: 1 }), 1) })), []),
  /** Collision box at the feet, in pixels. */
  hitbox: v.object({ w: v.number({ min: 1 }), h: v.number({ min: 1 }) }),
});

export type RaceDef = Infer<typeof schema>;

export const raceType: ContentTypeSpec<'race'> = {
  type: 'race',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('spriteLayout', def.spriteLayout, 'spriteLayout');
    for (const stat of Object.keys(def.baseStats)) ctx.ref('stat', stat, `baseStats.${stat}`);
    const channels = def.colorChannels.map((c) => c.channel);
    if (new Set(channels).size !== channels.length) ctx.error('colorChannels lists a channel twice');
    const slots = new Set<string>();
    for (const id of def.startingEquipment) {
      const armor = ctx.registry.tryGet('armor', id);
      const weapon = ctx.registry.tryGet('weapon', id);
      if (!armor && !weapon) {
        ctx.error(`startingEquipment references unknown armor or weapon "${id}"`);
        continue;
      }
      if (armor && armor.fitsRace !== def.armorTag) ctx.error(`starting armor "${id}" fits "${armor.fitsRace}", not "${def.armorTag}"`);
      const slot = (armor ?? weapon)!.slot;
      if (slots.has(slot)) ctx.error(`startingEquipment has two "${slot}" items`);
      slots.add(slot);
    }
    def.startingInventory.forEach((s, i) => {
      if (!isItemId(ctx.registry, s.item)) ctx.error(`startingInventory[${i}] references unknown item "${s.item}"`);
    });
  },
};
