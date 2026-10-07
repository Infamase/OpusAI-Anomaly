import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkDrawing, legendEntry } from './legend';

export type { LegendEntry } from './legend';

declare module '../Registry' {
  interface ContentMap {
    structure: StructureDef;
  }
}

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
    checkDrawing(def, ctx, { slots: false });
    if (def.rubble) ctx.ref('tile', def.rubble, 'rubble');
    if (def.camp) {
      ctx.ref('faction', def.camp.faction, 'camp.faction');
      def.camp.templates.forEach((t, i) => ctx.ref('npcTemplate', t, `camp.templates[${i}]`));
    }
  },
};
