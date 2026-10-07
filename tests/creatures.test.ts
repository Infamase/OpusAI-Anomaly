import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { EventBus } from '../src/core/EventBus';
import { Rng } from '../src/core/rng';
import { World, type Entity } from '../src/ecs/World';
import { CreatureBrainSystem, SpitSystem } from '../src/game/ai/CreatureBrainSystem';
import { buildCharacterStats } from '../src/game/characters';
import type { CombatEvents } from '../src/game/combatEvents';
import { Character, Collider, Combatant, Container, Creature, CreatureBrain, Equipment, Faction, Health, Inventory, Projectile, Spit, Stats, Transform, Velocity, newCombatant } from '../src/game/components';
import { defaultStanding, PLAYER_FACTION, Relations } from '../src/game/factions';
import { aimHeight, hurtbox } from '../src/game/combat';
import { lairEpoch, spawnCreature, Wildlife, WILDLIFE_KEY } from '../src/game/wildlife';
import { MovementSystem } from '../src/game/systems/MovementSystem';
import { ProjectileSystem } from '../src/game/systems/ProjectileSystem';
import { VitalsSystem } from '../src/game/systems/VitalsSystem';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import '../src/game/world/planetGenerator';
import '../src/game/world/interiorGenerator';
import { TILE_PX, TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { creatureModel, paintCreature, poseCreature, type CreaturePose } from '../src/render/creatureBody';
import { CreatureView } from '../src/render/CreatureView';
import { WorldDeltas } from '../src/save/WorldDeltas';

const T = TILE_PX;
let content: ContentRegistry;
let tiles: TileSet;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
  tiles = new TileSet(content.all('tile'));
  CreatureView.enabled = false;
});

/** Open floor (x/y 2..61) walled round. */
function field(): TileMap {
  const def = content.get('worldGen', 'test_range');
  const gen = getGenerator(def.generator);
  const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 3, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  for (let y = 1; y <= 62; y++) for (let x = 1; x <= 62; x++) map.setTile(x, y, x === 1 || y === 1 || x === 62 || y === 62 ? 'lab_wall' : 'lab_tiles');
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
  world.add(e, Combatant, newCombatant(null));
  world.add(e, Faction, { id: faction });
  return e;
}

function setup(seed = 1) {
  const map = field();
  const world = new World();
  const events = new EventBus<CombatEvents>();
  const relations = new Relations(content, defaultStanding());
  const rng = new Rng(seed);
  const brain = new CreatureBrainSystem(content, () => map, events, relations, () => rng.next());
  world.addSystem(brain).addSystem(new MovementSystem(() => map)).addSystem(new ProjectileSystem(content, () => map, events)).addSystem(new SpitSystem(content, () => map, events, relations)).addSystem(new VitalsSystem(events));
  const deaths: Entity[] = [];
  events.on('death', (d) => deaths.push(d.entity));
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      each?.();
      world.update(1 / 30);
      world.flushDestroyed();
    }
  };
  const beast = (id: string, x: number, y: number, lair = 'pack', i = 0) =>
    spawnCreature(world, content, content.get('creature', id), { id: `${lair}:${i}@0`, lairId: lair, x, y, radius: 4 * T }, false, () => rng.next());
  return { map, world, events, relations, brain, run, beast, deaths, rng };
}

const hp = (world: World, e: Entity) => world.req(e, Health).hp;
const dist = (world: World, a: Entity, b: Entity) => Math.hypot(world.req(a, Transform).x - world.req(b, Transform).x, world.req(a, Transform).y - world.req(b, Transform).y);

