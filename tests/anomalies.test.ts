import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { EventBus } from '../src/core/EventBus';
import { World, type Entity } from '../src/ecs/World';
import { findPath } from '../src/game/ai/pathfinding';
import { HazardMap } from '../src/game/ai/hazards';
import { buildCharacterStats } from '../src/game/characters';
import type { CombatEvents } from '../src/game/combatEvents';
import { Anomaly, Character, Collider, Equipment, Health, Inventory, Stats, Transform, Velocity } from '../src/game/components';
import { useConsumable } from '../src/game/consumables';
import { createItem, equipArtifact, unequipArtifact } from '../src/game/equipment';
import { addRadiation, decayRate, equilibriumDose, sicknessDamage } from '../src/game/radiation';
import { AnomalySystem, BoltSystem, throwBolt } from '../src/game/systems/AnomalySystem';
import { ArtifactSystem } from '../src/game/systems/ArtifactSystem';
import { VitalsSystem } from '../src/game/systems/VitalsSystem';
import { getGenerator } from '../src/game/world/generators';
import { planetPlan } from '../src/game/world/planetGenerator';
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

function person(world: World, x: number, y: number): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: 12, h: 8 });
  world.add(e, Character, { raceId: 'human', colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Equipment, {});
  world.add(e, Stats, buildCharacterStats(content, content.get('race', 'human'), {}));
  world.add(e, Health, { hp: 100, bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
  world.add(e, Inventory, []);
  return e;
}

function anomaly(world: World, defId: string, x: number, y: number): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Anomaly, { defId, state: 'idle', timer: 0, sinceBurst: 99 });
  return e;
}

/** An open test map (the test range's open ground around x 20..40, y 6). */
function testMap(): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  return new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
}

function run(world: World, systems: { update(w: World, dt: number): void }[], seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 60) for (const s of systems) s.update(world, 1 / 60);
}

describe('anomalies', () => {
  it('a burner goes off after its wind-up when someone steps in, then rests', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    const phases: string[] = [];
    events.on('anomaly', (a) => phases.push(a.phase));
    const sys = new AnomalySystem(content, () => null, events);
    const a = anomaly(w, 'burner', 500, 500);
    const p = person(w, 500 + 10, 500);
    run(w, [sys], 0.1);
    expect(phases).toEqual(['trigger']);
    expect(w.req(p, Health).hp).toBe(100); // still winding up: time to jump back
    run(w, [sys], 0.4);
    expect(phases).toEqual(['trigger', 'burst']);
    expect(w.req(p, Health).hp).toBeLessThan(80);
    expect(w.req(p, Health).cause).toMatch(/burner/);
    expect(w.req(a, Anomaly).state).toBe('cooldown');
  });

  it('thermal resistance blunts a burner', () => {
    const w = new World();
    const sys = new AnomalySystem(content, () => null, new EventBus<CombatEvents>());
    anomaly(w, 'burner', 500, 500);
    const bare = person(w, 505, 500);
    const proof = person(w, 495, 500);
    equipArtifact(w, content, proof, createItem('fireball'));
    run(w, [sys], 0.5);
    expect(100 - w.req(proof, Health).hp).toBeLessThan((100 - w.req(bare, Health).hp) * 0.8);
  });

  it('a thrown bolt sets it off with nobody near', () => {
    const w = new World();
    const map = testMap();
    const phases: string[] = [];
    const events = new EventBus<CombatEvents>();
    events.on('anomaly', (a) => phases.push(a.phase));
    const anomalies = new AnomalySystem(content, () => map, events);
    const bolts = new BoltSystem(() => map, events);
    const x = 30 * TILE_PX;
    const y = 6 * TILE_PX;
    anomaly(w, 'electro', x, y);
    throwBolt(w, x - 150, y, x, y);
    run(w, [bolts, anomalies], 1.2);
    expect(phases).toContain('burst');
  });

  it('a vortex drags people toward its center', () => {
    const w = new World();
    const sys = new AnomalySystem(content, () => null, new EventBus<CombatEvents>());
    anomaly(w, 'vortex', 500, 500);
    const p = person(w, 540, 500);
    sys.update(w, 1 / 60);
    expect(w.req(p, Velocity).x).toBeLessThan(0);
  });

  it('acid hurts over time, in a few chunky hits rather than every frame', () => {
    const w = new World();
    const events = new EventBus<CombatEvents>();
    let hits = 0;
    events.on('hit', () => hits++);
    const sys = new AnomalySystem(content, () => null, events);
    anomaly(w, 'acid_pool', 500, 500);
    const p = person(w, 500, 500);
    run(w, [sys], 2);
    expect(w.req(p, Health).hp).toBeLessThan(90);
    expect(hits).toBeGreaterThan(2);
    expect(hits).toBeLessThan(8);
  });
});

