import { emptyChunkDelta, isChunkDeltaEmpty, type ChunkDelta } from './types';

export const chunkKey = (cx: number, cy: number): string => `${cx},${cy}`;

/**
 * The in-memory record of everything the player changed in one world.
 * Loaded in full when the player enters the world (deltas are small), so chunk
 * generation can apply them synchronously. Only touched chunks are written back.
 */
export class WorldDeltas {
  private chunks = new Map<string, ChunkDelta>();
  private dirty = new Set<string>();

  constructor(readonly worldId: string, initial: Iterable<[string, ChunkDelta]> = []) {
    for (const [k, d] of initial) this.chunks.set(k, d);
  }

  get(key: string): ChunkDelta | undefined {
    return this.chunks.get(key);
  }

  /** Records a tile change. Pass `null` when the tile is back to its generated value. */
  setTile(key: string, localIndex: number, tileId: string | null): void {
    const d = this.chunks.get(key) ?? emptyChunkDelta();
    if (tileId === null) delete d.tiles[localIndex];
    else d.tiles[localIndex] = tileId;
    this.chunks.set(key, d);
    this.dirty.add(key);
  }

  markRemoved(key: string, generatedEntityId: string): void {
    const d = this.chunks.get(key) ?? emptyChunkDelta();
    if (!d.removed.includes(generatedEntityId)) d.removed.push(generatedEntityId);
    this.chunks.set(key, d);
    this.dirty.add(key);
  }

  get changedChunkCount(): number {
    let n = 0;
    for (const d of this.chunks.values()) if (!isChunkDeltaEmpty(d)) n++;
    return n;
  }

  get hasUnsaved(): boolean {
    return this.dirty.size > 0;
  }

  /** Returns changed chunks (null = now empty, delete it) and clears the dirty set. */
  takeDirty(): { key: string; delta: ChunkDelta | null }[] {
    const out = [...this.dirty].map((key) => {
      const d = this.chunks.get(key)!;
      if (isChunkDeltaEmpty(d)) {
        this.chunks.delete(key);
        return { key, delta: null };
      }
      return { key, delta: structuredClone(d) };
    });
    this.dirty.clear();
    return out;
  }

  /** Puts entries back if a save failed, so the next attempt retries them. */
  restoreDirty(keys: string[]): void {
    for (const k of keys) this.dirty.add(k);
  }
}
