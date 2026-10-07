import type { TileMap } from './world/TileMap';

/** What a bullet did to a breakable tile. */
export interface TileHitResult {
  /** The tile's id before the hit. */
  tile: string;
  broken: boolean;
  /** Damage taken so far, 0..1 (1 when broken). */
  wear: number;
}

/**
 * Wear on breakable tiles (fragile walls, fences, barricades). Bullets chip
 * away at a tile's `breakable.hp`; when it runs out the tile becomes its
 * `becomes` tile, which is saved like any other tile change. Partial wear is
 * kept only for this visit: a half-shot wall is whole again next time.
 */
export class TileDamage {
  private wear = new Map<number, number>();
  /** Bumped on every change, so renderers know when to redraw cracks. */
  version = 0;

  constructor(private map: TileMap) {}

  /** Applies `amount` damage to the tile, if it's breakable. */
  hit(tx: number, ty: number, amount: number): TileHitResult | null {
    const map = this.map;
    if (!map.inBounds(tx, ty)) return null;
    const tile = map.getTile(tx, ty);
    const def = map.tiles.defs[tile]!;
    const b = def.breakable;
    if (!b || amount <= 0) return null;
    const k = ty * map.widthTiles + tx;
    const taken = (this.wear.get(k) ?? 0) + amount * (1 - b.resist);
    this.version++;
    if (taken < b.hp) {
      this.wear.set(k, taken);
      return { tile: def.id, broken: false, wear: taken / b.hp };
    }
    this.wear.delete(k);
    map.setTile(tx, ty, b.becomes);
    return { tile: def.id, broken: true, wear: 1 };
  }

  /** Damage taken by a tile, 0..1. */
  wearAt(tx: number, ty: number): number {
    const b = this.map.tiles.defs[this.map.getTile(tx, ty)]!.breakable;
    const w = this.wear.get(ty * this.map.widthTiles + tx);
    return b && w ? w / b.hp : 0;
  }

  /** Every worn tile: tile coords and wear 0..1. */
  *entries(): Generator<{ tx: number; ty: number; wear: number }> {
    const W = this.map.widthTiles;
    for (const [k, w] of this.wear) {
      const tx = k % W;
      const ty = (k - tx) / W;
      const b = this.map.tiles.defs[this.map.getTile(tx, ty)]!.breakable;
      if (b) yield { tx, ty, wear: w / b.hp };
    }
  }

  clear(): void {
    this.wear.clear();
    this.version++;
  }
}
