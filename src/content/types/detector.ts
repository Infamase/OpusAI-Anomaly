import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkUniqueItemId } from '../items';
import { checkSoundRefs, soundRefs } from './sound';

declare module '../Registry' {
  interface ContentMap {
    detector: DetectorDef;
  }
}

/**
 * An artifact detector. The best one in the backpack works on its own: it
 * beeps faster as an artifact gets closer and makes artifacts visible.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  weight: v.number({ min: 0 }),
  value: v.number({ int: true, min: 0 }),
  /** Senses artifacts this far away, tiles. */
  range: v.number({ min: 1 }),
  /** Artifacts this close become visible, tiles. */
  reveal: v.number({ min: 0 }),
  /** Shows which way the artifact is, not just how far. */
  direction: v.optional(v.boolean(), false),
  /** Case color (icon). */
  color: v.optional(v.color(), '#5a6658'),
  sounds: soundRefs('beep'),
});

export type DetectorDef = Infer<typeof schema>;

export const detectorType: ContentTypeSpec<'detector'> = {
  type: 'detector',
  schema,
  crossCheck(def, ctx) {
    checkUniqueItemId(def.id, 'detector', ctx);
    checkSoundRefs(def.sounds, ctx);
    if (def.reveal > def.range) ctx.error('reveal must not exceed range');
  },
};
