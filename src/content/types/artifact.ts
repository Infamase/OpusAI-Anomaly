import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';

declare module '../Registry' {
  interface ContentMap {
    artifact: ArtifactDef;
  }
}

export const ARTIFACT_SHAPES = ['crystal', 'orb', 'spiky', 'shell', 'flower', 'stone'] as const;

/**
 * Something the anomalies made: found inside anomaly fields, worn on the belt.
 * Most help (stat modifiers, healing) and most also irradiate the wearer.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  /** Applied while worn on the belt. */
  modifiers: v.optional(v.array(v.object({ stat: v.id(), op: v.literal('flat', 'percent', 'mult'), value: v.number() })), []),
  /** Radiation per second while worn; negative draws radiation out. */
  radiation: v.optional(v.number(), 0),
  /** Health per second while worn. */
  regen: v.optional(v.number(), 0),
  /** Anomalies (ids) whose fields can grow it, and how common it is there. */
  spawnsIn: v.array(v.id(), { min: 1 }),
  rarity: v.optional(v.number({ min: 0.01 }), 1),
  art: v.object({ shape: v.literal(...ARTIFACT_SHAPES), color: v.color(), glow: v.color() }),
});

export type ArtifactDef = Infer<typeof schema>;

export const artifactType: ContentTypeSpec<'artifact'> = {
  type: 'artifact',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'artifact', ctx);
    def.modifiers.forEach((m, i) => ctx.ref('stat', m.stat, `modifiers[${i}].stat`));
    def.spawnsIn.forEach((a, i) => ctx.ref('anomaly', a, `spawnsIn[${i}]`));
  },
};
