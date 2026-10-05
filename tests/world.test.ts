import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { moveAxis } from '../src/game/systems/MovementSystem';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
let tiles: TileSet;

beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  loadContent(content, bundledContentFiles);
  tiles = new TileSet(content.all('tile'));
});

function makeMap(seed: number, deltas = new WorldDeltas('w')) {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  return new TileMap({
    tiles,
    generator: gen,
    params: gen.parseParams(def.params, tiles),
    seed,
    widthChunks: def.widthChunks,
    heightChunks: def.heightChunks,
    deltas,
  });
}

const snapshot = (m: TileMap) => {
  const out: number[] = [];
  for (let y = 0; y < m.heightTiles; y += 3) for (let x = 0; x < m.widthTiles; x += 3) out.push(m.getTile(x, y));
  return out;
};

describe('test_range generator + TileMap', () => {
  it('regenerates identically from the same seed, differently from another', () => {
    expect(snapshot(makeMap(42))).toEqual(snapshot(makeMap(42)));
    expect(snapshot(makeMap(42))).not.toEqual(snapshot(makeMap(43)));
  });

  it('is independent of chunk load order (pure per chunk)', () => {
    const a = makeMap(7);
    const b = makeMap(7);
    b.getTile(127, 127); // load a far corner first
    expect(a.getTile(70, 70)).toBe(b.getTile(70, 70));
  });

  it('has a solid border and void outside bounds', () => {
    const m = makeMap(1);
    expect(m.isSolid(0, 50)).toBe(true);
    expect(m.isSolid(-5, 50)).toBe(true);
    expect(m.getTile(-1, -1)).toBe(tiles.voidIndex);
  });

  it('spawns the player on walkable ground', () => {
    const m = makeMap(99);
    const def = content.get('worldGen', 'test_range');
    const gen = getGenerator(def.generator);
    const s = gen.spawnPoint(99, gen.parseParams(def.params, tiles), m.widthTiles, m.heightTiles);
    expect(m.isSolid(s.x, s.y)).toBe(false);
  });

  it('records changes as deltas and re-applies them after chunks are dropped', () => {
    const deltas = new WorldDeltas('w');
    const m = makeMap(5, deltas);
    const original = tiles.id(m.getTile(64, 70));
    m.setTile(64, 70, 'metal_wall');
    expect(deltas.changedChunkCount).toBe(1);
    m.trim(-1, -1, -1, -1); // drop everything
    expect(m.loadedChunkCount).toBe(0);
    expect(tiles.id(m.getTile(64, 70))).toBe('metal_wall');
    // A fresh map with the same seed + deltas (i.e. after reload) shows the change too.
    expect(tiles.id(makeMap(5, deltas).getTile(64, 70))).toBe('metal_wall');
    // Undoing the change removes the delta entirely.
    m.setTile(64, 70, original);
    expect(deltas.changedChunkCount).toBe(0);
  });

  it('ignores saved tile ids that no longer exist in content', () => {
    const deltas = new WorldDeltas('w', [['4,4', { tiles: { 0: 'deleted_tile' }, removed: [], entities: [] }]]);
    const plain = makeMap(5);
    expect(makeMap(5, deltas).getTile(64, 64)).toBe(plain.getTile(64, 64));
  });
});

describe('tile collision', () => {
  it('stops flush against a wall and slides along it', () => {
    const deltas = new WorldDeltas('w');
    const m = makeMap(5, deltas);
    // Build an open 5x5 floor room with a wall column at x=12.
    for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) m.setTile(x, y, x === 12 ? 'metal_wall' : 'metal_floor');
    const col = { w: 12, h: 8 };
    const startX = 10.5 * TILE_PX;
    const y = 10.5 * TILE_PX;
    const x = moveAxis(m, startX, y, 100, col, 'x');
    expect(x + col.w / 2).toBeLessThanOrEqual(12 * TILE_PX);
    expect(x + col.w / 2).toBeGreaterThan(12 * TILE_PX - 0.01);
    // Moving vertically next to the wall is unaffected.
    expect(moveAxis(m, x, y, 10, col, 'y')).toBeCloseTo(y + 10);
  });

  it('lets an entity escape a wall that was built on top of it', () => {
    const m = makeMap(5);
    for (let y = 8; y < 14; y++) for (let x = 8; x < 14; x++) m.setTile(x, y, 'metal_floor');
    m.setTile(10, 10, 'metal_wall');
    const col = { w: 12, h: 8 };
    const x = moveAxis(m, 10.5 * TILE_PX, 10.9 * TILE_PX, 20, col, 'x');
    expect(x).toBeCloseTo(10.5 * TILE_PX + 20);
  });
});
