import type { ContentRegistry } from '../content/Registry';
import type { EventBus } from '../core/EventBus';
import type { Entity, System, World } from '../ecs/World';
import { applyDamage, CHEST_HEIGHT, segmentHitsSolid } from './combat';
import type { CombatEvents } from './combatEvents';
import { Breakable, Character, Explosive, Health, Transform } from './components';
import { detonate } from './explosives';
import { TILE_PX, type TileMap } from './world/TileMap';

const T = TILE_PX;
/** Spreading is worked out this often (seconds). */
const SPREAD_STEP = 0.25;
/** A fire never grows past this many burning tiles (it just stops spreading). */
const MAX_CELLS = 700;
/** Flames weaker than this don't spread any more: a fire burns itself out over distance. */
const MIN_SPREAD_HEAT = 0.22;
/** Damage to someone standing in flames, per second. */
const BURN_DPS = 22;
const HURT_TICK = 0.4;

/** What the wind and rain are doing (from the weather; calm and dry if none). */
export interface FireClimate {
  rain: number;
  wind: number;
  windAngle: number;
}

export interface FireCell {
  tx: number;
  ty: number;
  /** Seconds of fuel left. */
  left: number;
  max: number;
  /** 0..1: how readily it spreads (falls off with each tile it travels). */
  heat: number;
}

const NEIGHBORS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Fire on the tile map. Tiles with `burns` catch and spread to flammable
 * neighbors (faster downwind, not at all in heavy rain), each new tile a
 * little weaker so fires die out; when the fuel is gone the tile becomes its
 * burnt form (saved like any tile change). Spilled fuel can burn on bare
 * ground for a while without spreading.
 */
export class FireMap {
  readonly cells = new Map<number, FireCell>();
  /** Bumped when fires start or stop. */
  version = 0;
  private stepIn = 0;

  constructor(
    private map: TileMap,
    private rand: () => number = Math.random,
  ) {}

  isBurning(tx: number, ty: number): boolean {
    return this.cells.has(ty * this.map.widthTiles + tx);
  }

  get size(): number {
    return this.cells.size;
  }

  /**
   * Sets a tile alight. `fuel` (seconds) lets non-flammable floor burn too
   * (spilled petrol). Returns true if it caught.
   */
  ignite(tx: number, ty: number, heat = 1, fuel = 0): boolean {
    const map = this.map;
    if (!map.inBounds(tx, ty)) return false;
    const k = ty * map.widthTiles + tx;
    const cell = this.cells.get(k);
    if (cell) {
      cell.heat = Math.max(cell.heat, heat);
      return false;
    }
    const tile = map.getTile(tx, ty);
    const def = map.tiles.defs[tile]!;
    // Water and walls don't burn; flammable things burn their own fuel.
    if (map.tiles.low[tile] && !def.burns) return false;
    let left = 0;
    if (def.burns) left = def.burns.fuel * (0.7 + this.rand() * 0.6);
    else if (fuel > 0 && !def.solid) left = fuel * (0.8 + this.rand() * 0.4);
    if (left <= 0) return false;
    this.cells.set(k, { tx, ty, left, max: left, heat });
    this.version++;
    return true;
  }

  /** Everything flammable (and, with `fuel`, any floor) within `radius` px of (x, y) that the flames can reach. */
  igniteArea(x: number, y: number, radius: number, fuel = 0, heat = 1): number {
    let lit = 0;
    for (let ty = Math.floor((y - radius) / T); ty <= Math.floor((y + radius) / T); ty++) {
      for (let tx = Math.floor((x - radius) / T); tx <= Math.floor((x + radius) / T); tx++) {
        const cx = (tx + 0.5) * T;
        const cy = (ty + 0.5) * T;
        if (Math.hypot(cx - x, cy - y) > radius) continue;
        // Splashed flames don't go through walls.
        const f = segmentHitsSolid(this.map, x, y, cx, cy, 'shots');
        if (f !== null && f < 0.95) continue;
        if (this.ignite(tx, ty, heat, fuel)) lit++;
      }
    }
    return lit;
  }