describe('creature art', () => {
  it('every creature paints, in every direction and pose, without gaps or blow-ups', () => {
    for (const def of content.all('creature')) {
      const m = creatureModel(def);
      const poses: Partial<CreaturePose>[] = [
        { heading: 0 },
        { heading: Math.PI / 2, gait: 2, phase: 0.3 },
        { heading: -2, action: 'windup', actionT: 0.8, attack: def.attacks[0]?.kind },
        { heading: 1, action: 'strike', actionT: 0.5, attack: def.attacks[0]?.kind },
        { heading: 3, action: 'rest' },
        { heading: 0.5, dead: true },
      ];
      for (const p of poses) {
        const pose: CreaturePose = { heading: 0, gait: 0, phase: 0, time: 1, action: 'none', actionT: 0, ...p };
        const f = paintCreature(m, poseCreature(m, pose), pose.heading, pose.dead);
        let opaque = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        for (let y = 0; y < f.canvas.height; y++) {
          for (let x = 0; x < f.canvas.width; x++) {
            if (!f.canvas.alpha(x, y)) continue;
            opaque++;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
          }
        }
        expect(opaque, `${def.id} ${JSON.stringify(p)}`).toBeGreaterThan(20);
        // Stays inside its canvas (nothing clipped at the edges).
        expect(minX, `${def.id} left edge`).toBeGreaterThan(0);
        expect(maxX, `${def.id} right edge`).toBeLessThan(f.canvas.width - 1);
      }
    }
  });

  it('glowing eyes are reported for the dark', () => {
    const m = creatureModel(content.get('creature', 'prowler'));
    const f = paintCreature(m, poseCreature(m, { heading: Math.PI / 2, gait: 0, phase: 0, time: 0, action: 'none', actionT: 0 }), Math.PI / 2);
    expect(f.glow.length).toBeGreaterThan(0);
  });
});

