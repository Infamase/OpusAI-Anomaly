import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import { Rng } from '../src/core/rng';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { World, type Entity } from '../src/ecs/World';
import { NpcBrainSystem } from '../src/game/ai/NpcBrainSystem';
import { findPath, nearestWalkable } from '../src/game/ai/pathfinding';
import { buildCharacterStats } from '../src/game/characters';
import type { CombatEvents } from '../src/game/combatEvents';
import {
  Aim,
  Brain,
  Character,
  Collider,
  Combatant,
  Container,
  Equipment,
  Faction,
  Health,
  Inventory,
  newBrain,
  newCombatant,
  Npc,
  Stamina,
  Stats,
  Transform,
  Velocity,
} from '../src/game/components';
import { defaultStanding, PLAYER_FACTION, REP_HOSTILE, Relations } from '../src/game/factions';
import { countItem, createItem, createLoadedWeapon } from '../src/game/items';
import { ExplosiveSystem, throwGrenade } from '../src/game/explosives';
import { Explosive } from '../src/game/components';
import { generateFromTemplate } from '../src/game/npcs';
import { BODY_KIND, Population, POPULATION_KEY, type BodyData } from '../src/game/population';
import { MovementSystem } from '../src/game/systems/MovementSystem';
import { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { VitalsSystem } from '../src/game/systems/VitalsSystem';
import { WeaponSystem } from '../src/game/systems/WeaponSystem';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import type { SpriteSheetCache } from '../src/render/SpriteSheets';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

function testMap(seed = 1): TileMap {
  const tiles = new TileSet(content.all('tile'));
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  return new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
}

/** A walled, empty room of floor: (x0..x1, y0..y1) inclusive, in tiles. */
function room(map: TileMap, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const edge = x < x0 || x > x1 || y < y0 || y > y1;
      map.setTile(x, y, edge ? 'metal_wall' : 'metal_floor');
    }
  }
}

describe('faction relations', () => {
  it('reads the faction table from both sides', () => {
    const r = new Relations(content, defaultStanding());
    expect(r.factionAttitude('loners', 'bandits')).toBe('hostile');
    expect(r.factionAttitude('bandits', 'military')).toBe('hostile'); // bandits are hostile by default
    expect(r.factionAttitude('loners', 'military')).toBe('neutral');
    expect(r.factionAttitude('military', 'military')).toBe('friendly');
  });

  it("treats the player like their affiliation, shifted by reputation", () => {
    const standing = defaultStanding();
    const r = new Relations(content, standing);
    expect(r.playerAttitude('loners')).toBe('friendly');
    expect(r.playerAttitude('bandits')).toBe('hostile');
    expect(r.playerAttitude('military')).toBe('neutral');
    const changes: string[] = [];
    r.onAttitudeChange = (f, a) => changes.push(`${f}:${a}`);
    r.playerAggression('military', false);
    expect(standing.reputation.military).toBe(-5);
    r.playerAggression('military', true);
    r.playerAggression('military', false);
    expect(standing.reputation.military!).toBeLessThanOrEqual(REP_HOSTILE);
    expect(r.playerAttitude('military')).toBe('hostile');
    expect(changes).toEqual(['military:hostile']);
    standing.reputation.military = 50;
    expect(r.playerAttitude('military')).toBe('friendly');
  });

  it('grudges make individuals hostile regardless of faction', () => {
    const w = new World();
    const r = new Relations(content, defaultStanding());
    const a = w.create();
    const b = w.create();
    w.add(a, Faction, { id: 'loners' });
    w.add(b, Faction, { id: PLAYER_FACTION });
    w.add(a, Npc, { id: 'x:0', campId: 'x', templateId: 'loner_rookie', name: 'A', skill: 0.5, grudges: new Set() });
    expect(r.hostile(w, a, b)).toBe(false);
    w.req(a, Npc).grudges.add(b);
    expect(r.hostile(w, a, b)).toBe(true);
    expect(r.hostile(w, b, a)).toBe(true);
  });
});

