import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkSoundRefs, soundRefs } from './sound';

declare module '../Registry' {
  interface ContentMap {
    tile: TileDef;
  }
}

export const PLACEHOLDER_TILE_STYLES = ['noise', 'grass', 'plate', 'grate', 'wall', 'rock', 'hazard', 'water', 'mud', 'sand', 'gravel', 'cracked', 'asphalt', 'concrete', 'planks', 'brick', 'tiles', 'door', 'space', 'window', 'hatch', 'door_closed', 'door_open', 'wood_door', 'wood_door_open', 'debris', 'wall_cracked', 'brick_cracked'] as const;
/** Tall decorations drawn above the ground and depth-sorted with characters. */
export const PROP_STYLES = ['pine', 'dead_tree', 'boulder', 'bush', 'leafy_tree', 'reeds', 'wreck', 'rubble', 'console', 'machine', 'bunk', 'fence_h', 'fence_v', 'fence_broken', 'barricade', 'sign', 'campfire', 'lamp_post'] as const;
export type PropStyle = (typeof PROP_STYLES)[number];

const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Blocks movement. */
  solid: v.boolean(),
  /** Blocks line of sight (used by AI and fog of war later). */
  opaque: v.optional(v.boolean(), false),
  /** A low obstacle (water, a fence): blocks walking but bullets fly over it. */
  low: v.optional(v.boolean(), false),
  /** Walking speed multiplier on this ground (mud, shallows < 1). */
  speed: v.optional(v.number({ min: 0.1, max: 2 }), 1),
  /**
   * Ground blending: where this tile borders a tile with a lower value, it
   * spills over the edge with a ragged border (grass over dirt). 0 = hard edges.
   */
  blend: v.optional(v.number({ int: true, min: 0 }), 0),
  /** A tall prop (tree, boulder...) standing on this tile, drawn over the ground art. */
  prop: v.optional(v.literal(...PROP_STYLES)),
  /**
   * A door: using it (E) turns it into the `toggle` tile (closed ↔ open). A
   * closed door is solid and opaque; NPCs open unlocked doors on their way.
   * `key` locks it: only someone carrying that keycard opens it, and once open
   * it stays unlocked (its open tile toggles back to an unlocked door).
   */
  door: v.optional(v.object({ toggle: v.id(), key: v.optional(v.id()) })),
  /**
   * Bullets wear it down: after `hp` damage it breaks into the `becomes` tile
   * (a fragile wall into debris, a fence into splinters). `resist` is the share
   * of each bullet's damage it shrugs off. `debris` colors the flying bits.
   */
  breakable: v.optional(
    v.object({
      hp: v.number({ min: 1 }),
      becomes: v.id(),
      resist: v.optional(v.number({ min: 0, max: 0.95 }), 0),
      debris: v.optional(v.color()),
    }),
  ),
  /** It gives off light (a campfire, a lamp): color, reach in tiles, strength, and how much it flickers (0..1). */
  light: v.optional(
    v.object({
      color: v.color(),
      radius: v.number({ min: 0.5, max: 20 }),
      intensity: v.optional(v.number({ min: 0, max: 2 }), 1),
      flicker: v.optional(v.number({ min: 0, max: 1 }), 0),
    }),
  ),
  /** The tile to use when a drawing holding this one is turned a quarter turn (an east-west fence becomes a north-south one). */
  turned: v.optional(v.id()),
  /** Footsteps, bullets striking it, a door opening / closing / refusing, breaking (otherwise the engine cues). */
  sounds: soundRefs('step', 'impact', 'open', 'close', 'locked', 'break'),
  /** Generated stand-in art until a real tileset exists (for prop tiles: the ground under the prop). */
  placeholder: v.object({
    style: v.literal(...PLACEHOLDER_TILE_STYLES),
    color: v.color(),
    accent: v.optional(v.color()),
  }),
});

export type TileDef = Infer<typeof schema>;

export const tileType: ContentTypeSpec<'tile'> = {
  type: 'tile',
  schema,
  crossCheck(def, ctx) {
    checkSoundRefs(def.sounds, ctx);
    if (def.door) {
      ctx.ref('tile', def.door.toggle, 'door.toggle');
      if (def.door.key) ctx.ref('keycard', def.door.key, 'door.key');
      const other = ctx.registry.tryGet('tile', def.door.toggle);
      if (other && !other.door) ctx.error(`door.toggle "${def.door.toggle}" must be a door too (so it can be used again)`);
      if (other && other.solid === def.solid) ctx.error(`door.toggle "${def.door.toggle}" must be the other state (one solid, one walkable)`);
      if (def.door.key && !def.solid) ctx.error('only a closed (solid) door can be locked');
    }
    if (def.turned) ctx.ref('tile', def.turned, 'turned');
    if (def.breakable) {
      ctx.ref('tile', def.breakable.becomes, 'breakable.becomes');
      if (!def.solid) ctx.error('only solid tiles (walls, fences, barricades) can be breakable');
    }
  },
};
