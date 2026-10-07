import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { getGenerator, type PortalSpawn } from '../src/game/world/generators';
import { interiorPlan } from '../src/game/world/interiorGenerator';
import '../src/game/world/planetGenerator';
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

const INTERIORS = ['underground_lab', 'derelict_freighter', 'orbital_station'];

function load(worldId: string, seed: number) {
  const def = content.get('worldGen', worldId);
  const gen = getGenerator(def.generator);
  const params = gen.parseParams(def.params, tiles, content);
  const map = new TileMap({ tiles, generator: gen, params, seed, widthChunks: def.widthChunks, heightChunks: def.heightChunks, deltas: new WorldDeltas(worldId) });
  return { def, gen, params, map };
}

/** Someone with every keycard and a gun: doors open, breakables break. */
const anyWay = (map: TileMap, x: number, y: number) => {
  const d = map.tiles.defs[map.getTile(x, y)]!;
  return !d.solid || !!d.door || !!d.breakable;
};
/** Someone with no keycard and no will to shoot: only plain floor and doors that open for anyone. */
const noKey = (map: TileMap, x: number, y: number) => !map.isSolid(x, y) || map.isOpenableDoor(x, y);

/** Tiles reachable from (sx, sy). */
function flood(map: TileMap, sx: number, sy: number, passable: (map: TileMap, x: number, y: number) => boolean = anyWay): Set<number> {
  const W = map.widthTiles;
  const seen = new Set<number>([sy * W + sx]);
  const queue = [sy * W + sx];
  while (queue.length) {
    const k = queue.pop()!;
    const x = k % W;
    const y = (k - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const nk = ny * W + nx;
      if (!map.inBounds(nx, ny) || seen.has(nk) || !passable(map, nx, ny)) continue;
      seen.add(nk);
      queue.push(nk);
    }
  }
  return seen;
}

const tileOf = (p: { x: number; y: number }) => ({ x: Math.floor(p.x / TILE_PX), y: Math.floor(p.y / TILE_PX) });

