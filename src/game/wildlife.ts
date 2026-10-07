import { deriveSeed, hashString, Rng } from '../core/rng';
import type { ContentRegistry } from '../content/Registry';
import type { CreatureDef } from '../content/types/creature';
import type { Entity, World } from '../ecs/World';
import { CreatureView } from '../render/CreatureView';
import { creatureModel } from '../render/creatureBody';
import type { ItemInstance } from '../save/types';
import { chunkKey, type WorldDeltas } from '../save/WorldDeltas';
import { StatBlock } from '../stats/Stats';
import { resistStat } from '../content/types/weapon';
import { nearestWalkable } from './ai/pathfinding';
import {
  Character,
  Collider,
  Container,
  Creature,
  CreatureBrain,
  CreatureViewC,
  Faction,
  Health,
  Stats,
  Transform,
  Velocity,
  type CreatureBrain as CreatureBrainT,
} from './components';
import { createItem } from './equipment';
import { addItem } from './items';
import type { LairSpawn } from './world/generators';
import { TILE_PX, type TileMap } from './world/TileMap';

/** Chunk-delta key holding the ids of creatures killed (per respawn epoch). */
export const WILDLIFE_KEY = 'wildlife';
/** World entity record kind for a creature carcass (data: CarcassData). */
export const CARCASS_KIND = 'carcass';
/** Game days before a cleared lair fills up again. */
export const RESPAWN_DAYS = 3;
/** Creatures appear when you come this close to their lair, and go (if left alone) beyond the second. */
const SPAWN_RADIUS = 30 * TILE_PX;
const DESPAWN_RADIUS = 40 * TILE_PX;

export interface CarcassData {
  defId: string;
  heading: number;
  epoch: number;
  lairId: string;
  items: ItemInstance[];
}

/** Which respawn epoch a lair is in (staggered per lair so they don't all refill at once). */
export function lairEpoch(lairId: string, clockMinutes: number): number {
  const day = clockMinutes / 1440;
  return Math.floor((day + (hashString(lairId) % 1000) / (1000 / RESPAWN_DAYS)) / RESPAWN_DAYS);
}

/** How tall it stands (for the area bullets can hit). */
export function creatureHeight(def: CreatureDef): number {
  const m = creatureModel(def);
  switch (m.plan) {
    case 'biped':
      return Math.round(m.hipH + m.L * Math.cos(m.hunch * Math.PI * 0.45) + m.headR);
    case 'serpent':
      return Math.round(m.headR * 2.4);
    default:
      return Math.round(Math.max(m.hipH + m.hipR, m.shoulderH + m.chestR * 0.6));
  }
}

export function buildCreatureStats(content: ContentRegistry, def: CreatureDef): StatBlock {
  const stats = new StatBlock(new Map(content.all('stat').map((d) => [d.id, d])));
  stats.setBase('max_health', def.health);
  stats.setBase('move_speed', def.speed.walk);
  for (const [type, v] of Object.entries(def.resist)) stats.setBase(resistStat(type as Parameters<typeof resistStat>[0]), v);
  return stats;
}

export interface SpawnCreatureOptions {
  id: string;
  lairId: string;
  x: number;
  y: number;
  heading?: number;
  homeX?: number;
  homeY?: number;
  radius?: number;
  hp?: number;
}

export function newCreatureBrain(def: CreatureDef, x: number, y: number, radius: number, rand: () => number): CreatureBrainT {
  return {
    state: 'wander',
    stateTime: 0,
    homeX: x,
    homeY: y,
    radius,
    target: null,
    lastSeenX: x,
    lastSeenY: y,
    sinceSeen: 99,
    threatX: x,
    threatY: y,
    goal: null,
    path: [],
    repathIn: 0,
    stuckFor: 0,
    thinkIn: rand() * 0.3,
    waitLeft: rand() * 4,
    cooldowns: def.attacks.map((a) => a.cooldown * rand() * 0.5),
    attack: null,
    orbit: rand() < 0.5 ? 1 : -1,
    voiceIn: 3 + rand() * 10,
    lift: 0,
    buried: def.abilities.burrow ? 1 : 0,
    revealed: 0,
    sinceHurt: 99,
  };
}

