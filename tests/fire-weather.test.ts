import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { EventBus } from '../src/core/EventBus';
import { Rng } from '../src/core/rng';
import { World } from '../src/ecs/World';
import { buildCharacterStats } from '../src/game/characters';
import type { CombatEvents } from '../src/game/combatEvents';
import { Breakable, Character, Collider, Equipment, Explosive, Faction, Health, Inventory, Stats, Transform, Velocity } from '../src/game/components';
import { ExplosiveSystem, placeCharge, throwGrenade } from '../src/game/explosives';
import { FireMap, FireSystem, type FireClimate } from '../src/game/fire';
import { weatherAt, weatherSight, weatherTint, WEATHER_SPELL } from '../src/game/weather';
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

/** A meadow of grass, x/y 2..61, walled round. */
function meadow(fill = 'grass'): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  for (let y = 1; y <= 62; y++) for (let x = 1; x <= 62; x++) map.setTile(x, y, x === 1 || y === 1 || x === 62 || y === 62 ? 'lab_wall' : fill);
  return map;
}

const calm: FireClimate = { rain: 0, wind: 0, windAngle: 0 };

function burn(fire: FireMap, seconds: number, climate = calm): void {
  for (let t = 0; t < seconds; t += 0.1) fire.update(0.1, climate);
}

function count(map: TileMap, id: string): number {
  let n = 0;
  for (let y = 2; y < 62; y++) for (let x = 2; x < 62; x++) if (map.tiles.id(map.getTile(x, y)) === id) n++;
  return n;
}

