import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { hash3, hashInts } from '../src/core/rng';
import { segmentHitsSolid } from '../src/game/combat';
import { Exploration } from '../src/game/exploration';
import { getGenerator } from '../src/game/world/generators';
import { planetPlan } from '../src/game/world/planetGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
let tiles: TileSet;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
  tiles = new TileSet(content.all('tile'));
});

function planet(seed: number, id = 'zone_north') {
  const def = content.get('worldGen', id);
  const gen = getGenerator(def.generator);
  const params = gen.parseParams(def.params, tiles, content);
  const map = new TileMap({ tiles, generator: gen, params, seed, widthChunks: def.widthChunks, heightChunks: def.heightChunks, deltas: new WorldDeltas('w') });
  return { def, gen, params, map, plan: planetPlan(params, seed, map.widthTiles, map.heightTiles) };
}

describe('planet generation', () => {
  it('is a pure function of the seed', () => {
    const a = planet(4242);
    const b = planet(4242);
    const c = planet(4243);
    for (const [cx, cy] of [
      [3, 4],
      [16, 16],
      [30, 2],
    ] as const) {
      expect(a.map.chunk(cx, cy)!.tiles).toEqual(b.map.chunk(cx, cy)!.tiles);
    }
    let differs = false;
    for (let cy = 10; cy < 22 && !differs; cy++) for (let cx = 10; cx < 22 && !differs; cx++) differs = a.map.chunk(cx, cy)!.tiles.join() !== c.map.chunk(cx, cy)!.tiles.join();
    expect(differs).toBe(true);
  });

  it('finishes quickly on seeds whose roads once sent the search into an endless loop', () => {
    for (const seed of [213813, 261327]) {
      const t0 = performance.now();
      const { plan } = planet(seed);
      expect(plan.roads.length).toBeGreaterThan(0);
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });

  it('always places a structure its minimum count promises', () => {
    for (const seed of [11, 213813, 229651, 467221]) {
      const ids = new Set(planet(seed).plan.placed.map((q) => q.s.def.id));
      for (const id of ['research_bunker', 'crashed_freighter', 'launch_site']) expect(ids.has(id), `${id} (seed ${seed})`).toBe(true);
    }
  });

  it('places the start near the middle and every structure on solid ground', () => {
    for (const seed of [1, 77, 31337]) {
      const { plan, map } = planet(seed);
      const start = plan.placed[0]!;
      expect(start.s.def.id).toBe('loner_village');
      expect(Math.abs(start.x + start.w / 2 - map.widthTiles / 2)).toBeLessThan(map.widthTiles * 0.25);
      expect(plan.placed.length).toBeGreaterThan(12);
      // No overlapping structures.
      for (const a of plan.placed) {
        for (const b of plan.placed) {
          if (a === b) continue;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${a.s.def.id} vs ${b.s.def.id}`).toBe(false);
        }
      }
    }
  });

  it('connects every road-linked place to the spawn point on foot', () => {
    const { map, gen, params, plan } = planet(2024);
    const W = map.widthTiles;
    const H = map.heightTiles;
    const spawn = gen.spawnPoint(2024, params, W, H);
    expect(map.isSolid(spawn.x, spawn.y)).toBe(false);
    // Flood fill over walkable tiles from the spawn.
    const seen = new Uint8Array(W * H);
    const queue = [spawn.y * W + spawn.x];
    seen[queue[0]!] = 1;
    while (queue.length) {
      const k = queue.pop()!;
      const x = k % W;
      const y = (k - x) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        const n = ny * W + nx;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[n] || map.isSolid(nx, ny)) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    const linked = new Set(plan.routes.flatMap((r) => [r.from, r.to]));
    expect(linked.size).toBeGreaterThan(8);
    for (const i of linked) {
      const q = plan.placed[i]!;
      let reachable = false;
      for (let j = 0; j < q.h && !reachable; j++) for (let ii = 0; ii < q.w && !reachable; ii++) reachable = seen[(q.y + j) * W + q.x + ii] === 1;
      expect(reachable, `${q.s.def.id} #${i}`).toBe(true);
    }
  });

  it('has lakes, rivers, roads with bridges, and several biomes', () => {
    const { map } = planet(99);
    const count = new Map<string, number>();
    for (let cy = 0; cy < map.heightChunks; cy += 2) {
      for (let cx = 0; cx < map.widthChunks; cx += 2) {
        for (const t of map.chunk(cx, cy)!.tiles) count.set(tiles.id(t), (count.get(tiles.id(t)) ?? 0) + 1);
      }
    }
    for (const id of ['water_deep', 'water_shallow', 'asphalt', 'grass', 'moss', 'pine_tree', 'brick_wall']) expect(count.get(id) ?? 0, id).toBeGreaterThan(0);
  });

  it('populates camps at structures and patrols along roads', () => {
    const { map, gen, params } = planet(5);
    const camps = gen.population!(5, params, map.widthTiles, map.heightTiles, (x, y) => !map.isSolid(x, y));
    expect(camps.some((c) => c.faction === 'loners')).toBe(true);
    expect(camps.some((c) => c.faction === 'bandits' && c.behavior === 'guard')).toBe(true);
    const patrol = camps.find((c) => c.behavior === 'patrol');
    expect(patrol?.waypoints.length).toBeGreaterThan(2);
    // Same seed, same people.
    expect(gen.population!(5, params, map.widthTiles, map.heightTiles, (x, y) => !map.isSolid(x, y))).toEqual(camps);
  });

  it('names its places for the map and reports biomes', () => {
    const { map, gen, params } = planet(8);
    const names = gen.landmarks!(8, params, map.widthTiles, map.heightTiles).map((l) => l.name);
    expect(names).toContain('Rookie Village');
    expect(content.has('biome', gen.biomeAt!(8, params, map.widthTiles, map.heightTiles, 200, 200).id)).toBe(true);
  });
});

describe('planet tiles', () => {
  it('lets bullets fly over water but not walk through it', () => {
    const { map } = planet(99);
    let found: { x: number; y: number } | null = null;
    for (let y = 20; y < map.heightTiles - 20 && !found; y++) {
      for (let x = 20; x < map.widthTiles - 20 && !found; x++) if (tiles.id(map.getTile(x, y)) === 'water_deep') found = { x, y };
    }
    expect(found).not.toBeNull();
    const { x, y } = found!;
    expect(map.isSolid(x, y)).toBe(true);
    const cx = (x + 0.5) * TILE_PX;
    const cy = (y + 0.5) * TILE_PX;
    expect(segmentHitsSolid(map, cx - 4, cy, cx + 4, cy)).toBeNull();
  });

  it('slows walking on mud and in shallows', () => {
    const mud = tiles.index('mud');
    const shallow = tiles.index('water_shallow');
    expect(tiles.speed[mud]).toBeLessThan(1);
    expect(tiles.speed[shallow]).toBeLessThan(tiles.speed[mud]!);
    expect(tiles.speed[tiles.index('asphalt')]).toBe(1);
  });
});

describe('helpers', () => {
  it('hash3 matches hashInts exactly (old worlds stay the same)', () => {
    for (const [a, b, c] of [
      [0, 0, 0],
      [12345, -7, 99],
      [-1, 2 ** 31 - 1, 5],
    ] as const) {
      expect(hash3(a, b, c)).toBe(hashInts(a, b, c));
    }
  });

  it('remembers explored chunks in the save flags', () => {
    const flags: Record<string, unknown> = {};
    const e = new Exploration(flags, 'zone', 8, 8);
    const seen = e.reveal(100, 100, 300, 512);
    expect(seen.length).toBeGreaterThan(0);
    expect(e.isExplored(0, 0)).toBe(true);
    expect(e.isExplored(7, 7)).toBe(false);
    const again = new Exploration(flags, 'zone', 8, 8);
    expect(again.exploredCount).toBe(e.exploredCount);
    expect(again.reveal(100, 100, 300, 512)).toEqual([]);
  });
});

describe('minefields', () => {
  it('lie off the roads and away from the start, with a warning sign toward the road, and mines to step on', () => {
    for (const seed of [777, 12]) {
      const { plan, gen, params, map } = planet(seed);
      expect(plan.minefields.length).toBeGreaterThanOrEqual(3);
      const W = map.widthTiles;
      const start = plan.placed[0]!;
      for (const m of plan.mines) {
        expect(plan.roadDist[Math.floor(m.y) * W + Math.floor(m.x)]!).toBeGreaterThan(4);
        expect(Math.hypot(m.x - (start.x + start.w / 2), m.y - (start.y + start.h / 2))).toBeGreaterThan(40);
      }
      expect(plan.signs.size).toBeGreaterThanOrEqual(plan.minefields.length - 1);
      const sign = [...plan.signs][0]!;
      expect(map.tiles.id(map.getTile(sign % W, Math.floor(sign / W)))).toBe('mine_sign');
      // The mines come out as live charges in their chunks.
      const m = plan.mines[0]!;
      const objs = map.objects(Math.floor(m.x / 16), Math.floor(m.y / 16));
      expect(objs.some((o) => o.kind === 'explosive' && o.explosive === 'landmine')).toBe(true);
      expect(gen.landmarks!(seed, params, W, W).some((l) => l.name === 'Minefield')).toBe(true);
    }
  });

  it('places charges guarding military places, owned by whoever lives there', () => {
    const { plan, map } = planet(777);
    const checkpoint = plan.placed.find((q) => q.s.def.id === 'military_checkpoint')!;
    expect(checkpoint).toBeDefined();
    const objs = [];
    for (let cy = Math.floor(checkpoint.y / 16); cy <= Math.floor((checkpoint.y + checkpoint.h) / 16); cy++) {
      for (let cx = Math.floor(checkpoint.x / 16); cx <= Math.floor((checkpoint.x + checkpoint.w) / 16); cx++) objs.push(...map.objects(cx, cy));
    }
    const claymores = objs.filter((o) => o.kind === 'explosive' && o.id.startsWith('charge:military_checkpoint'));
    expect(claymores.length).toBe(2);
    if (checkpoint.hasCamp) for (const c of claymores) expect(c.kind === 'explosive' && c.faction).toBe('military');
  });
});