/** Makes one creature (with a view when `view` is set). Behaviour comes from its CreatureBrain. */
export function spawnCreature(world: World, content: ContentRegistry, def: CreatureDef, o: SpawnCreatureOptions, view = true, rand: () => number = Math.random): Entity {
  const e = world.create();
  const heading = o.heading ?? rand() * Math.PI * 2;
  world.add(e, Transform, { x: o.x, y: o.y, prevX: o.x, prevY: o.y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: def.hitbox.w, h: def.hitbox.h, tall: creatureHeight(def) });
  // A Character so hazards (anomalies, fire, mines, blasts) treat it like anyone else.
  world.add(e, Character, { raceId: `creature:${def.id}`, colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Stats, buildCreatureStats(content, def));
  world.add(e, Health, { hp: Math.min(def.health, o.hp ?? def.health), bleed: 0, dead: false, sinceHit: 99, regen: [], rads: 0 });
  world.add(e, Faction, { id: def.faction });
  world.add(e, Creature, { defId: def.id, id: o.id, lairId: o.lairId, heading, grudges: new Set(), visibility: def.abilities.cloak ? 0.1 : 1, hidden: def.abilities.burrow });
  world.add(e, CreatureBrain, newCreatureBrain(def, o.homeX ?? o.x, o.homeY ?? o.y, o.radius ?? 5 * TILE_PX, rand));
  if (view) {
    const v = new CreatureView(def);
    v.setPosition(o.x, o.y);
    world.add(e, CreatureViewC, v);
  }
  return e;
}

/**
 * The wildlife of one world: dens from the generator, filled with creatures
 * when the player comes near and emptied (keeping them alive) when they leave.
 * Kills are saved per respawn epoch, so a cleared lair stays empty for a few
 * days and then fills up again. Carcasses keep whatever parts are left on them.
 */
export class Wildlife {
  private lairs: LairSpawn[] = [];
  /** Live creatures per lair id. */
  private spawned = new Map<string, Entity[]>();
  private checkIn = 0;

  constructor(
    private world: World,
    private content: ContentRegistry,
    private deltas: WorldDeltas,
    private map: TileMap,
    private seed: number,
    /** Adds a creature's view to the scene. */
    private show: (e: Entity) => void,
    /** Removes a creature's view. */
    private hide: (e: Entity) => void,
  ) {}

  setLairs(lairs: LairSpawn[]): void {
    this.lairs = lairs.filter((l) => this.content.has('creature', l.creature));
  }

  get allLairs(): readonly LairSpawn[] {
    return this.lairs;
  }

  isDead(id: string): boolean {
    return this.deltas.get(WILDLIFE_KEY)?.removed.includes(id) ?? false;
  }

  /** Spawns lairs the player has come near; lets go of those far behind. */
  update(dt: number, px: number, py: number, clock: number, force = false): void {
    this.checkIn -= dt;
    if (this.checkIn > 0 && !force) return;
    this.checkIn = 0.5;
    for (const lair of this.lairs) {
      const d = Math.hypot(lair.x - px, lair.y - py);
      const live = this.spawned.get(lair.id);
      if (!live && d < SPAWN_RADIUS) this.spawnLair(lair, clock);
      else if (live && d > DESPAWN_RADIUS) this.despawnLair(lair, px, py);
    }
  }

  /** Every member of every lair, now (interiors are small enough). */
  spawnAll(clock: number): void {
    for (const lair of this.lairs) if (!this.spawned.has(lair.id)) this.spawnLair(lair, clock);
  }

  private spawnLair(lair: LairSpawn, clock: number): void {
    const def = this.content.get('creature', lair.creature);
    const epoch = lairEpoch(lair.id, clock);
    const out: Entity[] = [];
    for (let i = 0; i < lair.count; i++) {
      const id = `${lair.id}:${i}@${epoch}`;
      if (this.isDead(id)) continue;
      const rng = new Rng(deriveSeed(this.seed, 'creature', hashString(id)));
      const spot = this.spotNear(lair.x, lair.y, Math.min(lair.radius, 3 * TILE_PX), rng);
      if (!spot) continue;
      const e = spawnCreature(this.world, this.content, def, { id, lairId: lair.id, x: spot.x, y: spot.y, homeX: lair.x, homeY: lair.y, radius: lair.radius }, true, () => rng.next());
      this.show(e);
      out.push(e);
    }
    this.spawned.set(lair.id, out);
  }

  private despawnLair(lair: LairSpawn, px: number, py: number): void {
    const live = this.spawned.get(lair.id)!.filter((e) => this.world.isAlive(e) && !this.world.get(e, Health)?.dead);
    // Something still out hunting near the player stays.
    for (const e of live) {
      const t = this.world.req(e, Transform);
      if (Math.hypot(t.x - px, t.y - py) < DESPAWN_RADIUS * 0.7) return;
    }
    for (const e of live) {
      this.hide(e);
      this.world.destroy(e);
    }
    this.spawned.delete(lair.id);
  }

  private spotNear(x: number, y: number, radius: number, rng: Rng): { x: number; y: number } | null {
    for (let i = 0; i < 20; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, radius);
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      const tx = Math.floor(px / TILE_PX);
      const ty = Math.floor(py / TILE_PX);
      if (this.map.inBounds(tx, ty) && !this.map.isSolid(tx, ty) && !this.map.isSolid(tx, ty - 1)) return { x: px, y: py };
    }
    const t = nearestWalkable(this.map, Math.floor(x / TILE_PX), Math.floor(y / TILE_PX), 6);
    return t ? { x: (t.x + 0.5) * TILE_PX, y: (t.y + 0.5) * TILE_PX } : null;
  }

  /** A creature died: it stays dead this epoch, and its carcass holds the parts it yields. */
  onDeath(e: Entity, clock: number): void {
    const c = this.world.get(e, Creature);
    if (!c) return;
    const def = this.content.get('creature', c.defId);
    this.pruneDead(clock);
    this.deltas.markRemoved(WILDLIFE_KEY, c.id);
    const rng = new Rng(deriveSeed(this.seed, 'carcass', hashString(c.id)));
    const items: ItemInstance[] = [];
    for (const p of def.parts) if (rng.chance(p.chance)) addItem(this.content, items, createItem(p.item, rng.int(p.count[0], p.count[1])));
    const t = this.world.req(e, Transform);
    const S = this.map.chunkSize;
    this.world.add(e, Container, {
      id: `carcass:${c.id}`,
      label: `${def.name} carcass`,
      kind: 'body',
      chunkKey: chunkKey(Math.floor(t.x / TILE_PX / S), Math.floor(t.y / TILE_PX / S)),
      lootTable: null,
      items,
    });
    this.saveCarcass(e);
  }

  /** Writes a carcass's current contents into the world's saved changes. */
  saveCarcass(e: Entity): void {
    const k = this.world.get(e, Container);
    const c = this.world.get(e, Creature);
    if (!k || !c || !k.chunkKey || !k.items) return;
    const t = this.world.req(e, Transform);
    const epoch = Number(c.id.split('@')[1] ?? 0);
    const data: CarcassData = { defId: c.defId, heading: c.heading, epoch, lairId: c.lairId, items: structuredClone(k.items) };
    this.deltas.putEntity(k.chunkKey, { id: k.id, kind: CARCASS_KIND, x: t.x, y: t.y, data });
  }

  /** Re-creates this epoch's carcasses (older ones have rotted away). */
  restoreCarcasses(clock: number): Entity[] {
    const out: Entity[] = [];
    const stale: { key: string; id: string }[] = [];
    for (const { key, record } of this.deltas.entitiesOfKind(CARCASS_KIND)) {
      const d = record.data as CarcassData;
      const def = this.content.tryGet('creature', d.defId);
      if (!def || d.epoch < lairEpoch(d.lairId, clock)) {
        stale.push({ key, id: record.id });
        continue;
      }
      const e = spawnCreature(this.world, this.content, def, { id: record.id.replace(/^carcass:/, ''), lairId: d.lairId, x: record.x, y: record.y, heading: d.heading });
      const h = this.world.req(e, Health);
      h.hp = 0;
      h.dead = true;
      this.world.remove(e, CreatureBrain);
      this.world.add(e, Container, { id: record.id, label: `${def.name} carcass`, kind: 'body', chunkKey: key, lootTable: null, items: structuredClone(d.items) });
      this.world.get(e, CreatureViewC)?.setDead(true);
      this.show(e);
      out.push(e);
    }
    for (const s of stale) this.deltas.removeEntity(s.key, s.id);
    return out;
  }

  /** Forgets kills from past epochs (those lairs have refilled), so saves don't grow forever. */
  private pruneDead(clock: number): void {
    const d = this.deltas.get(WILDLIFE_KEY);
    if (!d) return;
    const keep = d.removed.filter((id) => {
      const at = id.lastIndexOf('@');
      const lair = id.slice(0, id.lastIndexOf(':', at));
      return Number(id.slice(at + 1)) >= lairEpoch(lair, clock);
    });
    if (keep.length !== d.removed.length) {
      d.removed.length = 0;
      for (const id of keep) this.deltas.markRemoved(WILDLIFE_KEY, id);
    }
  }

  /** Every live creature entity. */
  *creatures(): Generator<Entity> {
    for (const list of this.spawned.values()) for (const e of list) if (this.world.isAlive(e)) yield e;
  }

  clear(): void {
    this.spawned.clear();
  }
}
