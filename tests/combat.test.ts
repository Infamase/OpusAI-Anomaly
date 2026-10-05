import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { World, type Entity } from '../src/ecs/World';
import { buildCharacterStats } from '../src/game/characters';
import {
  applyDamage,
  effectiveResist,
  muzzlePosition,
  segmentBoxEntry,
  segmentHitsSolid,
  MAX_RESIST,
} from '../src/game/combat';
import type { CombatEvents } from '../src/game/combatEvents';
import { Aim, Character, Collider, Combatant, Equipment, Faction, Health, Inventory, newCombatant, Projectile, Stamina, Stats, Transform, Velocity } from '../src/game/components';
import { createItem, startingInventory } from '../src/game/equipment';
import { addItem, countItem, createLoadedWeapon, inventoryWeight, takeItem } from '../src/game/items';
import { generateStalker } from '../src/game/npcs';
import { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { VitalsSystem } from '../src/game/systems/VitalsSystem';
import { WeaponSystem } from '../src/game/systems/WeaponSystem';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { Rng } from '../src/core/rng';
import type { EquipmentSave, ItemInstance } from '../src/save/types';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

function fighter(world: World, raceId: string, x: number, y: number, equipment: EquipmentSave, faction: string, inventory: ItemInstance[] = []): Entity {
  const e = world.create();
  const race = content.get('race', raceId);
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: 12, h: 8 });
  world.add(e, Character, { raceId, colors: {}, facing: 'right', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Equipment, equipment);
  world.add(e, Stats, buildCharacterStats(content, race, equipment));
  world.add(e, Health, { hp: 100, bleed: 0, dead: false, sinceHit: 99, regen: [] });
  world.add(e, Stamina, { current: 100, exhausted: false, regenDelay: 0 });
  world.add(e, Combatant, newCombatant(equipment.primary ? 'primary' : equipment.sidearm ? 'sidearm' : null));
  world.add(e, Inventory, inventory);
  world.add(e, Faction, { id: faction });
  world.add(e, Aim, { dir: { x: 1, y: 0 } });
  return e;
}

describe('damage', () => {
  it('reduces damage by resistance minus armor piercing, capped', () => {
    expect(effectiveResist(0.3, 0.1)).toBeCloseTo(0.2);
    expect(effectiveResist(0.2, 0.5)).toBe(0);
    expect(effectiveResist(2, 0)).toBe(MAX_RESIST);
  });

  it('applies resistances from worn armor, wears the piece hit, and causes bleeding', () => {
    const w = new World();
    const vest = createItem('human_military_vest');
    const e = fighter(w, 'human', 0, 0, { torso: vest }, 'a');
    const resist = w.req(e, Stats).get('ballistic_resist');
    expect(resist).toBeCloseTo(0.3);
    const res = applyDamage(w, content, e, { amount: 40, type: 'ballistic', ap: 0.1, attacker: null }, 0.1 /* torso */);
    expect(res.blocked).toBeCloseTo(0.2);
    expect(res.dealt).toBeCloseTo(32);
    expect(w.req(e, Health).hp).toBeCloseTo(68);
    expect(vest.condition).toBeLessThan(1);
    expect(w.req(e, Stats).get('ballistic_resist')).toBeLessThan(resist); // worn armor protects less
    expect(w.req(e, Health).bleed).toBeGreaterThan(0);
  });

  it('kills at zero and ignores further hits; god mode takes nothing', () => {
    const w = new World();
    const e = fighter(w, 'human', 0, 0, {}, 'a');
    expect(applyDamage(w, content, e, { amount: 500, type: 'ballistic', ap: 0, attacker: null }).killed).toBe(true);
    expect(w.req(e, Health).dead).toBe(true);
    expect(applyDamage(w, content, e, { amount: 5, type: 'ballistic', ap: 0, attacker: null }).dealt).toBe(0);
    const g = fighter(w, 'human', 0, 0, {}, 'a');
    w.req(g, Health).god = true;
    applyDamage(w, content, g, { amount: 50, type: 'ballistic', ap: 0, attacker: null });
    expect(w.req(g, Health).hp).toBe(100);
  });
});

