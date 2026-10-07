import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { EventBus } from '../src/core/EventBus';
import { World } from '../src/ecs/World';
import { findPath } from '../src/game/ai/pathfinding';
import { TileDamage } from '../src/game/breakables';
import type { CombatEvents } from '../src/game/combatEvents';
import { Breakable, Character, Npc, Projectile, Transform, Velocity } from '../src/game/components';
import { DoorSystem, useDoor } from '../src/game/doors';
import { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { orientedCell, resolveDrawing } from '../src/game/world/drawings';
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
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
  tiles = new TileSet(content.all('tile'));
});

/** The test range with a wall down column 30 (full height) and `tile` in it at row 6. */
function walledMap(tile: string): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  for (let y = 0; y < map.heightTiles; y++) map.setTile(30, y, 'lab_wall');
  map.setTile(30, 6, tile);
  for (let x = 24; x <= 36; x++) if (x !== 30) for (const y of [5, 6, 7]) map.setTile(x, y, 'lab_tiles');
  return map;
}

const at = (tx: number, ty: number) => ({ x: (tx + 0.5) * TILE_PX, y: (ty + 0.5) * TILE_PX });

describe('doors', () => {
  it('open and close; a door won\'t shut on someone standing in it', () => {
    const map = walledMap('lab_door');
    const w = new World();
    expect(map.isSolid(30, 6)).toBe(true);
    expect(useDoor(w, map, 30, 6, () => false)).toBe('opened');
    expect(map.isSolid(30, 6)).toBe(false);
    const e = w.create();
    w.add(e, Transform, { x: 30.5 * TILE_PX, y: 6.6 * TILE_PX, prevX: 0, prevY: 0 });
    w.add(e, Character, { raceId: 'human', colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
    expect(useDoor(w, map, 30, 6, () => false)).toBe('blocked');
    w.destroy(e);
    w.flushDestroyed();
    expect(useDoor(w, map, 30, 6, () => false)).toBe('closed');
    expect(map.isSolid(30, 6)).toBe(true);
    // The change is saved like any other tile change.
    useDoor(w, map, 30, 6, () => false);
    expect(Object.values(map.deltas.get('1,0')?.tiles ?? {})).toContain('lab_door_open');
  });

  it('a locked door needs its keycard, and stays unlocked once opened', () => {
    const map = walledMap('lab_door_locked');
    const w = new World();
    expect(useDoor(w, map, 30, 6, () => false)).toBe('locked');
    expect(map.isSolid(30, 6)).toBe(true);
    expect(useDoor(w, map, 30, 6, (id) => id === 'lab_keycard')).toBe('unlocked');
    expect(map.isSolid(30, 6)).toBe(false);
    expect(useDoor(w, map, 30, 6, () => false)).toBe('closed');
    expect(map.tiles.id(map.getTile(30, 6))).toBe('lab_door');
    expect(useDoor(w, map, 30, 6, () => false)).toBe('opened');
  });

  it('NPCs plan routes through doors they can open, never through locked ones', () => {
    const open = walledMap('lab_door');
    const path = findPath(open, at(26, 6), at(34, 6));
    expect(path).not.toBeNull();
    expect(path!.some((p) => Math.floor(p.x / TILE_PX) === 30 && Math.floor(p.y / TILE_PX) === 6)).toBe(true);
    expect(findPath(walledMap('lab_door_locked'), at(26, 6), at(34, 6))).toBeNull();
  });

  it('NPCs open a door they walk into', () => {
    const map = walledMap('lab_door');
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const seen: string[] = [];
    events.on('door', (d) => seen.push(d.result));
    const e = w.create();
    w.add(e, Transform, { x: 29.6 * TILE_PX, y: 6.6 * TILE_PX, prevX: 0, prevY: 0 });
    w.add(e, Velocity, { x: 60, y: 0 });
    w.add(e, Npc, { id: 'n', campId: 'c', templateId: 't', name: 'N', skill: 0.5 } as Npc);
    new DoorSystem(() => map, events).update(w, 1 / 60);
    expect(map.isSolid(30, 6)).toBe(false);
    expect(seen).toEqual(['opened']);
    // Locked doors stay shut for them.
    const locked = walledMap('lab_door_locked');
    new DoorSystem(() => locked).update(w, 1 / 60);
    expect(locked.isSolid(30, 6)).toBe(true);
  });
});

describe('breakables', () => {
  it('wear down under fire and give way into their broken form', () => {
    const map = walledMap('lab_wall_cracked');
    const dmg = new TileDamage(map);
    const def = content.get('tile', 'lab_wall_cracked').breakable!;
    const perHit = 30;
    const hits = Math.ceil(def.hp / (perHit * (1 - def.resist)));
    for (let i = 1; i < hits; i++) {
      const r = dmg.hit(30, 6, perHit)!;
      expect(r.broken).toBe(false);
      expect(r.wear).toBeCloseTo((i * perHit * (1 - def.resist)) / def.hp);
    }
    expect([...dmg.entries()]).toHaveLength(1);
    expect(dmg.hit(30, 6, perHit)!.broken).toBe(true);
    expect(map.tiles.id(map.getTile(30, 6))).toBe(def.becomes);
    expect(map.isSolid(30, 6)).toBe(false);
    expect([...dmg.entries()]).toHaveLength(0);
    // Plain walls don't care.
    expect(dmg.hit(30, 9, 1000)).toBeNull();
    expect(map.isSolid(30, 9)).toBe(true);
  });

  it('bullets report the tile they struck, and chip at breakable crates', () => {
    const map = walledMap('fence_ns');
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const tileHits: { tx: number; ty: number }[] = [];
    const propHits: number[] = [];
    events.on('tileHit', (h) => tileHits.push({ tx: h.tx, ty: h.ty }));
    events.on('propHit', (h) => propHits.push(h.target));
    const sys = new ProjectileSystem(content, () => map, events);
    const shoot = (x: number, y: number, vx: number, vy: number) => {
      const p = w.create();
      w.add(p, Transform, { x, y, prevX: x, prevY: y });
      w.add(p, Projectile, { owner: 0, faction: 'x', damage: 20, ap: 0, type: 'ballistic', vx, vy, travelled: 0, range: 2000 });
    };
    shoot(26 * TILE_PX, 6.5 * TILE_PX, 900, 0);
    for (let i = 0; i < 30; i++) sys.update(w, 1 / 60);
    expect(tileHits).toEqual([{ tx: 30, ty: 6 }]);
    const crate = w.create();
    w.add(crate, Transform, { x: 33 * TILE_PX, y: 7 * TILE_PX, prevX: 0, prevY: 0 });
    w.add(crate, Breakable, { hp: 35, max: 35, debris: '#8a5a32', halfW: 13, height: 20 });
    shoot(31 * TILE_PX, 7 * TILE_PX - 8, 900, 0);
    for (let i = 0; i < 30; i++) sys.update(w, 1 / 60);
    expect(propHits).toEqual([crate]);
  });

  it('fences turn with the drawing they are in', () => {
    const d = resolveDrawing({ legend: { f: 'fence' }, map: ['fff'] }, tiles);
    expect(tiles.id(orientedCell(d, 0, 1, 0)!.tile)).toBe('fence');
    expect(tiles.id(orientedCell(d, 1, 0, 1)!.tile)).toBe('fence_ns');
    expect(tiles.id(orientedCell(d, 2, 1, 0)!.tile)).toBe('fence');
  });
});
