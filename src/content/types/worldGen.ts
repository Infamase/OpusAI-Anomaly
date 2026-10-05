import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';

declare module '../Registry' {
  interface ContentMap {
    worldGen: WorldGenDef;
  }
}

/**
 * A world template: which generator algorithm to run (code) and with what
 * parameters (data). New planet types are new worldGen files; only genuinely new
 * algorithms need code.
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  /** Generator algorithm id, registered in code (see game/world/generators.ts). */
  generator: v.id(),
  /** Bounds in chunks. Chunks outside are empty void. */
  widthChunks: v.number({ int: true, min: 1 }),
  heightChunks: v.number({ int: true, min: 1 }),
  /** Generator-specific settings, validated by the generator itself. */
  params: v.any(),
});

export type WorldGenDef = Infer<typeof schema>;

export const worldGenType: ContentTypeSpec<'worldGen'> = { type: 'worldGen', schema };
