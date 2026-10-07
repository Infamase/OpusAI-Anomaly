import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';

declare module '../Registry' {
  interface ContentMap {
    biome: BiomeDef;
  }
}

/**
 * A kind of landscape on a planet (meadow, pine forest, swamp…). Planet
 * generators pick a biome per spot from two climate noise fields: the biome
 * whose `climate` point is nearest wins, so biomes with neighboring climates
 * border each other the way they would in nature.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Where this biome sits in climate space (both 0..1). `weight` > 1 claims more area. */
  climate: v.object({
    moisture: v.number({ min: 0, max: 1 }),
    temperature: v.number({ min: 0, max: 1 }),
    weight: v.optional(v.number({ min: 0.1, max: 5 }), 1),
  }),
  /** Base ground tile. */
  ground: v.id(),
  /** Noise patches of other ground over the base: `cover` = share of the biome they take, `scale` = blob size in tiles. */
  patches: v.optional(v.array(v.object({ tile: v.id(), cover: v.number({ min: 0, max: 1 }), scale: v.optional(v.number({ min: 1 }), 8) })), []),
  /** Rock outcrops (solid): share of the area and blob size. */
  rock: v.optional(v.object({ tile: v.id(), cover: v.number({ min: 0, max: 0.6 }), scale: v.optional(v.number({ min: 1 }), 10) })),
  /**
   * Scattered decorations (trees, bushes, wrecks). `density` = chance per open
   * tile; `clump` 0 spreads them evenly, 1 gathers them into groves. `on`
   * limits them to one ground tile.
   */
  decor: v.optional(
    v.array(
      v.object({
        tile: v.id(),
        density: v.number({ min: 0, max: 0.6 }),
        clump: v.optional(v.number({ min: 0, max: 1 }), 0.5),
        on: v.optional(v.id()),
      }),
    ),
    [],
  ),
  /** Extra shallow water pools (swamps): share of the area. */
  pools: v.optional(v.number({ min: 0, max: 0.5 }), 0),
  /**
   * Wildlife: `density` = chance of a creature den per 16×16-tile area; each den
   * holds one pack of a creature picked by `weight`.
   */
  fauna: v.optional(
    v.object({ density: v.number({ min: 0, max: 1 }), creatures: v.array(v.object({ creature: v.id(), weight: v.optional(v.number({ min: 0 }), 1) }), { min: 1 }) }),
  ),
  /** Looping background sounds while the player is in this biome. */
  ambient: v.optional(v.array(v.id())),
});

export type BiomeDef = Infer<typeof schema>;

export const biomeType: ContentTypeSpec<'biome'> = {
  type: 'biome',
  schema,
  crossCheck(def, ctx) {
    ctx.ref('tile', def.ground, 'ground');
    def.patches.forEach((p, i) => ctx.ref('tile', p.tile, `patches[${i}].tile`));
    if (def.rock) ctx.ref('tile', def.rock.tile, 'rock.tile');
    def.decor.forEach((d, i) => {
      ctx.ref('tile', d.tile, `decor[${i}].tile`);
      if (d.on) ctx.ref('tile', d.on, `decor[${i}].on`);
    });
    def.ambient?.forEach((id, i) => ctx.ref('sound', id, `ambient[${i}]`));
    def.fauna?.creatures.forEach((c, i) => ctx.ref('creature', c.creature, `fauna.creatures[${i}]`));
  },
};
