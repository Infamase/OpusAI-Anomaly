import type { ContentTypeSpec } from '../Registry';
import { v, type Infer, type Validator } from '../schema';

declare module '../Registry' {
  interface ContentMap {
    structure: StructureDef;
  }
}

/**
 * What a legend character stands for. A plain string is a tile id. `"terrain"`
 * keeps whatever the planet would put there; an object can add a crate, mark
 * the camp's home, the player's arrival spot or where roads connect, or clear
 * the ground of trees and rocks (`"clear": true` with no tile = cleared terrain).
 */
export type LegendEntry =
  | string
  | {
      tile?: string;
      clear?: boolean;
      crate?: { lootTable: string; variant: 'supply' | 'military' };
      camp?: boolean;
      spawn?: boolean;
      entrance?: boolean;
    };

const legendEntry: Validator<LegendEntry> = (val, path, errors) => {
  if (typeof val === 'string') return v.id()(val, path, errors);
  return v.object({
    tile: v.optional(v.id()),
    clear: v.optional(v.boolean()),
    crate: v.optional(v.object({ lootTable: v.id(), variant: v.literal('supply', 'military') })),
    camp: v.optional(v.boolean()),
    spawn: v.optional(v.boolean()),
    entrance: v.optional(v.boolean()),
  })(val, path, errors);
};

/**
 * A hand-drawn place stamped into generated terrain: a house, a village, a
 * bandit hideout. `map` is drawn with characters looked up in `legend`; a
 * space means "not part of the structure" (terrain shows through).
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Shown on the map (omit to keep the place unmarked). */
  label: v.optional(v.string({ nonEmpty: true })),
  legend: v.record(legendEntry),
  map: v.array(v.string(), { min: 1 }),
  /** May be rotated / mirrored when placed. */
  rotate: v.optional(v.boolean(), true),
  /** Chance each wall tile is broken (ruins): it becomes the `rubble` tile, or terrain if none. */
  decay: v.optional(v.number({ min: 0, max: 0.9 }), 0),
  rubble: v.optional(v.id()),
  /** People living here. `chance` < 1 leaves some copies empty. */
  camp: v.optional(
    v.object({
      faction: v.id(),
      templates: v.array(v.id(), { min: 1 }),
      behavior: v.optional(v.literal('guard', 'patrol'), 'guard'),
      radius: v.optional(v.number({ min: 1 }), 6),
      chance: v.optional(v.number({ min: 0, max: 1 }), 1),
    }),
  ),
});

export type StructureDef = Infer<typeof schema>;

export const structureType: ContentTypeSpec<'structure'> = {
  type: 'structure',
  schema,
  crossCheck(def, ctx) {
    const width = Math.max(...def.map.map((r) => r.length));
    if (def.map.some((r) => r.length !== width)) ctx.error('map rows must all be the same length (pad with spaces)');
    for (const [ch, e] of Object.entries(def.legend)) {
      if (ch.length !== 1) ctx.error(`legend key "${ch}" must be one character`);
      const tile = typeof e === 'string' ? e : e.tile;
      if (tile && tile !== 'terrain') ctx.ref('tile', tile, `legend["${ch}"]`);
      if (typeof e === 'object' && e.crate) ctx.ref('lootTable', e.crate.lootTable, `legend["${ch}"].crate`);
    }
    const used = new Set(def.map.join(''));
    for (const ch of used) if (ch !== ' ' && !(ch in def.legend)) ctx.error(`map uses "${ch}" but the legend doesn't define it`);
    if (def.rubble) ctx.ref('tile', def.rubble, 'rubble');
    if (def.camp) {
      ctx.ref('faction', def.camp.faction, 'camp.faction');
      def.camp.templates.forEach((t, i) => ctx.ref('npcTemplate', t, `camp.templates[${i}]`));
    }
  },
};
