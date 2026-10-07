import type { CrossCheckContext } from '../Registry';
import { v, type Validator } from '../schema';

/** Theme slots a room can use instead of tile ids (`"$wall"`); each interior theme fills them in. */
export const THEME_SLOTS = ['wall', 'floor', 'floor2', 'door', 'outside', 'accent', 'window'] as const;
export type ThemeSlot = (typeof THEME_SLOTS)[number];

/**
 * What a legend character in a structure or room drawing stands for. A plain
 * string is a tile id (or `"terrain"`: keep what's there; or `"$slot"`: the
 * theme's tile, rooms only). An object can also add a crate, mark the camp's
 * home, the player's arrival spot, a road entrance, a door socket (rooms), an
 * anomaly, or a portal to another world.
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
      /** Rooms: where another room may attach. A doorway if used, wall if not. */
      door?: boolean;
      /** An anomaly sits here. */
      anomaly?: string;
      /**
       * Step here and press E to go to another world. `world` is a worldGen id
       * or "@return" (back to wherever the player came from).
       */
      portal?: { world: string; label: string };
    };

const tileRef = v.string({ pattern: /^\$?[a-z][a-z0-9_]*$/ });

export const legendEntry: Validator<LegendEntry> = (val, path, errors) => {
  if (typeof val === 'string') return tileRef(val, path, errors);
  return v.object({
    tile: v.optional(tileRef),
    clear: v.optional(v.boolean()),
    crate: v.optional(v.object({ lootTable: v.id(), variant: v.literal('supply', 'military') })),
    camp: v.optional(v.boolean()),
    spawn: v.optional(v.boolean()),
    entrance: v.optional(v.boolean()),
    door: v.optional(v.boolean()),
    anomaly: v.optional(v.id()),
    portal: v.optional(v.object({ world: v.string({ pattern: /^(@return|[a-z][a-z0-9_]*)$/ }), label: v.string({ nonEmpty: true }) })),
  })(val, path, errors);
};

/** The tile a legend entry names (may be "terrain" or a "$slot"). */
export const legendTile = (e: LegendEntry): string | undefined => (typeof e === 'string' ? e : e.tile);

/** Shared checks for drawings: equal rows, every character defined, references valid. */
export function checkDrawing(def: { legend: Record<string, LegendEntry>; map: string[] }, ctx: CrossCheckContext, opts: { slots: boolean }): void {
  const width = Math.max(...def.map.map((r) => r.length));
  if (def.map.some((r) => r.length !== width)) ctx.error('map rows must all be the same length (pad with spaces)');
  for (const [ch, e] of Object.entries(def.legend)) {
    if (ch.length !== 1) ctx.error(`legend key "${ch}" must be one character`);
    const tile = legendTile(e);
    if (tile?.startsWith('$')) {
      if (!opts.slots) ctx.error(`legend["${ch}"]: theme slots ("${tile}") only work in rooms`);
      else if (!(THEME_SLOTS as readonly string[]).includes(tile.slice(1))) ctx.error(`legend["${ch}"]: unknown theme slot "${tile}" (${THEME_SLOTS.map((s) => `$${s}`).join(', ')})`);
    } else if (tile && tile !== 'terrain') ctx.ref('tile', tile, `legend["${ch}"]`);
    if (typeof e === 'object') {
      if (e.crate) ctx.ref('lootTable', e.crate.lootTable, `legend["${ch}"].crate`);
      if (e.anomaly) ctx.ref('anomaly', e.anomaly, `legend["${ch}"].anomaly`);
      if (e.portal && e.portal.world !== '@return') ctx.ref('worldGen', e.portal.world, `legend["${ch}"].portal.world`);
      if (e.door && !opts.slots) ctx.error(`legend["${ch}"]: door sockets only work in rooms`);
    }
  }
  const used = new Set(def.map.join(''));
  for (const ch of used) if (ch !== ' ' && !(ch in def.legend)) ctx.error(`map uses "${ch}" but the legend doesn't define it`);
}
