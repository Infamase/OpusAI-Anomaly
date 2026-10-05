import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { DIRECTIONS } from '../../core/math';
import { PUPPET_PARTS } from '../../render/puppet';

declare module '../Registry' {
  interface ContentMap {
    spriteLayout: SpriteLayoutDef;
  }
}

/**
 * Describes how a sprite sheet is sliced. Body sheets and every armor-piece
 * sheet for a race share one layout, which is what keeps paper-doll layers
 * aligned frame-for-frame. See docs/SPRITE_SPEC.md.
 */
const schema = v.object({
  id: v.id(),
  frameSize: v.number({ int: true, min: 8 }),
  /** Pixel inside a frame that sits on the entity's position (between the feet). */
  anchor: v.tuple2(v.number({ int: true }), v.number({ int: true })),
  /** Row order of facings. Rows are grouped per animation: row = animIndex * directions.length + dirIndex. */
  directions: v.array(v.literal(...DIRECTIONS), { min: 1 }),
  /**
   * Cutout layouts: the piece in each column (a row per direction). Must match
   * PUPPET_PARTS (render/puppet.ts). See docs/SPRITE_SPEC.md.
   */
  parts: v.optional(v.array(v.literal(...PUPPET_PARTS))),
  animations: v.array(
    v.object({
      id: v.id(),
      frames: v.number({ int: true, min: 1 }),
      fps: v.number({ min: 0.1 }),
      loop: v.optional(v.boolean(), true),
    }),
    { min: 1 },
  ),
});

export type SpriteLayoutDef = Infer<typeof schema>;

export const spriteLayoutType: ContentTypeSpec<'spriteLayout'> = {
  type: 'spriteLayout',
  schema,
  crossCheck(def, ctx) {
    const [ax, ay] = def.anchor;
    // Cutout layouts: the anchor is the feet of the bind-pose drawing, not a point in a cell.
    if (!def.parts && (ax < 0 || ay < 0 || ax >= def.frameSize || ay >= def.frameSize)) ctx.error('anchor lies outside the frame');
    if (new Set(def.directions).size !== def.directions.length) ctx.error('duplicate direction');
    if (new Set(def.animations.map((a) => a.id)).size !== def.animations.length) ctx.error('duplicate animation id');
    if (def.parts && def.parts.join() !== PUPPET_PARTS.join()) ctx.error(`parts must be exactly: ${PUPPET_PARTS.join(', ')}`);
    if (def.parts && def.parts.length !== def.animations[0]!.frames) ctx.error('parts must list one piece per column');
  },
};

/** Sheet row for an animation + facing, or -1 if the layout lacks it. */
export function layoutRow(layout: SpriteLayoutDef, animId: string, dir: string): number {
  const a = layout.animations.findIndex((x) => x.id === animId);
  const d = layout.directions.indexOf(dir as (typeof DIRECTIONS)[number]);
  if (a < 0 || d < 0) return -1;
  return a * layout.directions.length + d;
}

export function layoutSheetSize(layout: SpriteLayoutDef): { width: number; height: number } {
  const cols = Math.max(...layout.animations.map((a) => a.frames));
  const rows = layout.animations.length * layout.directions.length;
  return { width: cols * layout.frameSize, height: rows * layout.frameSize };
}
