import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { EventBus } from '../src/core/EventBus';
import { World, type Entity } from '../src/ecs/World';
import { buildCharacterStats } from '../src/game/characters';
import type { CombatEvents } from '../src/game/combatEvents';
import { Character, Collider, Equipment, Explosive, Faction, Health, Inventory, Stats, Transform, Velocity } from '../src/game/components';
import { ExplosiveSystem, placeCharge, throwGrenade } from '../src/game/explosives';
import { BoltSystem, throwBolt } from '../src/game/systems/AnomalySystem';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { WorldDeltas } from '../src/save/WorldDeltas';

const T = TILE_PX;
let content: ContentRegistry;
let tiles: TileSet;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
  tiles = new TileSet(content.all('tile'));
});

/** Open floor x 4..60, y 2..20, walled around; extra walls can be added. */
function arena(): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  for (let y = 1; y <= 21; y++) for (let x = 3; x <= 61; x++) map.setTile(x, y, x === 3 || x === 61 || y === 1 || y === 21 ? 'lab_wall' : 'lab_tiles');
  return map;
}

function person(world: World, x: number, y: number, faction = 'loners'): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: 12, h: 8 });
  world.add(e, Character, { raceId: 'human', colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Equipment, {});
  world.add(e, Stats, buildCharacterStats(content, content.get('race', 'human'), {}));
  world.add(e, Health, { hp: 100, bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
  world.add(e, Inventory, []);
  world.add(e, Faction, { id: faction });
  return e;
}

function setup() {
  const map = arena();
  const world = new World();
  const events = new EventBus<CombatEvents>();
  const sys = new ExplosiveSystem(content, () => map, events);
  const booms: { x: number; y: number; defId: string }[] = [];
  events.on('explosion', (b) => booms.push(b));
  const run = (seconds: number, extra: { update(w: World, dt: number): void }[] = []) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      for (const s of extra) s.update(world, 1 / 60);
      sys.update(world, 1 / 60);
      world.flushDestroyed();
    }
  };
  return { map, world, events, sys, booms, run };
}

describe('grenades', () => {
  it('arc, bounce and roll to a stop near the aim point — the fuse only burns once it has stopped', () => {
    const { world, booms, run } = setup();
    const rgd = content.get('explosive', 'rgd5');
    const g = throwGrenade(world, rgd, 10 * T, 10 * T, 18 * T, 10 * T, null, null);
    const states = new Set<string>();
    let restAt = -1;
    for (let t = 0; t < 4 && world.isAlive(g); t += 1 / 60) {
      const ex = world.req(g, Explosive);
      states.add(ex.state);
      if (ex.state === 'fuse' && restAt < 0) {
        restAt = t;
        const p = world.req(g, Transform);
        expect(Math.abs(p.x - 18 * T)).toBeLessThan(T * 1.5);
        expect(booms).toEqual([]);
      }
      run(1 / 60);
    }
    expect([...states]).toEqual(['flying', 'rolling', 'fuse']);
    expect(restAt).toBeGreaterThan(0.5);
    expect(booms).toHaveLength(1);
  });

  it('bounce off walls instead of passing through them', () => {
    const { world, map, run } = setup();
    for (let y = 2; y < 21; y++) map.setTile(20, y, 'lab_wall');
    const g = throwGrenade(world, content.get('explosive', 'rgd5'), 16 * T, 10 * T, 26 * T, 10 * T, null, null);
    let maxX = 0;
    for (let i = 0; i < 120 && world.isAlive(g); i++) {
      maxX = Math.max(maxX, world.req(g, Transform).x);
      run(1 / 60);
    }
    expect(maxX).toBeLessThan(20 * T);
  });

  it('hurt more up close, not at all out of reach or behind a wall', () => {
    const { world, map, run } = setup();
    for (let y = 2; y < 21; y++) map.setTile(40, y, 'lab_wall');
    const near = person(world, 31 * T, 10 * T);
    const mid = person(world, 32.5 * T, 10 * T);
    const far = person(world, 36 * T, 10 * T);
    const hidden = person(world, 41.5 * T, 10 * T);
    const g = placeCharge(world, content.get('explosive', 'rgd5'), 30 * T, 10 * T, 0, null, null, true);
    world.req(g, Explosive).state = 'fuse';
    world.req(g, Explosive).timer = 0.05;
    run(0.2);
    const hp = (e: Entity) => world.req(e, Health).hp;
    expect(hp(near)).toBeLessThan(hp(mid));
    expect(hp(mid)).toBeLessThan(100);
    expect(hp(far)).toBe(100);
    expect(hp(hidden)).toBe(100);
    expect(world.req(near, Health).cause).toMatch(/RGD-5/);
  });
});

describe('placed charges', () => {
  it('a claymore arms, fires at whoever crosses its wire, and spares whoever stands behind it', () => {
    const { world, booms, run } = setup();
    const def = content.get('explosive', 'claymore');
    placeCharge(world, def, 20 * T, 10 * T, 0, null, 'player');
    const behind = person(world, 19 * T, 10 * T + 4, 'player');
    run(def.arming + 0.2);
    expect(booms).toEqual([]); // its own side doesn't set it off
    const walker = person(world, 23 * T, 7 * T);
    run(0.5);
    expect(booms).toEqual([]);
    world.req(walker, Transform).y = 10 * T + 2; // steps onto the wire
    run(0.5);
    expect(booms).toHaveLength(1);
    expect(world.req(walker, Health).hp).toBeLessThan(40);
    expect(world.req(behind, Health).hp).toBeGreaterThan(70);
  });

  it('a landmine waits, clicks under a foot, and goes off a beat later', () => {
    const { world, booms, events, run } = setup();
    const def = content.get('explosive', 'landmine');
    const phases: string[] = [];
    events.on('explosive', (e) => phases.push(e.phase));
    placeCharge(world, def, 30 * T, 10 * T, 0, null, null, true);
    const p = person(world, 33 * T, 10 * T);
    run(1);
    expect(booms).toEqual([]);
    world.req(p, Transform).x = 30 * T + 3;
    run(def.delay * 0.5);
    expect(phases).toEqual(['triggered']);
    expect(booms).toEqual([]);
    run(def.delay);
    expect(booms).toHaveLength(1);
    expect(world.req(p, Health).dead).toBe(true);
  });

  it('a bolt sets a mine off from a safe distance, and nearby charges go up with it', () => {
    const { world, booms, run } = setup();
    const mine = content.get('explosive', 'landmine');
    placeCharge(world, mine, 30 * T, 10 * T, 0, null, null, true);
    placeCharge(world, mine, 31.5 * T, 10 * T, 0, null, null, true);
    throwBolt(world, 25 * T, 10 * T, 30 * T, 10 * T);
    run(2, [new BoltSystem(() => null)]);
    expect(booms).toHaveLength(2);
  });

  it('blasts wear down breakable walls nearby', () => {
    const { world, map, events, run } = setup();
    map.setTile(32, 10, 'lab_wall_cracked');
    const hits: { tx: number; ty: number; amount: number }[] = [];
    events.on('tileHit', (h) => hits.push(h));
    placeCharge(world, content.get('explosive', 'ied'), 30 * T, 10.5 * T, 0, null, null, true);
    person(world, 30 * T, 11 * T);
    run(2);
    expect(hits.some((h) => h.tx === 32 && h.ty === 10 && h.amount > 50)).toBe(true);
  });
});