describe('creature behaviour', () => {
  it('a hound pack hunts down a stalker, circling and darting in', () => {
    const { world, run, beast } = setup();
    const victim = person(world, 30 * T, 30 * T);
    // Blind: they find a stalker standing still by smell, so start close.
    const pack = [0, 1, 2].map((i) => beast('blind_hound', 25 * T, (28 + i) * T, 'pack', i));
    let engaged = 0;
    run(8, () => {
      engaged = Math.max(engaged, pack.filter((h) => world.req(h, CreatureBrain).target === victim).length);
    });
    expect(hp(world, victim)).toBeLessThan(80);
    expect(engaged).toBe(3);
  });

  it('blind hounds do not see a stalker standing still out of earshot, but smell one close by', () => {
    const { world, run, beast } = setup();
    const victim = person(world, 40 * T, 30 * T);
    const h = beast('blind_hound', 30 * T, 30 * T);
    world.req(h, Creature).heading = 0;
    run(2);
    expect(world.req(h, CreatureBrain).target).toBeNull();
    world.req(victim, Transform).x = 33 * T;
    run(1);
    expect(world.req(h, CreatureBrain).target).toBe(victim);
  });

  it('grazers bolt from gunfire, and the herd goes with them', () => {
    const { world, events, run, beast } = setup();
    const herd = [0, 1, 2].map((i) => beast('loper', (30 + i) * T, 30 * T, 'herd', i));
    run(0.5);
    const shooter = person(world, 22 * T, 30 * T);
    events.emit('shot', { shooter, x: 22 * T, y: 30 * T, angle: 0, weaponId: 'vz9_pistol', recoil: 0 });
    run(2);
    for (const l of herd) {
      expect(world.req(l, CreatureBrain).state).toBe('flee');
      expect(world.req(l, Transform).x).toBeGreaterThan(31 * T);
    }
    expect(hp(world, shooter)).toBe(100);
  });

  it('a territorial tusker warns at a distance and charges anyone who comes inside its territory', () => {
    const { world, run, beast } = setup();
    const t = beast('tusker', 30 * T, 30 * T);
    world.req(t, Creature).heading = 0;
    const walker = person(world, 30 * T + 215, 30 * T, 'loners');
    run(2);
    expect(world.req(t, CreatureBrain).state).toBe('alert');
    expect(hp(world, walker)).toBe(100);
    world.req(walker, Transform).x = 30 * T + 120;
    let charged = false;
    run(4, () => {
      const a = world.req(t, CreatureBrain).attack;
      if (a && content.get('creature', 'tusker').attacks[a.index]!.kind === 'charge') charged = true;
    });
    expect(charged || hp(world, walker) < 100).toBe(true);
    expect(hp(world, walker)).toBeLessThan(100);
  });

  it('a crawler pounces from range', () => {
    const { world, run, beast } = setup();
    const c = beast('crawler', 25 * T, 30 * T);
    world.req(c, Creature).heading = 0;
    const victim = person(world, 25 * T + 150, 30 * T);
    let leapt = false;
    let peak = 0;
    run(4, () => {
      const b = world.req(c, CreatureBrain);
      if (b.attack?.phase === 'strike' && content.get('creature', 'crawler').attacks[b.attack.index]!.kind === 'leap') leapt = true;
      peak = Math.max(peak, b.lift);
    });
    expect(leapt).toBe(true);
    expect(peak).toBeGreaterThan(10);
    expect(hp(world, victim)).toBeLessThan(100);
  });

  it('a spitter lobs acid that splashes where its target was; stepping aside dodges it', () => {
    const { world, events, run, beast } = setup();
    const sp = beast('spitter', 20 * T, 30 * T);
    world.req(sp, Creature).heading = 0;
    // Anyone inside its territory is fair game; stand still and get hit.
    const victim = person(world, 20 * T + 220, 30 * T);
    const splashes: { x: number; y: number }[] = [];
    events.on('splash', (s) => splashes.push(s));
    run(5);
    expect(splashes.length).toBeGreaterThan(0);
    expect(hp(world, victim)).toBeLessThan(100);
    // A second victim who sidesteps as soon as a glob is in the air.
    const { world: w2, run: run2, beast: beast2 } = setup(4);
    const sp2 = beast2('spitter', 20 * T, 30 * T);
    w2.req(sp2, Creature).heading = 0;
    const dodger = person(w2, 20 * T + 220, 30 * T);
    let moved = false;
    run2(4, () => {
      if (!moved && [...w2.query(Spit)].length) {
        w2.req(dodger, Transform).y += 3 * T;
        moved = true;
      }
    });
    expect(moved).toBe(true);
    expect(hp(w2, dodger)).toBe(100);
  });

  it('a sandmaw moves unseen under the ground, where bullets can\'t reach it, and surfaces to bite', () => {
    const { world, run, beast } = setup();
    const s = beast('sandmaw', 30 * T, 30 * T);
    run(0.2);
    expect(world.req(s, Creature).hidden).toBe(true);
    // A bullet passes straight over it.
    const b = world.create();
    world.add(b, Transform, { x: 26 * T, y: 30 * T - 4, prevX: 26 * T, prevY: 30 * T - 4 });
    world.add(b, Projectile, { owner: 0, faction: 'loners', damage: 30, ap: 0, type: 'ballistic', vx: 900, vy: 0, travelled: 0, range: 600 });
    run(0.3);
    expect(hp(world, s)).toBe(content.get('creature', 'sandmaw').health);
    const victim = person(world, 30 * T + 70, 30 * T);
    let surfaced = false;
    run(5, () => {
      if (!world.req(s, Creature).hidden) surfaced = true;
    });
    expect(surfaced).toBe(true);
    expect(hp(world, victim)).toBeLessThan(100);
  });

  it('a shade is all but invisible until it strikes, and feeds on what it bites', () => {
    const { world, run, beast } = setup();
    const sh = beast('shade', 30 * T, 30 * T);
    run(1);
    expect(world.req(sh, Creature).visibility).toBeLessThan(0.3);
    const victim = person(world, 30 * T + 90, 30 * T);
    world.req(sh, Health).hp = 100;
    let seen = 0;
    run(6, () => {
      seen = Math.max(seen, world.req(sh, Creature).visibility);
    });
    expect(hp(world, victim)).toBeLessThan(100);
    expect(seen).toBeGreaterThan(0.6);
  });

  it('hurt creatures run, and a pack that loses most of its members breaks', () => {
    const { world, run, beast, events } = setup();
    const pack = [0, 1, 2, 3].map((i) => beast('blind_hound', 30 * T, (28 + i) * T, 'pack', i));
    const hunter = person(world, 40 * T, 30 * T);
    run(0.5);
    for (const h of pack.slice(0, 2)) {
      world.req(h, Health).hp = 0;
      world.req(h, Health).dead = true;
      events.emit('death', { entity: h, killer: hunter });
    }
    run(1);
    for (const h of pack.slice(2)) expect(world.req(h, CreatureBrain).state).toBe('flee');
  });

  it('fight each other: hounds go after a grazer herd', () => {
    const { world, run, beast } = setup();
    const loper = beast('loper', 34 * T, 30 * T, 'herd');
    const hound = beast('blind_hound', 30 * T, 30 * T, 'pack');
    run(6);
    expect(world.req(hound, CreatureBrain).target).toBe(loper);
    expect(world.req(loper, CreatureBrain).state).toBe('flee');
  });
});

