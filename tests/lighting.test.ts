import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { World } from '../src/ecs/World';
import { Aim, Flashlight, Transform } from '../src/game/components';
import { clockText, daylight, lightFrom, lightPolygon, luminance, type LightSource } from '../src/game/lighting';
import { WorldLighting } from '../src/game/worldLighting';
import { getGenerator } from '../src/game/world/generators';
import { interiorPlan } from '../src/game/world/interiorGenerator';
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

/** Two rooms side by side (x 4..13 and 15..24, y 4..13) with a wall at x = 14 holding a door at y = 8. */
function rooms(): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  for (let y = 3; y <= 14; y++) for (let x = 3; x <= 25; x++) map.setTile(x, y, x === 3 || x === 25 || y === 3 || y === 14 || x === 14 ? 'lab_wall' : 'lab_tiles');
  map.setTile(14, 8, 'lab_door');
  return map;
}

describe('the clock', () => {
  it('reads as a time of day, and the sky follows it', () => {
    expect(clockText(8 * 60)).toBe('08:00');
    expect(clockText(25 * 60 + 5)).toBe('01:05');
    expect(luminance(daylight(12 * 60))).toBeGreaterThan(0.97);
    expect(luminance(daylight(0))).toBeLessThan(0.12);
    const dusk = daylight(19.5 * 60);
    expect(dusk[0]).toBeGreaterThan(dusk[2]); // amber
    expect(luminance(daylight(6 * 60))).toBeGreaterThan(luminance(daylight(3 * 60)));
  });
});

describe('lights and walls', () => {
  it('a lamp lights its room up to the walls (and their faces), not the room next door', () => {
    const map = rooms();
    const lamp: LightSource = { x: 9 * T, y: 9 * T, radius: 10 * T, color: [1, 1, 1], intensity: 1 };
    const poly = lightPolygon(map, lamp);
    for (let i = 2; i < poly.length; i += 2) expect(poly[i]!).toBeLessThan(14 * T + T * 0.6);
    expect(lightFrom(map, lamp, 12 * T, 9 * T)).toBeGreaterThan(0.2);
    expect(lightFrom(map, lamp, 17 * T, 9 * T)).toBe(0);
    expect(lightFrom(map, lamp, 6 * T, 9 * T)).toBeGreaterThan(lightFrom(map, lamp, 4.5 * T, 9 * T));
  });

  it('a beam lights only what it points at', () => {
    const map = rooms();
    const beam: LightSource = { x: 6 * T, y: 9 * T, radius: 8 * T, color: [1, 1, 1], intensity: 1, cone: { angle: 0, width: 0.8 } };
    expect(lightFrom(map, beam, 10 * T, 9 * T)).toBeGreaterThan(0.1);
    expect(lightFrom(map, beam, 6 * T, 12 * T)).toBe(0);
    expect(lightFrom(map, beam, 4 * T, 9 * T)).toBe(0);
  });

  it('opening a door lets the light through', () => {
    const map = rooms();
    const w = new World();
    const lighting = new WorldLighting(content, w, map, { dayCycle: false, ambient: '#101010' }, [{ x: 12, y: 8.5, color: '#ffffff', radius: 6, intensity: 1, flicker: 0 }]);
    lighting.setTime(0, 0);
    map.onTileChange = (x, y) => lighting.tileChanged(x, y);
    const beyond = () => lighting.levelAt(16 * T, 8.5 * T);
    expect(beyond()).toBeLessThan(0.1);
    map.setTile(14, 8, 'lab_door_open');
    expect(beyond()).toBeGreaterThan(0.2);
  });
});

describe('world lighting', () => {
  it('a dark world is dark away from lights, a flashlight lights where it points and gives its holder away', () => {
    const map = rooms();
    const w = new World();
    const lighting = new WorldLighting(content, w, map, { dayCycle: false, ambient: '#141414' }, []);
    lighting.setTime(0, 0);
    expect(lighting.levelAt(20 * T, 9 * T)).toBeLessThan(0.1);
    const p = w.create();
    w.add(p, Transform, { x: 16 * T, y: 9 * T, prevX: 0, prevY: 0 });
    w.add(p, Aim, { dir: { x: 1, y: 0 } });
    w.add(p, Flashlight, { on: true });
    lighting.update(1 / 60);
    expect(lighting.levelAt(21 * T, 9 * T)).toBeGreaterThan(0.4);
    expect(lighting.levelAt(16 * T, 12.5 * T)).toBeLessThan(0.15);
    expect(lighting.levelAt(16 * T, 9 * T)).toBeGreaterThan(0.85);
  });

  it('follows the clock on planets, and is broad daylight where a world says nothing', () => {
    const map = rooms();
    const planet = new WorldLighting(content, new World(), map, { dayCycle: true, ambient: '#ffffff' }, []);
    planet.setTime(12 * 60, 0);
    expect(planet.ambientLevel).toBeGreaterThan(0.97);
    expect(planet.draws({ left: 0, top: 0, right: 1000, bottom: 1000 }, { x: 0, y: 0 })).toEqual([]);
    planet.setTime(23 * 60, 0);
    expect(planet.ambientLevel).toBeLessThan(0.12);
    planet.setTime(23 * 60, 1);
    expect(planet.ambientLevel).toBeGreaterThan(0.2); // the brightness option lifts it
    const plain = new WorldLighting(content, new World(), map, undefined, []);
    plain.setTime(23 * 60, 0);
    expect(plain.ambientLevel).toBeGreaterThan(0.97);
  });

  it('glowing tiles (campfires) light up when their chunk is shown', () => {
    const map = rooms();
    map.setTile(8, 8, 'campfire');
    const lighting = new WorldLighting(content, new World(), map, { dayCycle: true, ambient: '#ffffff' }, []);
    lighting.setTime(0, 0);
    expect(lighting.levelAt(9 * T, 9 * T)).toBeLessThan(0.15);
    lighting.chunkShown(0, 0);
    expect(lighting.levelAt(9 * T, 9 * T)).toBeGreaterThan(0.3);
    lighting.chunkHidden(0, 0);
    expect(lighting.levelAt(9 * T, 9 * T)).toBeLessThan(0.15);
  });
});

describe('interior lamps', () => {
  it('hang over the rooms, on the floor plan, some dead and some flickering', () => {
    let total = 0;
    let rooms = 0;
    let flicker = 0;
    for (const id of ['underground_lab', 'derelict_freighter', 'orbital_station']) {
      const def = content.get('worldGen', id);
      const gen = getGenerator(def.generator);
      const params = gen.parseParams(def.params, tiles, content);
      const W = def.widthChunks * 16;
      const map = new TileMap({ tiles, generator: gen, params, seed: 9, widthChunks: def.widthChunks, heightChunks: def.heightChunks, deltas: new WorldDeltas(id) });
      const lamps = gen.lights!(9, params, W, W);
      rooms += interiorPlan(params, 9, W, W).placed.length;
      total += lamps.length;
      flicker += lamps.filter((l) => l.flicker > 0).length;
      for (const l of lamps) expect(map.isSolid(Math.floor(l.x), Math.floor(l.y))).toBe(false);
    }
    expect(total).toBeGreaterThan(rooms * 0.5);
    expect(total).toBeLessThan(rooms * 2);
    expect(flicker).toBeGreaterThan(0);
  });
});