describe('interior layouts', () => {
  for (const id of INTERIORS) {
    it(`${id}: the right number of rooms, all reachable from the entrance, with a way back out`, () => {
      // 21 once stalled at three rooms (the must-have rooms didn't fit by the airlock).
      for (const seed of [1, 21, 42, 9001]) {
        const { def, gen, params, map } = load(id, seed);
        const plan = interiorPlan(params, seed, map.widthTiles, map.heightTiles);
        const [lo, hi] = (def.params as { count: [number, number] }).count;
        expect(plan.placed.length).toBeLessThanOrEqual(hi);
        expect(plan.placed.length, `seed ${seed}`).toBeGreaterThanOrEqual(lo);

        const spawn = gen.spawnPoint(seed, params, map.widthTiles, map.heightTiles);
        expect(map.isSolid(spawn.x, spawn.y)).toBe(false);
        const reach = flood(map, spawn.x, spawn.y);
        // Every room's floor is reachable (doors connect everything).
        for (const r of plan.placed) {
          let floor = 0;
          let reached = 0;
          for (let j = 0; j < r.h; j++) {
            for (let i = 0; i < r.w; i++) {
              const tx = r.x + i;
              const ty = r.y + j;
              if (map.isSolid(tx, ty)) continue;
              floor++;
              if (reach.has(ty * map.widthTiles + tx)) reached++;
            }
          }
          expect(reached, `${r.room.def.id} #${r.index} (seed ${seed})`).toBeGreaterThan(floor * 0.5);
        }
        const out = gen.portals!(seed, params, map.widthTiles, map.heightTiles).filter((p) => p.world === '@return');
        expect(out.length).toBeGreaterThan(0);
        const t = tileOf(out[0]!);
        expect([[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) => reach.has((t.y + dy!) * map.widthTiles + t.x + dx!))).toBe(true);
      }
    });
  }

  it('leaves the keycard for its locked rooms where you can reach it without one', () => {
    let locked = 0;
    for (const id of INTERIORS) {
      for (let seed = 1; seed <= 12; seed++) {
        const { gen, params, map } = load(id, seed);
        const plan = interiorPlan(params, seed, map.widthTiles, map.heightTiles);
        const lockedLinks = plan.links.filter((l) => l.kind === 'locked');
        if (!lockedLinks.length) {
          expect(plan.keycards).toEqual([]);
          continue;
        }
        locked++;
        expect(plan.keycards.length, `${id} seed ${seed}`).toBe(1);
        const kc = plan.keycards[0]!;
        const key = map.tiles.defs[map.getTile(lockedLinks[0]!.k % map.widthTiles, Math.floor(lockedLinks[0]!.k / map.widthTiles))]!.door?.key;
        expect(kc.item).toBe(key);
        const s = gen.spawnPoint(seed, params, map.widthTiles, map.heightTiles);
        expect(flood(map, s.x, s.y, noKey).has(kc.y * map.widthTiles + kc.x), `${id} seed ${seed}: keycard reachable`).toBe(true);
        // ...and it is in the world as an item to pick up.
        const S = map.chunkSize;
        const objs = map.objects(Math.floor(kc.x / S), Math.floor(kc.y / S));
        expect(objs.some((o) => o.kind === 'item' && o.item === kc.item)).toBe(true);
      }
    }
    expect(locked).toBeGreaterThan(10);
  });

  it('puts real doors, barricades and weak walls between rooms', () => {
    const counts: Record<string, number> = {};
    for (const id of INTERIORS) {
      const { map, params } = load(id, 4);
      const plan = interiorPlan(params, 4, map.widthTiles, map.heightTiles);
      for (const l of plan.links) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
      for (let i = 0; i < plan.tiles.length; i++) {
        const d = map.tiles.defs[plan.tiles[i]!]!;
        if (d.breakable && !d.prop) counts.fragile = (counts.fragile ?? 0) + 1;
      }
    }
    expect(counts, JSON.stringify(counts)).toBeDefined();
    expect(counts.door).toBeGreaterThan(5);
    expect(counts.doorway).toBeGreaterThan(5);
    expect(counts.barricade ?? 0, JSON.stringify(counts)).toBeGreaterThan(0);
    expect(counts.fragile ?? 0, JSON.stringify(counts)).toBeGreaterThan(0);
  });

  it('always includes the rooms an interior must have', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { params, map } = load('derelict_freighter', seed);
      const tags = interiorPlan(params, seed, map.widthTiles, map.heightTiles).placed.flatMap((r) => r.room.def.tags);
      expect(tags.filter((t) => t === 'engine').length, `seed ${seed}`).toBe(1);
      expect(tags.filter((t) => t === 'bridge').length, `seed ${seed}`).toBe(1);
    }
  });

  it('is the same every time for a seed, and different between seeds', () => {
    const { params, map } = load('orbital_station', 5);
    const a = interiorPlan(params, 5, map.widthTiles, map.heightTiles);
    const { params: params2 } = load('orbital_station', 5);
    const b = interiorPlan(params2, 5, map.widthTiles, map.heightTiles);
    expect(Array.from(b.tiles)).toEqual(Array.from(a.tiles));
    const c = interiorPlan(params, 6, map.widthTiles, map.heightTiles);
    expect(Array.from(c.tiles)).not.toEqual(Array.from(a.tiles));
  });

  it('never leaves a doorway opening onto nothing', () => {
    for (const id of INTERIORS) {
      const { map } = load(id, 77);
      const door = tiles.index('door_floor');
      const outside = new Set(['space', 'rock_wall'].map((t) => tiles.index(t)));
      for (let y = 1; y < map.heightTiles - 1; y++) {
        for (let x = 1; x < map.widthTiles - 1; x++) {
          if (map.getTile(x, y) !== door) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) expect(outside.has(map.getTile(x + dx, y + dy)), `${id} door at ${x},${y}`).toBe(false);
        }
      }
    }
  });

  it('names the room you are standing in', () => {
    const { gen, params, map } = load('underground_lab', 3);
    const s = gen.spawnPoint(3, params, map.widthTiles, map.heightTiles);
    expect(gen.areaAt!(3, params, map.widthTiles, map.heightTiles, s.x, s.y)).toBe(content.get('room', 'lab_entrance').name);
  });
});

describe('portals on the planet', () => {
  it('lead into each interior, from a doorway you can walk up to', () => {
    for (const seed of [777, 12, 31337]) {
      const { gen, params, map } = load('zone_north', seed);
      const portals: PortalSpawn[] = gen.portals!(seed, params, map.widthTiles, map.heightTiles);
      for (const id of INTERIORS) expect(portals.some((p) => p.world === id), `${id} (seed ${seed})`).toBe(true);
      const spawn = gen.spawnPoint(seed, params, map.widthTiles, map.heightTiles);
      const reach = flood(map, spawn.x, spawn.y);
      for (const p of portals) {
        const t = tileOf(p);
        expect(map.isSolid(t.x, t.y), p.id).toBe(false);
        expect(reach.has(t.y * map.widthTiles + t.x), `${p.id} reachable from the start (seed ${seed})`).toBe(true);
      }
    }
  });
});