describe('pathfinding', () => {
  it('walks around a wall and never cuts corners', () => {
    const map = testMap();
    room(map, 10, 10, 30, 20);
    for (let y = 10; y <= 18; y++) map.setTile(20, y, 'metal_wall'); // wall with a gap at the bottom
    const from = { x: 12.5 * TILE_PX, y: 12.5 * TILE_PX };
    const to = { x: 28.5 * TILE_PX, y: 12.5 * TILE_PX };
    const path = findPath(map, from, to)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual(to);
    // Some waypoint must go below the wall's end (row 18) to get round it.
    expect(path.some((p) => p.y > 18 * TILE_PX)).toBe(true);
    // Every leg stays on walkable ground.
    let prev = from;
    for (const p of path) {
      for (let s = 0; s <= 1; s += 0.02) {
        const x = prev.x + (p.x - prev.x) * s;
        const y = prev.y + (p.y - prev.y) * s;
        expect(map.isSolid(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX))).toBe(false);
      }
      prev = p;
    }
  });

  it('gives a straight line in the open, and null when sealed off', () => {
    const map = testMap();
    room(map, 10, 10, 30, 20);
    const path = findPath(map, { x: 11.5 * TILE_PX, y: 15.5 * TILE_PX }, { x: 29.5 * TILE_PX, y: 15.5 * TILE_PX })!;
    expect(path).toHaveLength(1);
    room(map, 40, 10, 44, 14);
    expect(findPath(map, { x: 11.5 * TILE_PX, y: 15.5 * TILE_PX }, { x: 42.5 * TILE_PX, y: 12.5 * TILE_PX }, 2000)).toBeNull();
  });

  it('finds the nearest walkable tile next to a wall', () => {
    const map = testMap();
    room(map, 10, 10, 12, 12);
    map.setTile(11, 11, 'metal_wall');
    const t = nearestWalkable(map, 11, 11)!;
    expect(map.isSolid(t.x, t.y)).toBe(false);
    expect(Math.max(Math.abs(t.x - 11), Math.abs(t.y - 11))).toBe(1);
  });
});

describe('NPC generation', () => {
  it('builds a template NPC deterministically, with fitting gear and real ammo', () => {
    const t = content.get('npcTemplate', 'military_rifleman');
    const a = generateFromTemplate(content, new Rng(42), t);
    const b = generateFromTemplate(content, new Rng(42), t);
    expect({ ...a, equipment: Object.keys(a.equipment), inventory: a.inventory.map((i) => i.defId) }).toEqual({
      ...b,
      equipment: Object.keys(b.equipment),
      inventory: b.inventory.map((i) => i.defId),
    });
    expect(content.get('faction', 'military').names).toContain(a.name);
    expect(a.skill).toBeGreaterThanOrEqual(t.skill[0]);
    expect(a.skill).toBeLessThanOrEqual(t.skill[1]);
    for (const slot of ['head', 'torso', 'legs'] as const) {
      const it = a.equipment[slot];
      if (it) expect(content.get('armor', it.defId).set).toBe('military');
    }
    const primary = a.equipment.primary!;
    expect(t.primaries).toContain(primary.defId);
    const ammo = content.get('weapon', primary.defId).ammo[0]!;
    expect(countItem(a.inventory, ammo)).toBeGreaterThanOrEqual(2 * content.get('weapon', primary.defId).magazine);
  });

  it('generates the same camps from the same seed, on walkable ground', () => {
    const map = testMap(7);
    const def = content.get('worldGen', 'test_range');
    const gen = getGenerator(def.generator);
    const params = gen.parseParams(def.params, new TileSet(content.all('tile')));
    const walk = (tx: number, ty: number) => !map.isSolid(tx, ty);
    const a = gen.population!(7, params, map.widthTiles, map.heightTiles, walk);
    const b = gen.population!(7, params, map.widthTiles, map.heightTiles, walk);
    expect(a).toEqual(b);
    expect(a.map((c) => c.id).sort()).toEqual(['army_patrol', 'bandit_den', 'outpost_loners']);
    for (const c of a) expect(map.isSolid(Math.floor(c.x / TILE_PX), Math.floor(c.y / TILE_PX))).toBe(false);
    expect(a.find((c) => c.id === 'army_patrol')!.waypoints.length).toBeGreaterThan(1);
  });
});