describe('geometry', () => {
  it('finds where a segment enters a box', () => {
    const box = { x0: 10, y0: -5, x1: 20, y1: 5 };
    expect(segmentBoxEntry(0, 0, 40, 0, box)).toBeCloseTo(0.25);
    expect(segmentBoxEntry(0, 10, 40, 10, box)).toBeNull();
  });

  it('stops bullets at the first wall even when moving fast', () => {
    const map = testMap();
    for (let y = 8; y < 14; y++) for (let x = 8; x < 20; x++) map.setTile(x, y, x === 15 ? 'metal_wall' : 'metal_floor');
    const y = 10.5 * TILE_PX;
    const f = segmentHitsSolid(map, 9 * TILE_PX, y, 19 * TILE_PX, y)!;
    expect(9 * TILE_PX + f * 10 * TILE_PX).toBeCloseTo(15 * TILE_PX);
    expect(segmentHitsSolid(map, 9 * TILE_PX, y, 14.9 * TILE_PX, y)).toBeNull();
  });

  it('mirrors the muzzle for guns aimed left so they are never upside down', () => {
    const def = content.get('weapon', 'akr5_rifle');
    const right = muzzlePosition(def, 0, 0, 0);
    const left = muzzlePosition(def, 0, 0, Math.PI);
    expect(right.x).toBeGreaterThan(10);
    expect(left.x).toBeLessThan(-10);
    expect(left.y).toBeCloseTo(right.y, 5);
  });
});

function testMap(): TileMap {
  const tiles = new TileSet(content.all('tile'));
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  return new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 1, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
}

