import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { isItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    npcTemplate: NpcTemplateDef;
  }
}

const range = (min: number, max: number) => v.tuple2(v.number({ min, max }), v.number({ min, max }));

/**
 * A kind of NPC ("bandit thug", "military rifleman"): faction, skill, what gear
 * it might wear and carry. Each spawned NPC rolls a random race, color and kit
 * from this, the same way the player is built.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  faction: v.id(),
  rank: v.literal('rookie', 'experienced', 'veteran'),
  /** 0..1: aim accuracy, reaction speed, use of cover. */
  skill: range(0, 1),
  /** Race ids allowed; empty = any playable race. */
  races: v.optional(v.array(v.id()), []),
  /** Armor sets to draw from (armor `set` field) and the chance each slot is filled. */
  armorSets: v.array(v.id(), { min: 1 }),
  armorChance: v.optional(v.number({ min: 0, max: 1 }), 0.85),
  primaries: v.optional(v.array(v.id()), []),
  primaryChance: v.optional(v.number({ min: 0, max: 1 }), 1),
  sidearms: v.array(v.id(), { min: 1 }),
  /** Spare magazines carried for each weapon. */
  spareMagazines: v.optional(range(0, 20), [1, 3] as [number, number]),
  /** Optional loot table rolled into the pockets on top of `carries`. */
  pockets: v.optional(v.id()),
  /**
   * How it thinks: `stalker` (takes cover, heals, retreats, throws grenades) or
   * `husk` (a burnt-out mind: shambles straight at you, firing, and never runs).
   */
  mind: v.optional(v.literal('stalker', 'husk'), 'stalker'),
  /** Tints the whole character (a husk's grey, dead skin). */
  tint: v.optional(v.color()),
  /** Extra items carried (and dropped on death). */
  carries: v.optional(
    v.array(
      v.object({
        item: v.id(),
        chance: v.number({ min: 0, max: 1 }),
        count: v.optional(v.tuple2(v.number({ int: true, min: 1 }), v.number({ int: true, min: 1 })), [1, 1] as [number, number]),
      }),
    ),
    [],
  ),
});

export type NpcTemplateDef = Infer<typeof schema>;

export const npcTemplateType: ContentTypeSpec<'npcTemplate'> = {
  type: 'npcTemplate',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('faction', def.faction, 'faction');
    def.races.forEach((r, i) => ctx.ref('race', r, `races[${i}]`));
    [...def.primaries, ...def.sidearms].forEach((w) => ctx.ref('weapon', w, 'weapons'));
    for (const set of def.armorSets) {
      if (!ctx.registry.all('armor').some((a) => a.set === set)) ctx.error(`no armor belongs to set "${set}"`);
    }
    if (def.pockets) ctx.ref('lootTable', def.pockets, 'pockets');
    def.carries.forEach((c, i) => {
      if (!isItemId(ctx.registry, c.item)) ctx.error(`carries[${i}].item "${c.item}" is not an item`);
    });
  },
};
