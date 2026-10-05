import { chunkKey, type WorldDeltas } from '../../save/WorldDeltas';
import type { WorldGenerator } from './generators';
import type { TileSet } from './TileSet';

export const CHUNK_SIZE = 16;
export const TILE_PX = 32;

export interface Chunk {
  cx: number;
  cy: number;
  key: string;
  /** Current tiles (generated + player changes). */
  tiles: Uint16Array;
  /** Pure generator output, kept to detect when a change is undone. */
  base: Uint16Array;
}

export interface TileMapOptions<P> {
  tiles: TileSet;
  generator: WorldGenerator<P>;
  params: P;
  seed: number;
  widthChunks: number;
  heightChunks: number;
  deltas: WorldDeltas;
  chunkSize?: number;
}

/**
 * A world made of chunks that are generated on demand from the seed, with the
 * player's saved changes layered on top. Chunks far from the player can be
 * dropped from memory at any time and rebuilt identically later.
 */
export class TileMap<P = unknown> {
  readonly tiles: TileSet;
  readonly chunkSize: number;
  readonly widthChunks: number;
  readonly heightChunks: number;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly seed: number;
  readonly deltas: WorldDeltas;
  /** Fired after any tile changes (tile coords). Renderers redraw on this. */
  onTileChange: ((tx: number, ty: number) => void) | null = null;

  private chunks = new Map<string, Chunk>();
  private generator: WorldGenerator<P>;
  private params: P;

  constructor(opts: TileMapOptions<P>) {
    this.tiles = opts.tiles;
    this.generator = opts.generator;
    this.params = opts.params;
    this.seed = opts.seed;
    this.deltas = opts.deltas;
    this.chunkSize = opts.chunkSize ?? CHUNK_SIZE;
    this.widthChunks = opts.widthChunks;
    this.heightChunks = opts.heightChunks;
    this.widthTiles = this.widthChunks * this.chunkSize;
    this.heightTiles = this.heightChunks * this.chunkSize;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.widthTiles && ty < this.heightTiles;
  }

  /** Returns the chunk, generating it (and applying saved changes) if needed. */
  chunk(cx: number, cy: number): Chunk | undefined {
    if (cx < 0 || cy < 0 || cx >= this.widthChunks || cy >= this.heightChunks) return undefined;
    const key = chunkKey(cx, cy);
    let c = this.chunks.get(key);
    if (c) return c;

    const n = this.chunkSize * this.chunkSize;
    const base = new Uint16Array(n);
    this.generator.generateChunk(
      {
        seed: this.seed,
        cx,
        cy,
        chunkSize: this.chunkSize,
        widthTiles: this.widthTiles,
        heightTiles: this.heightTiles,
        tiles: this.tiles,
        params: this.params,
      },
      base,
    );
    const tiles = base.slice();
    const delta = this.deltas.get(key);
    if (delta) {
      for (const [idx, id] of Object.entries(delta.tiles)) {
        const t = this.tiles.tryIndex(id);
        // A tile type removed from content falls back to the generated tile.
        if (t !== undefined) tiles[Number(idx)] = t;
        else console.warn(`[world] saved tile "${id}" no longer exists; using generated tile`);
      }
    }
    c = { cx, cy, key, tiles, base };
    this.chunks.set(key, c);
    return c;
  }

  getTile(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return this.tiles.voidIndex;
    const S = this.chunkSize;
    const c = this.chunk(Math.floor(tx / S), Math.floor(ty / S))!;
    return c.tiles[(ty % S) * S + (tx % S)]!;
  }

  isSolid(tx: number, ty: number): boolean {
    return this.tiles.solid[this.getTile(tx, ty)] === 1;
  }

  /** Changes a tile and records the difference from the generated world. */
  setTile(tx: number, ty: number, tileId: string): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const idx = this.tiles.index(tileId);
    const S = this.chunkSize;
    const c = this.chunk(Math.floor(tx / S), Math.floor(ty / S))!;
    const local = (ty % S) * S + (tx % S);
    if (c.tiles[local] === idx) return false;
    c.tiles[local] = idx;
    this.deltas.setTile(c.key, local, c.base[local] === idx ? null : tileId);
    this.onTileChange?.(tx, ty);
    return true;
  }

  /** Generator-placed objects in a chunk (deterministic, before player changes). */
  objects(cx: number, cy: number): import('./generators').WorldObjectSpawn[] {
    const c = this.chunk(cx, cy);
    if (!c || !this.generator.objects) return [];
    return this.generator.objects(
      {
        seed: this.seed,
        cx,
        cy,
        chunkSize: this.chunkSize,
        widthTiles: this.widthTiles,
        heightTiles: this.heightTiles,
        tiles: this.tiles,
        params: this.params,
      },
      c.base,
    );
  }

  /** Frees chunks outside the given tile rectangle (they regenerate on demand). */
  trim(minTx: number, minTy: number, maxTx: number, maxTy: number): void {
    const S = this.chunkSize;
    for (const [key, c] of this.chunks) {
      const x0 = c.cx * S;
      const y0 = c.cy * S;
      if (x0 + S < minTx || y0 + S < minTy || x0 > maxTx || y0 > maxTy) this.chunks.delete(key);
    }
  }
}