  /** Burns, spreads, goes out. Returns how many tiles finished burning. */
  update(dt: number, climate: FireClimate): number {
    const map = this.map;
    let burnt = 0;
    // Rain shortens fires and can put them out.
    const douse = 1 + climate.rain * 5;
    for (const [k, c] of this.cells) {
      c.left -= dt * douse;
      // Put out early by the rain, it's only singed (the tile stays as it was).
      let singed = false;
      if (climate.rain > 0.25 && this.rand() < climate.rain * climate.rain * dt * 2) {
        singed = c.left > c.max * 0.5;
        c.left = 0;
      }
      if (c.left > 0) continue;
      this.cells.delete(k);
      this.version++;
      burnt++;
      const def = map.tiles.defs[map.getTile(c.tx, c.ty)]!;
      if (def.burns && !singed) map.setTile(c.tx, c.ty, def.burns.becomes);
    }
    this.stepIn -= dt;
    if (this.stepIn > 0) return burnt;
    this.stepIn = SPREAD_STEP;
    if (this.cells.size >= MAX_CELLS || climate.rain > 0.85) return burnt;
    const wx = Math.cos(climate.windAngle);
    const wy = Math.sin(climate.windAngle);
    for (const c of [...this.cells.values()]) {
      if (c.heat < MIN_SPREAD_HEAT) continue;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = c.tx + dx;
        const ny = c.ty + dy;
        if (!map.inBounds(nx, ny) || this.isBurning(nx, ny)) continue;
        const burns = map.tiles.defs[map.getTile(nx, ny)]!.burns;
        if (!burns) continue;
        const len = Math.hypot(dx, dy);
        const along = (dx * wx + dy * wy) / len;
        const windy = Math.max(0.15, 1 + climate.wind * 1.6 * along);
        const chance = burns.spread * c.heat * windy * (1 - climate.rain) * SPREAD_STEP * 1.6 / len;
        if (this.rand() < chance) this.ignite(nx, ny, Math.min(1, c.heat * (0.86 + 0.1 * climate.wind * Math.max(0, along))));
      }
    }
    return burnt;
  }

  clear(): void {
    this.cells.clear();
    this.version++;
  }
}

/**
 * What fire does to things: burns people standing in it, cooks off charges
 * and grenades lying in it, and burns crates. Runs the FireMap too.
 */
export class FireSystem implements System {
  readonly name = 'fire';
  private hurtIn = 0;

  constructor(
    private content: ContentRegistry,
    private fire: () => FireMap | null,
    private climate: () => FireClimate,
    private events: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    const fire = this.fire();
    if (!fire) return;
    fire.update(dt, this.climate());
    if (!fire.size) return;
    this.hurtIn -= dt;
    if (this.hurtIn > 0) return;
    this.hurtIn = HURT_TICK;
    const onFire = (x: number, y: number) => fire.isBurning(Math.floor(x / T), Math.floor((y - 2) / T));
    for (const e of world.query(Character, Transform, Health)) {
      const h = world.req(e, Health);
      const t = world.req(e, Transform);
      if (h.dead || !onFire(t.x, t.y)) continue;
      this.burn(world, e, t.x, t.y);
    }
    for (const e of world.query(Explosive, Transform)) {
      const t = world.req(e, Transform);
      const ex = world.req(e, Explosive);
      if (ex.state !== 'triggered' && ex.state !== 'flying' && onFire(t.x, t.y)) detonate(world, e, 0.4 + Math.random() * 0.8);
    }
    for (const e of world.query(Breakable, Transform)) {
      if (world.has(e, Explosive)) continue;
      const t = world.req(e, Transform);
      if (onFire(t.x, t.y)) this.events.emit('propHit', { target: e, x: t.x, y: t.y - 8, angle: -Math.PI / 2, amount: 6, attacker: null });
    }
  }

  private burn(world: World, e: Entity, x: number, y: number): void {
    const res = applyDamage(world, this.content, e, { amount: BURN_DPS * HURT_TICK, type: 'thermal', ap: 0, attacker: null });
    const h = world.req(e, Health);
    if (res.dealt > 0) h.cause = 'Burned to death.';
    this.events.emit('hit', { target: e, attacker: null, x, y: y - CHEST_HEIGHT * 0.6, angle: -Math.PI / 2, ...res });
    if (res.killed) this.events.emit('death', { entity: e, killer: null });
  }
}