describe('wildlife', () => {
  function planet(seed: number) {
    const def = content.get('worldGen', 'zone_north');
    const gen = getGenerator(def.generator);
    const params = gen.parseParams(def.params, tiles, content);
    const deltas = new WorldDeltas('zone_north');
    const map = new TileMap({ tiles, generator: gen, params, seed, widthChunks: def.widthChunks, heightChunks: def.heightChunks, deltas });
    const lairs = gen.lairs!(seed, params, map.widthTiles, map.heightTiles, (x, y) => !map.isSolid(x, y));
    return { gen, params, map, deltas, lairs };
  }

  it('dens are spread over the planet by biome, away from the start, the same every time', () => {
    const a = planet(777);
    const b = planet(777);
    expect(a.lairs).toEqual(b.lairs);
    expect(a.lairs.length).toBeGreaterThan(40);
    const kinds = new Set(a.lairs.map((l) => l.creature));
    expect(kinds.size).toBeGreaterThanOrEqual(8);
    const s = a.gen.spawnPoint(777, a.params, a.map.widthTiles, a.map.heightTiles);
    for (const l of a.lairs) expect(Math.hypot(l.x / T - s.x, l.y / T - s.y)).toBeGreaterThan(25);
    for (const l of a.lairs) {
      const def = content.get('creature', l.creature);
      expect(l.count).toBeGreaterThanOrEqual(def.pack[0]);
      expect(l.count).toBeLessThanOrEqual(def.pack[1]);
    }
  });

  it('interiors have nests in fitting rooms', () => {
    for (const id of ['underground_lab', 'derelict_freighter']) {
      const def = content.get('worldGen', id);
      const gen = getGenerator(def.generator);
      const params = gen.parseParams(def.params, tiles, content);
      const map = new TileMap({ tiles, generator: gen, params, seed: 5, widthChunks: def.widthChunks, heightChunks: def.heightChunks, deltas: new WorldDeltas(id) });
      const lairs = gen.lairs!(5, params, map.widthTiles, map.heightTiles, (x, y) => !map.isSolid(x, y));
      expect(lairs.length, id).toBeGreaterThan(0);
      for (const l of lairs) expect(map.isSolid(Math.floor(l.x / T), Math.floor(l.y / T))).toBe(false);
    }
  });

  it('creatures appear as you come near their den, leave when you go, stay dead for a few days, then return', () => {
    const { map, deltas, lairs } = planet(777);
    const world = new World();
    const w = new Wildlife(world, content, deltas, map, 777, () => {}, () => {});
    w.setLairs(lairs);
    const lair = lairs[0]!;
    w.update(0, lair.x + 2000, lair.y + 2000, 0, true);
    expect([...world.query(Creature)].filter((e) => world.req(e, Creature).lairId === lair.id).length).toBe(0);
    w.update(0, lair.x + 100, lair.y, 0, true);
    const members = [...world.query(Creature)].filter((e) => world.req(e, Creature).lairId === lair.id);
    expect(members.length).toBe(lair.count);
    // Kill one: its carcass holds parts, and it stays dead this epoch.
    const victim = members[0]!;
    world.req(victim, Health).dead = true;
    w.onDeath(victim, 0);
    expect(deltas.get(WILDLIFE_KEY)?.removed).toContain(world.req(victim, Creature).id);
    expect(world.get(victim, Container)?.label).toMatch(/carcass/);
    // Walk away and back: one fewer.
    w.update(0, lair.x + 5000, lair.y, 0, true);
    world.flushDestroyed();
    w.update(0, lair.x + 100, lair.y, 0, true);
    const again = [...world.query(Creature, Health)].filter((e) => world.req(e, Creature).lairId === lair.id && !world.req(e, Health).dead);
    expect(again.length).toBe(lair.count - 1);
    // Days later the den is full again.
    const later = 1440 * 4;
    expect(lairEpoch(lair.id, later)).toBeGreaterThan(lairEpoch(lair.id, 0));
    w.update(0, lair.x + 5000, lair.y, later, true);
    world.flushDestroyed();
    w.update(0, lair.x + 100, lair.y, later, true);
    const refilled = [...world.query(Creature, Health)].filter((e) => world.req(e, Creature).lairId === lair.id && !world.req(e, Health).dead);
    expect(refilled.length).toBe(lair.count);
  });

  it('carcasses keep their remaining parts, and rot away once the den refills', () => {
    const { map, deltas, lairs } = planet(31337);
    const world = new World();
    const w = new Wildlife(world, content, deltas, map, 31337, () => {}, () => {});
    w.setLairs(lairs);
    const lair = lairs.find((l) => content.get('creature', l.creature).parts.length)!;
    w.update(0, lair.x, lair.y, 0, true);
    const e = [...world.query(Creature)].find((x) => world.req(x, Creature).lairId === lair.id)!;
    world.req(e, Health).dead = true;
    w.onDeath(e, 0);
    const items = world.req(e, Container).items!;
    const n = items.length;
    const world2 = new World();
    const w2 = new Wildlife(world2, content, deltas, map, 31337, () => {}, () => {});
    expect(w2.restoreCarcasses(10).length).toBe(1);
    expect(world2.req([...world2.query(Container)][0]!, Container).items!.length).toBe(n);
    const world3 = new World();
    const w3 = new Wildlife(world3, content, deltas, map, 31337, () => {}, () => {});
    expect(w3.restoreCarcasses(1440 * 7).length).toBe(0);
  });
});

