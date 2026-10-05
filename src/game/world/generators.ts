import type { TileSet } from './TileSet';

/**
 * A world generator algorithm. Algorithms are code; their settings come from
 * worldGen content files. Generation must be a pure function of (seed, chunk
 * coords, params) — no Math.random, no global state — so a world can always be
 * rebuilt from its seed.
 */
export interface ChunkGenContext<P> {
  seed: number;
  cx: number;
  cy: number;
  chunkSize: number;
  widthTiles: number;
  heightTiles: number;
  tiles: TileSet;
  params: P;
}

export interface WorldGenerator<P = unknown> {
  readonly id: string;
  /**
   * Bump when output for the same seed changes. Saved worlds record the version
   * they were created with, so old saves can keep the old behaviour if needed.
   */
  readonly version: number;
  /** Validates the worldGen def's params (throw with a clear message on problems). */
  parseParams(raw: unknown, tiles: TileSet): P;
  /** Fills `out` (chunkSize * chunkSize, row-major) with tile indices. */
  generateChunk(ctx: ChunkGenContext<P>, out: Uint16Array): void;
  /** Where the player appears on arrival, in tile coordinates. */
  spawnPoint(seed: number, params: P, widthTiles: number, heightTiles: number): { x: number; y: number };
}

const registry = new Map<string, WorldGenerator<never>>();

export function registerGenerator<P>(gen: WorldGenerator<P>): void {
  if (registry.has(gen.id)) throw new Error(`Generator "${gen.id}" registered twice`);
  registry.set(gen.id, gen as unknown as WorldGenerator<never>);
}

export function getGenerator(id: string): WorldGenerator<unknown> {
  const g = registry.get(id);
  if (!g) throw new Error(`Unknown world generator "${id}" (registered: ${[...registry.keys()].join(', ')})`);
  return g as unknown as WorldGenerator<unknown>;
}

export function generatorIds(): string[] {
  return [...registry.keys()];
}
