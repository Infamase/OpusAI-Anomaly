import type { TileDef } from '../../content/types';

/**
 * Runtime lookup of tile defs by a compact numeric index (what chunk arrays
 * store). Indices are session-only. Anything persisted uses tile *ids*, so
 * adding or reordering tile content never corrupts saves.
 */
export class TileSet {
  readonly defs: TileDef[];
  readonly solid: Uint8Array;
  readonly opaque: Uint8Array;
  /** Blocks walking but not bullets (water, fences). */
  readonly low: Uint8Array;
  /** Walking speed multiplier. */
  readonly speed: Float32Array;
  readonly voidIndex: number;
  private byId = new Map<string, number>();

  constructor(defs: TileDef[]) {
    this.defs = defs.slice().sort((a, b) => a.id.localeCompare(b.id));
    if (this.defs.length > 65535) throw new Error('Too many tile types for Uint16 chunks');
    this.solid = new Uint8Array(this.defs.length);
    this.opaque = new Uint8Array(this.defs.length);
    this.low = new Uint8Array(this.defs.length);
    this.speed = new Float32Array(this.defs.length);
    this.defs.forEach((d, i) => {
      this.byId.set(d.id, i);
      this.solid[i] = d.solid ? 1 : 0;
      this.opaque[i] = d.opaque ? 1 : 0;
      this.low[i] = d.low ? 1 : 0;
      this.speed[i] = d.speed;
    });
    const v = this.byId.get('void');
    if (v === undefined) throw new Error('Content must define a "void" tile (used outside world bounds)');
    this.voidIndex = v;
  }

  index(id: string): number {
    const i = this.byId.get(id);
    if (i === undefined) throw new Error(`Unknown tile "${id}"`);
    return i;
  }

  tryIndex(id: string): number | undefined {
    return this.byId.get(id);
  }

  id(index: number): string {
    return this.defs[index]!.id;
  }

  get count(): number {
    return this.defs.length;
  }
}