describe('who fights whom', () => {
  it('mutants and predators are everyone\'s enemy; wildlife is left alone; husks and mutants ignore each other', () => {
    const r = new Relations(content, defaultStanding());
    expect(r.factionAttitude('mutants', 'loners')).toBe('hostile');
    expect(r.factionAttitude('mutants', 'bandits')).toBe('hostile');
    expect(r.factionAttitude('predators', 'fauna')).toBe('hostile');
    expect(r.factionAttitude('fauna', 'loners')).toBe('neutral');
    expect(r.factionAttitude('fauna', PLAYER_FACTION)).toBe('neutral');
    expect(r.factionAttitude('husks', 'mutants')).toBe('neutral');
    expect(r.factionAttitude('husks', PLAYER_FACTION)).toBe('hostile');
  });

  it('shooting a grazer makes the herd hold it against you, without costing reputation', () => {
    const { world, events, relations, beast, run } = setup();
    const l = beast('loper', 30 * T, 30 * T, 'herd', 0);
    const l2 = beast('loper', 31 * T, 30 * T, 'herd', 1);
    const shooter = person(world, 20 * T, 30 * T, PLAYER_FACTION);
    run(0.05);
    events.emit('hit', { target: l, attacker: shooter, x: 0, y: 0, angle: 0, dealt: 10, blocked: 0, killed: false });
    expect(relations.hostile(world, l2, shooter)).toBe(true);
    expect(relations.standing.reputation.fauna ?? 0).toBe(0);
  });

  it('low creatures can be hit where they are drawn, and are aimed at mid-body', () => {
    const { world, beast } = setup();
    const s = beast('skitter', 30 * T, 30 * T);
    const box = hurtbox(world, s)!;
    expect(box.y0).toBeGreaterThan(30 * T - 20);
    expect(box.y1).toBeGreaterThan(30 * T + 3);
    expect(aimHeight(world, s)).toBeLessThan(8);
    const p = person(world, 20 * T, 30 * T);
    expect(aimHeight(world, p)).toBeCloseTo(15.5);
  });
});

describe('husks', () => {
  it('are stalkers with burnt-out minds: grey, shambling, never hiding', () => {
    const t = content.get('npcTemplate', 'husk');
    expect(t.mind).toBe('husk');
    expect(t.faction).toBe('husks');
    expect(t.tint).toBeDefined();
    expect(content.get('npcTemplate', 'loner_rookie').mind).toBe('stalker');
  });
});