// ---- brains -------------------------------------------------------------------

function npc(w: World, faction: string, templateId: string, x: number, y: number, weapon: string, facing: 'left' | 'right'): Entity {
  const e = w.create();
  const race = content.get('race', 'human');
  const equipment = { primary: createLoadedWeapon(content, weapon) };
  w.add(e, Transform, { x, y, prevX: x, prevY: y });
  w.add(e, Velocity, { x: 0, y: 0 });
  w.add(e, Collider, { w: 12, h: 8 });
  w.add(e, Character, { raceId: 'human', colors: {}, facing, anim: 'idle', animTime: 0, sprinting: false });
  w.add(e, Equipment, equipment);
  w.add(e, Stats, buildCharacterStats(content, race, equipment));
  w.add(e, Health, { hp: 100, bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
  w.add(e, Stamina, { current: 100, exhausted: false, regenDelay: 0 });
  w.add(e, Combatant, newCombatant('primary'));
  w.add(e, Inventory, [{ uid: `ammo${e}`, defId: content.get('weapon', weapon).ammo[0]!, condition: 1, count: 90 }]);
  w.add(e, Faction, { id: faction });
  w.add(e, Aim, { dir: null });
  w.add(e, Npc, { id: `${faction}:${e}`, campId: faction, templateId, name: `N${e}`, skill: 0.7, grudges: new Set() });
  const brain = newBrain('guard', x, y, 40, []);
  brain.waitLeft = 99; // stand still facing `facing` instead of wandering off (keeps tests deterministic)
  brain.thinkIn = 0;
  w.add(e, Brain, brain);
  return e;
}

function arena(seed = 3) {
  const rng = new Rng(seed);
  const map = testMap();
  room(map, 10, 10, 30, 16);
  const w = new World();
  const events = new EventBus<CombatEvents>();
  const relations = new Relations(content, defaultStanding());
  const barks: string[] = [];
  const systems = [
    new NpcBrainSystem(content, () => map, events, relations, (_e, kind) => barks.push(kind), () => rng.next()),
    new WeaponSystem(content, () => map, events),
    new MovementSystem(() => map),
    new ProjectileSystem(content, () => map, events),
    new VitalsSystem(events),
  ];
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      for (const s of systems) s.update(w, 1 / 60);
      w.flushDestroyed();
    }
  };
  let shots = 0;
  events.on('shot', () => shots++);
  return { map, w, events, relations, barks, run, shots: () => shots };
}