describe('fire', () => {
  it('spreads through grass, leaves scorched earth, and burns itself out', () => {
    const map = meadow();
    const fire = new FireMap(map, new Rng(1).next.bind(new Rng(1)));
    expect(fire.ignite(32, 32)).toBe(true);
    burn(fire, 4);
    expect(fire.size).toBeGreaterThan(3);
    burn(fire, 120);
    expect(fire.size).toBe(0);
    const scorched = count(map, 'scorched_earth');
    expect(scorched).toBeGreaterThan(15);
    // ...but not the whole meadow: it dies out over distance.
    expect(scorched).toBeLessThan(60 * 60 * 0.5);
    expect(map.tiles.id(map.getTile(32, 32))).toBe('scorched_earth');
  });

  it('runs downwind', () => {
    const map = meadow();
    const rng = new Rng(4);
    const fire = new FireMap(map, () => rng.next());
    fire.ignite(32, 32);
    burn(fire, 150, { rain: 0, wind: 1, windAngle: 0 });
    let east = 0;
    let west = 0;
    for (let y = 2; y < 62; y++) {
      for (let x = 2; x < 62; x++) {
        if (map.tiles.id(map.getTile(x, y)) !== 'scorched_earth') continue;
        if (x > 33) east++;
        if (x < 31) west++;
      }
    }
    expect(east).toBeGreaterThan(west * 2);
  });

  it('is put out by rain', () => {
    const map = meadow();
    const rng = new Rng(2);
    const fire = new FireMap(map, () => rng.next());
    fire.ignite(32, 32);
    burn(fire, 2);
    burn(fire, 6, { rain: 1, wind: 0, windAngle: 0 });
    expect(fire.size).toBe(0);
    expect(count(map, 'scorched_earth')).toBeLessThan(15);
  });

  it("spilled fuel burns on bare ground without spreading; water and walls don't burn", () => {
    const map = meadow('concrete');
    const fire = new FireMap(map);
    expect(fire.ignite(20, 20)).toBe(false);
    expect(fire.ignite(20, 20, 1, 5)).toBe(true);
    burn(fire, 3);
    expect(fire.size).toBe(1);
    burn(fire, 6);
    expect(fire.size).toBe(0);
    expect(map.tiles.id(map.getTile(20, 20))).toBe('concrete');
    map.setTile(10, 10, 'water_deep');
    expect(fire.ignite(10, 10, 1, 5)).toBe(false);
    expect(fire.ignite(1, 1, 1, 5)).toBe(false);
  });

  it('burns whoever stands in it, cooks off charges and burns crates', () => {
    const map = meadow('concrete');
    const fire = new FireMap(map);
    const w = new World();
    const events = new EventBus<CombatEvents>();
    let props = 0;
    events.on('propHit', () => props++);
    const sys = new FireSystem(content, () => fire, () => calm, events);
    const p = w.create();
    w.add(p, Transform, { x: 20.5 * T, y: 20.6 * T, prevX: 0, prevY: 0 });
    w.add(p, Velocity, { x: 0, y: 0 });
    w.add(p, Collider, { w: 12, h: 8 });
    w.add(p, Character, { raceId: 'human', colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
    w.add(p, Equipment, {});
    w.add(p, Stats, buildCharacterStats(content, content.get('race', 'human'), {}));
    w.add(p, Health, { hp: 100, bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
    w.add(p, Inventory, []);
    w.add(p, Faction, { id: 'loners' });
    const mine = placeCharge(w, content.get('explosive', 'landmine'), 22.5 * T, 20.5 * T, 0, null, null, true);
    const crate = w.create();
    w.add(crate, Transform, { x: 22.5 * T, y: 20.8 * T, prevX: 0, prevY: 0 });
    w.add(crate, Breakable, { hp: 35, max: 35, debris: '#8a5a32', halfW: 13, height: 20 });
    fire.ignite(20, 20, 1, 30);
    fire.ignite(22, 20, 1, 30);
    for (let i = 0; i < 60; i++) sys.update(w, 1 / 60);
    expect(w.req(p, Health).hp).toBeLessThan(90);
    expect(w.req(p, Health).cause).toMatch(/Burned/);
    expect(w.req(mine, Explosive).state).toBe('triggered');
    expect(props).toBeGreaterThan(0);
  });

  it('a Molotov bursts where it lands, without rolling or a fuse', () => {
    const map = meadow('concrete');
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const sys = new ExplosiveSystem(content, () => map, events);
    const booms: { x: number; defId: string }[] = [];
    events.on('explosion', (b) => booms.push(b));
    const g = throwGrenade(w, content.get('explosive', 'molotov'), 10 * T, 20 * T, 18 * T, 20 * T, null, null);
    let states = new Set<string>();
    for (let i = 0; i < 120 && w.isAlive(g); i++) {
      states.add(w.req(g, Explosive).state);
      sys.update(w, 1 / 60);
      w.flushDestroyed();
    }
    expect([...states]).toEqual(['flying']);
    expect(booms).toHaveLength(1);
    expect(booms[0]!.defId).toBe('molotov');
    expect(Math.abs(booms[0]!.x - 18 * T)).toBeLessThan(T * 3.5);
    states = new Set();
  });
});

describe('weather', () => {
  const odds = { clear: 4, cloudy: 3, rain: 3, storm: 1.2, fog: 1.5 };

  it('is the same every time for a seed and time, starts fair, and brings every kind round', () => {
    expect(weatherAt(5, 8 * 60, odds)).toEqual(weatherAt(5, 8 * 60, odds));
    expect(weatherAt(5, 8 * 60, odds).kind).toBe('clear');
    const kinds = new Set<string>();
    for (let n = 2; n < 200; n++) kinds.add(weatherAt(5, n * WEATHER_SPELL + 10, odds).kind);
    expect([...kinds].sort()).toEqual(['clear', 'cloudy', 'fog', 'rain', 'storm']);
  });

  it('changes over gradually, not all at once', () => {
    let prev = weatherAt(9, 0, odds);
    for (let m = 0; m < WEATHER_SPELL * 30; m += 5) {
      const w = weatherAt(9, m, odds);
      expect(Math.abs(w.rain - prev.rain)).toBeLessThan(0.2);
      expect(Math.abs(w.fog - prev.fog)).toBeLessThan(0.2);
      prev = w;
    }
  });

  it('dims the day, and fog and rain cut how far anyone sees', () => {
    const clear = weatherAt(1, 0, odds, 'clear');
    const fog = weatherAt(1, 0, odds, 'fog');
    const storm = weatherAt(1, 0, odds, 'storm');
    expect(weatherSight(clear)).toBe(1);
    expect(weatherSight(fog)).toBeLessThan(0.55);
    expect(weatherSight(storm)).toBeLessThan(0.85);
    expect(storm.lightning).toBe(true);
    const day = weatherTint([1, 1, 1], storm);
    expect(day[0]).toBeLessThan(0.7);
    expect(weatherTint([1, 1, 1], clear)).toEqual([1, 1, 1]);
  });
});