describe('radiation', () => {
  it('builds up in a hot spot, resisted by radiation resistance', () => {
    const w = new World();
    const sys = new AnomalySystem(content, () => null, new EventBus<CombatEvents>());
    anomaly(w, 'hot_spot', 500, 500);
    const p = person(w, 500, 500);
    run(w, [sys], 2);
    const dose = w.req(p, Health).rads;
    expect(dose).toBeGreaterThan(50);
    const resist = w.req(p, Stats).get('radiation_resist');
    expect(dose).toBeCloseTo(45 * 2 * (1 - resist), -1);
  });

  it('makes you sick above the safe dose and clears slowly; anti-rad flushes it', () => {
    expect(sicknessDamage(20)).toBe(0);
    expect(sicknessDamage(130)).toBeGreaterThan(1);
    const w = new World();
    const vitals = new VitalsSystem(new EventBus<CombatEvents>());
    const p = person(w, 0, 0);
    w.req(p, Health).rads = 200;
    run(w, [vitals], 5);
    const h = w.req(p, Health);
    expect(h.hp).toBeLessThan(95);
    expect(h.rads).toBeLessThan(200);
    expect(h.rads).toBeGreaterThan(150);
    useConsumable(w, content, p, createItem('anti_rad'));
    expect(h.rads).toBeLessThan(10);
  });

  it('a steady source settles at a predictable dose', () => {
    let rads = 0;
    for (let t = 0; t < 2000; t++) rads += 1.2 - decayRate(rads);
    expect(rads).toBeCloseTo(equilibriumDose(1.2), 0);
  });

  it('god mode takes none', () => {
    const w = new World();
    const p = person(w, 0, 0);
    w.req(p, Health).god = true;
    expect(addRadiation(w, p, 100)).toBe(0);
  });
});

describe('artifacts', () => {
  it('give their bonuses on the belt and take them back off', () => {
    const w = new World();
    const p = person(w, 0, 0);
    const stats = w.req(p, Stats);
    const before = stats.get('carry_weight');
    const gravi = createItem('gravi');
    expect(equipArtifact(w, content, p, gravi).ok).toBe(true);
    expect(w.req(p, Equipment).belt1).toBe(gravi);
    expect(stats.get('carry_weight')).toBe(before + 12);
    // A second goes in the next free slot.
    equipArtifact(w, content, p, createItem('flash'));
    expect(w.req(p, Equipment).belt2?.defId).toBe('flash');
    expect(unequipArtifact(w, p, 'belt1')).toBe(gravi);
    expect(stats.get('carry_weight')).toBe(before);
  });

  it('irradiate (or cleanse) and heal the wearer', () => {
    const w = new World();
    const sys = new ArtifactSystem(content);
    const p = person(w, 0, 0);
    w.req(p, Health).hp = 50;
    equipArtifact(w, content, p, createItem('soul'));
    run(w, [sys], 4);
    expect(w.req(p, Health).hp).toBeGreaterThan(52);
    expect(w.req(p, Health).rads).toBeGreaterThan(5);
    unequipArtifact(w, p, 'belt1');
    equipArtifact(w, content, p, createItem('pellicle'));
    const r = w.req(p, Health).rads;
    run(w, [sys], 2);
    expect(w.req(p, Health).rads).toBeLessThan(r);
  });
});

describe('anomaly fields on planets', () => {
  it('keeps fields off roads, out of places and away from the start, with artifacts inside their hosts', () => {
    const def = content.get('worldGen', 'zone_north');
    const gen = getGenerator(def.generator);
    const params = gen.parseParams(def.params, tiles, content);
    const W = def.widthChunks * 16;
    const plan = planetPlan(params, 777, W, W);
    expect(plan.fields.length).toBeGreaterThan(8);
    expect(plan.strays.length).toBeGreaterThan(20);
    const start = plan.placed[0]!;
    let artifacts = 0;
    for (const f of plan.fields) {
      for (const m of f.members) {
        const k = Math.floor(m.y) * W + Math.floor(m.x);
        expect(plan.roadDist[k]!).toBeGreaterThan(2);
        expect(Math.hypot(m.x - (start.x + start.w / 2), m.y - (start.y + start.h / 2))).toBeGreaterThan(30);
        for (const q of plan.placed) expect(m.x > q.x && m.x < q.x + q.w && m.y > q.y && m.y < q.y + q.h, q.s.def.id).toBe(false);
      }
      for (const a of f.artifacts) {
        artifacts++;
        const art = content.get('artifact', a.id);
        const host = f.members.find((m) => art.spawnsIn.includes(m.id) && Math.hypot(m.x - a.x, m.y - a.y) <= content.get('anomaly', m.id).radius);
        expect(host, `${a.id} in a matching anomaly`).toBeDefined();
      }
    }
    expect(artifacts).toBeGreaterThan(3);
    expect(gen.landmarks!(777, params, W, W).some((l) => l.hazard)).toBe(true);
  });
});

describe('NPC pathing around anomalies', () => {
  it('walks around a known hazard instead of through it', () => {
    const map = testMap();
    const hz = new HazardMap();
    const y = 5.5 * TILE_PX;
    hz.add(1, 30 * TILE_PX, y, TILE_PX * 1.5);
    const from = { x: 24 * TILE_PX, y };
    const to = { x: 36 * TILE_PX, y };
    const path = findPath(map, from, to, 4000, (tx, ty) => hz.has(tx, ty));
    expect(path).not.toBeNull();
    let prev = from;
    for (const p of path!) {
      for (let i = 0; i <= 16; i++) {
        const x = prev.x + ((p.x - prev.x) * i) / 16;
        const yy = prev.y + ((p.y - prev.y) * i) / 16;
        expect(hz.has(Math.floor(x / TILE_PX), Math.floor(yy / TILE_PX))).toBe(false);
      }
      prev = p;
    }
    hz.remove(1);
    expect(hz.has(30, 5)).toBe(false);
  });
});