describe('NPC brains', () => {
  it('hostile NPCs who see each other fight until one side is down', () => {
    const { w, run, barks, shots } = arena();
    const loner = npc(w, 'loners', 'loner_veteran', 13 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'right');
    const bandit = npc(w, 'bandits', 'bandit_gunner', 21 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    run(1.5);
    expect(w.req(loner, Brain).state).toBe('combat');
    expect(w.req(bandit, Brain).target).toBe(loner);
    expect(barks).toContain('contact');
    run(25);
    expect(shots()).toBeGreaterThan(5);
    const down = [loner, bandit].filter((e) => w.req(e, Health).dead || w.req(e, Health).hp < 100);
    expect(down.length).toBeGreaterThan(0);
  });

  it('neutral NPCs leave each other alone', () => {
    const { w, run, shots } = arena();
    npc(w, 'loners', 'loner_veteran', 13 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'right');
    npc(w, 'military', 'military_rifleman', 18 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    run(4);
    expect(shots()).toBe(0);
  });

  it('turns on an attacker and alerts the squad, even a non-hostile one', () => {
    const { w, events, run } = arena();
    const a = npc(w, 'military', 'military_rifleman', 13 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'right');
    const b = npc(w, 'military', 'military_rifleman', 14 * TILE_PX, 15 * TILE_PX, 'akr5_rifle', 'right');
    const shooter = npc(w, 'loners', 'loner_rookie', 25 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    run(0.5);
    expect(w.req(a, Brain).state).not.toBe('combat');
    events.emit('hit', { target: a, attacker: shooter, x: 0, y: 0, angle: 0, dealt: 5, blocked: 0, killed: false });
    expect(w.req(a, Brain).state).toBe('combat');
    expect(w.req(b, Brain).target).toBe(shooter);
    expect(w.req(b, Npc).grudges.has(shooter)).toBe(true);
  });

  it('goes to investigate gunshots it hears but cannot see', () => {
    const { w, events, run } = arena();
    const guard = npc(w, 'loners', 'loner_rookie', 13 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left'); // facing away
    events.emit('shot', { shooter: 999, x: 28 * TILE_PX, y: 13.5 * TILE_PX, angle: 0, weaponId: 'akr5_rifle', recoil: 0 });
    run(0.1);
    expect(w.req(guard, Brain).state).toBe('investigate');
    run(3);
    expect(w.req(guard, Transform).x).toBeGreaterThan(14 * TILE_PX);
  });

  it("doesn't shoot through a friend standing in the way", () => {
    const { w, run, shots } = arena();
    npc(w, 'loners', 'loner_veteran', 13 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'right');
    const friend = npc(w, 'military', 'military_rifleman', 17 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    const bandit = npc(w, 'bandits', 'bandit_thug', 24 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    // Neither the friend nor the target can shoot: only the loner's trigger discipline is tested.
    for (const e of [friend, bandit]) {
      delete w.req(e, Equipment).primary;
      w.req(e, Combatant).active = null;
    }
    // Freeze movement so the line stays blocked: only the trigger logic is tested.
    for (const e of [friend, bandit]) w.req(e, Stats).setBase('move_speed', 0);
    const loner = [...w.query(Npc)].find((e) => w.req(e, Faction).id === 'loners')!;
    w.req(loner, Stats).setBase('move_speed', 0);
    run(3);
    expect(w.req(loner, Brain).state).toBe('combat');
    expect(shots()).toBe(0);
  });
});

describe('population persistence', () => {
  it('a dead NPC stays dead and its body keeps what is left on it', () => {
    const map = testMap();
    const w = new World();
    const deltas = new WorldDeltas('w');
    const pop = new Population(w, content, null as unknown as SpriteSheetCache, deltas, map, () => {});
    const e = npc(w, 'bandits', 'bandit_thug', 100, 100, 'kestrel_smg', 'left');
    w.req(e, Npc).id = 'bandit_den:2';
    pop.onNpcDeath(e);
    expect(pop.isDead('bandit_den:2')).toBe(true);
    expect(deltas.get(POPULATION_KEY)?.removed).toContain('bandit_den:2');
    const c = w.req(e, Container);
    expect([...new Set(c.items!.map((i) => i.defId))].sort()).toEqual(['ammo_9x19', 'kestrel_smg']);
    expect(countItem(c.items!, 'ammo_9x19')).toBe(90);
    // Loot the gun: the saved body only keeps the ammo, and no longer wears the gun.
    c.items = c.items!.filter((i) => i.defId !== 'kestrel_smg');
    delete w.req(e, Equipment).primary;
    pop.saveBody(e);
    const [rec] = deltas.entitiesOfKind(BODY_KIND);
    const data = rec!.record.data as BodyData;
    expect(new Set(data.items.map((i) => i.defId))).toEqual(new Set(['ammo_9x19']));
    expect(data.worn).toEqual({});
    expect(data.name).toBe(w.req(e, Npc).name);
  });
});

describe('NPCs and grenades', () => {
  it('run from a live grenade they can see, shouting a warning, and hold fire meanwhile', () => {
    const { w, run, barks, shots } = arena();
    const bandit = npc(w, 'bandits', 'bandit_thug', 20 * TILE_PX, 13.5 * TILE_PX, 'akr5_rifle', 'left');
    const g = throwGrenade(w, content.get('explosive', 'rgd5'), 21 * TILE_PX, 13.5 * TILE_PX, 21 * TILE_PX, 13.5 * TILE_PX, null, null);
    Object.assign(w.req(g, Explosive), { state: 'fuse', timer: 99, z: 0, vx: 0, vy: 0, vz: 0 });
    run(1.6);
    const t = w.req(bandit, Transform);
    expect(Math.hypot(t.x - 21 * TILE_PX, t.y - 13.5 * TILE_PX)).toBeGreaterThan(3 * TILE_PX);
    expect(barks).toContain('grenade');
    expect(shots()).toBe(0);
  });

  /**
   * A bandit fighting someone who ducks behind a corner. Returns how many grenades
   * were thrown in `seconds`.
   */
  function flushOut(seed: number, bandits: number, seconds: number): number {
    const rng = new Rng(seed);
    const map = testMap();
    room(map, 10, 10, 30, 16);
    for (let y = 10; y <= 11; y++) map.setTile(20, y, 'metal_wall');
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const relations = new Relations(content, defaultStanding());
    const brain = new NpcBrainSystem(content, () => map, events, relations, () => {}, () => rng.next());
    (brain as unknown as { groupGrenadeIn: number }).groupGrenadeIn = 0;
    const systems = [brain, new MovementSystem(() => map), new ExplosiveSystem(content, () => map, events)];
    // The one hiding: no brain, no gun, just there.
    const hider = w.create();
    w.add(hider, Transform, { x: 21.5 * TILE_PX, y: 10.6 * TILE_PX, prevX: 0, prevY: 0 });
    w.add(hider, Health, { hp: 1e6, bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
    w.add(hider, Faction, { id: 'loners' });
    const throwers: Entity[] = [];
    for (let i = 0; i < bandits; i++) {
      const b = npc(w, 'bandits', 'bandit_thug', 14 * TILE_PX, (15.5 - i * 0.6) * TILE_PX, 'akr5_rifle', 'right');
      w.req(b, Inventory).push(createItem('rgd5', 3));
      w.req(b, Brain).grenadeIn = 0;
      throwers.push(b);
    }
    // They've been shot at by the hider (the brain needs a tick to know the world first).
    brain.update(w, 1 / 60);
    for (const b of throwers) events.emit('hit', { target: b, attacker: hider, x: 0, y: 0, angle: 0, dealt: 1, blocked: 0, killed: false });
    let thrown = 0;
    events.on('grenadeThrown', () => thrown++);
    for (let i = 0; i < seconds * 60; i++) {
      for (const s of systems) s.update(w, 1 / 60);
      for (const b of throwers) {
        // Pinned in place, still fighting.
        const t = w.req(b, Transform);
        t.x = t.prevX;
        t.y = t.prevY;
        w.req(b, Brain).sinceSeen = Math.min(w.req(b, Brain).sinceSeen, 6);
      }
      w.flushDestroyed();
    }
    return thrown;
  }

  it('throw one to flush out someone hiding behind cover, but rarely', () => {
    const results = [1, 2, 3, 4, 5].map((seed) => flushOut(seed, 1, 40));
    // At most one each in 40 seconds, and some do throw.
    for (const n of results) expect(n).toBeLessThanOrEqual(1);
    expect(results.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('never throw together: one grenade at a time across the whole squad', () => {
    for (const seed of [1, 2, 3]) expect(flushOut(seed, 3, 15)).toBeLessThanOrEqual(1);
  });
});
