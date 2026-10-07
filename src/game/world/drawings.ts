import type { LegendEntry, ThemeSlot } from '../../content/types/legend';
import type { TileSet } from './TileSet';

/** One resolved cell of a structure or room drawing. */
export interface Cell {
  /** Tile index, or -1 to keep terrain. */
  tile: number;
  /** Terrain kept but without rocks or decorations. */
  clear: boolean;
  /** Solid (a wall). */
  wall: boolean;
  crate: { lootTable: string; variant: 'supply' | 'military' } | null;
  camp: boolean;
  spawn: boolean;
  entrance: boolean;
  /** Room door socket (sealed with the wall tile unless something attaches). */
  door: boolean;
  anomaly: string | null;
  explosive: string | null;
  portal: { world: string; label: string } | null;
}

export interface Drawing {
  w: number;
  h: number;
  /** cells[j * w + i] as authored; null = not part of it. */
  cells: (Cell | null)[];
  /** The same cells for a quarter turn: tiles with a `turned` form use it (a fence running the other way). */
  turnedCells: (Cell | null)[];
}

/** Turns a legend + map into cells. Theme slots ("$wall") need `theme` (rooms). */
export function resolveDrawing(def: { legend: Record<string, LegendEntry>; map: string[] }, tiles: TileSet, theme?: Record<ThemeSlot, number>): Drawing {
  const w = Math.max(...def.map.map((r) => r.length));
  const h = def.map.length;
  const tileOf = (id: string | undefined): number => {
    if (!id || id === 'terrain') return -1;
    if (id.startsWith('$')) {
      if (!theme) throw new Error(`theme slot "${id}" used outside a room`);
      return theme[id.slice(1) as ThemeSlot];
    }
    return tiles.index(id);
  };
  const lookup = new Map<string, Cell>();
  for (const [ch, e] of Object.entries(def.legend)) {
    const o = typeof e === 'string' ? { tile: e } : e;
    // A door socket defaults to wall; the generator opens it when a room attaches.
    const tile = o.door && !o.tile ? tileOf('$wall') : tileOf(o.tile);
    lookup.set(ch, {
      tile,
      clear: !!o.clear,
      wall: tile >= 0 && tiles.solid[tile] === 1,
      crate: o.crate ?? null,
      camp: !!o.camp,
      spawn: !!o.spawn,
      entrance: !!o.entrance,
      door: !!o.door,
      anomaly: o.anomaly ?? null,
      explosive: o.explosive ?? null,
      portal: o.portal ?? null,
    });
  }
  const cells: (Cell | null)[] = [];
  for (const row of def.map) for (let i = 0; i < w; i++) cells.push(lookup.get(row[i] ?? ' ') ?? null);
  const turnedOf = new Map<Cell, Cell>();
  for (const c of lookup.values()) {
    const turned = c.tile >= 0 ? tiles.defs[c.tile]!.turned : undefined;
    turnedOf.set(c, turned ? { ...c, tile: tiles.index(turned) } : c);
  }
  const turnedCells = cells.map((c) => (c ? turnedOf.get(c)! : null));
  return { w, h, cells, turnedCells };
}

/** Size after an orientation (0..3 quarter turns, +4 mirrored). */
export const orientedSize = (d: Drawing, orient: number) => (orient & 1 ? { w: d.h, h: d.w } : { w: d.w, h: d.h });

/** Where an oriented local cell (i, j) comes from in the authored drawing. */
export function sourceOf(d: Drawing, orient: number, i: number, j: number): { x: number; y: number } {
  const ow = orient & 1 ? d.h : d.w;
  let x = i;
  const y = j;
  if (orient >= 4) x = ow - 1 - x;
  switch (orient & 3) {
    case 0:
      return { x, y };
    case 1:
      return { x: y, y: d.h - 1 - x };
    case 2:
      return { x: d.w - 1 - x, y: d.h - 1 - y };
    default:
      return { x: d.w - 1 - y, y: x };
  }
}

/** The authored cell at an oriented local position. */
export function orientedCell(d: Drawing, orient: number, i: number, j: number): Cell | null {
  const s = sourceOf(d, orient, i, j);
  return (orient & 1 ? d.turnedCells : d.cells)[s.y * d.w + s.x] ?? null;
}