describe('weapons', () => {
  const step = (w: World, sys: { update(w: World, dt: number): void }[], n: number, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      for (const s of sys) s.update(w, dt);
      w.flushDestroyed();
    }
  };

  it('fires semi-auto once per trigger pull, and reloads from inventory', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const shots: number[] = [];
    events.on('shot', (s) => shots.push(s.shooter));
    const pistol = createLoadedWeapon(content, 'vz9_pistol');
    const inv: ItemInstance[] = [];
    addItem(content, inv, createItem('ammo_9x19', 20));
    const e = fighter(w, 'human', 100, 100, { sidearm: pistol }, 'a', inv);
    const ws = new WeaponSystem(content, () => null, events);
    const c = w.req(e, Combatant);
    c.trigger = true;
    step(w, [ws], 30); // held for half a second
    expect(shots.length).toBe(1);
    expect(pistol.loaded).toBe(11);
    c.trigger = false;
    step(w, [ws], 1);
    c.trigger = true;
    step(w, [ws], 1);
    expect(shots.length).toBe(2);
    c.trigger = false;
    c.wantReload = true;
    step(w, [ws], Math.ceil(1.5 * 60));
    expect(pistol.loaded).toBe(12);
    expect(countItem(inv, 'ammo_9x19')).toBe(18);
  });

  it('auto fire respects the rate of fire and empties the magazine', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    let shots = 0;
    events.on('shot', () => shots++);
    const rifle = createLoadedWeapon(content, 'akr5_rifle'); // 600 rpm = 10/s
    const e = fighter(w, 'human', 100, 100, { primary: rifle }, 'a');
    const ws = new WeaponSystem(content, () => null, events);
    w.req(e, Combatant).trigger = true;
    step(w, [ws], 60);
    expect(shots).toBeGreaterThanOrEqual(10);
    expect(shots).toBeLessThanOrEqual(11);
    step(w, [ws], 600);
    expect(rifle.loaded).toBe(0);
    expect(shots).toBe(30);
  });

  it('switches ammo type on reload, returning unused rounds', () => {
    const w = new World();
    const rifle = { ...createLoadedWeapon(content, 'akr5_rifle'), loaded: 10 };
    const inv: ItemInstance[] = [];
    addItem(content, inv, createItem('ammo_545x39_ap', 60));
    const e = fighter(w, 'human', 0, 0, { primary: rifle }, 'a', inv);
    const ws = new WeaponSystem(content, () => null, new EventBus());
    w.req(e, Combatant).wantReload = true;
    step(w, [ws], 3 * 60);
    expect(rifle.loadedAmmo).toBe('ammo_545x39_ap');
    expect(rifle.loaded).toBe(30);
    expect(countItem(inv, 'ammo_545x39')).toBe(10);
    expect(countItem(inv, 'ammo_545x39_ap')).toBe(30);
  });

  it('bullets fly, hit hostiles (not allies), and deal damage', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const hits: CombatEvents['hit'][] = [];
    events.on('hit', (h) => hits.push(h));
    const shooter = fighter(w, 'human', 100, 200, { primary: createLoadedWeapon(content, 'longshot_dmr') }, 'player');
    // Same ground level: a level shot at chest height crosses their hurtboxes.
    const ally = fighter(w, 'human', 160, 200, {}, 'player');
    const enemy = fighter(w, 'human', 260, 200, {}, 'bandit');
    const sys = [new WeaponSystem(content, () => null, events), new ProjectileSystem(content, () => null, events)];
    w.req(shooter, Combatant).trigger = true;
    step(w, sys, 30);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.target === enemy)).toBe(true);
    expect(w.req(enemy, Health).hp).toBeLessThan(100);
    expect(w.req(ally, Health).hp).toBe(100);
    expect([...w.query(Projectile)].length).toBe(0);
  });

  it('bleeds out over time and drains stamina while sprinting', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    let deaths = 0;
    events.on('death', () => deaths++);
    const e = fighter(w, 'human', 0, 0, {}, 'a');
    const h = w.req(e, Health);
    h.hp = 3;
    h.bleed = 2;
    w.req(e, Character).sprinting = true;
    const v = new VitalsSystem(events);
    step(w, [v], 120);
    expect(h.dead).toBe(true);
    expect(deaths).toBe(1);
    expect(w.req(e, Stamina).current).toBeLessThan(100);
  });
});

describe('items', () => {
  it('stacks, takes and weighs items', () => {
    const inv: ItemInstance[] = [];
    addItem(content, inv, createItem('ammo_9x19', 50));
    addItem(content, inv, createItem('ammo_9x19', 30)); // tops up to 60, then a new stack of 20
    expect(inv.map((i) => i.count)).toEqual([60, 20]);
    expect(takeItem(inv, 'ammo_9x19', 25)).toBe(25);
    expect(countItem(inv, 'ammo_9x19')).toBe(55);
    addItem(content, inv, createItem('human_military_vest'));
    addItem(content, inv, createItem('human_military_vest'));
    expect(inv.filter((i) => i.defId === 'human_military_vest').length).toBe(2);
    expect(inventoryWeight(content, inv)).toBeCloseTo(55 * 0.012 + 18);
  });

  it('gives each race a usable starting kit', () => {
    for (const race of content.all('race')) {
      const inv = startingInventory(content, race.id);
      expect(inv.length, race.id).toBeGreaterThan(0);
    }
  });

  it('generates NPC Stalkers whose armor fits their race', () => {
    const rng = new Rng(42);
    for (let i = 0; i < 30; i++) {
      const s = generateStalker(content, rng);
      const tag = content.get('race', s.raceId).armorTag;
      for (const slot of ['head', 'torso', 'legs'] as const) {
        const it = s.equipment[slot];
        if (it) expect(content.get('armor', it.defId).fitsRace).toBe(tag);
      }
      expect(s.equipment.sidearm).toBeDefined();
    }
  });
});
