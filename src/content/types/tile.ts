import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';

declare module '../Registry' {
  interface ContentMap {
    tile: TileDef;
  }
}

export const PLACEHOLDER_TILE_STYLES = ['noise', 'grass', 'plate', 'grate', 'wall', 'rock', 'hazard'] as const;
/** Tall decorations drawn above the ground and depth-sorted with characters. */
export const PROP_STYLES = ['pine', 'dead_tree', 'boulder', 'bush'] as const;
export type PropStyle = (typeof PROP_STYLES)[number];

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Blocks movement. */
  solid: v.boolean(),
  /** Blocks line of sight (used by AI and fog of war later). */
  opaque: v.optional(v.boolean(), false),
  /**
   * Ground blending: where this tile borders a tile with a lower value, it
   * spills over the edge with a ragged border (grass over dirt). 0 = hard edges.
   */
  blend: v.optional(v.number({ int: true, min: 0 }), 0),
  /** A tall prop (tree, boulder...) standing on this tile, drawn over the ground art. */
  prop: v.optional(v.literal(...PROP_STYLES)),
  /** Generated stand-in art until a real tileset exists (for prop tiles: the ground under the prop). */
  placeholder: v.object({
    style: v.literal(...PLACEHOLDER_TILE_STYLES),
    color: v.color(),
    accent: v.optional(v.color()),
  }),
});

export type TileDef = Infer<typeof schema>;

export const tileType: ContentTypeSpec<'tile'> = { type: 'tile', schema };
