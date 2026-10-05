import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';

declare module '../Registry' {
  interface ContentMap {
    tile: TileDef;
  }
}

export const PLACEHOLDER_TILE_STYLES = ['noise', 'grass', 'plate', 'grate', 'wall', 'rock', 'hazard'] as const;

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Blocks movement. */
  solid: v.boolean(),
  /** Blocks line of sight (used by AI and fog of war later). */
  opaque: v.optional(v.boolean(), false),
  /** Generated stand-in art until a real tileset exists. */
  placeholder: v.object({
    style: v.literal(...PLACEHOLDER_TILE_STYLES),
    color: v.color(),
    accent: v.optional(v.color()),
  }),
});

export type TileDef = Infer<typeof schema>;

export const tileType: ContentTypeSpec<'tile'> = { type: 'tile', schema };
