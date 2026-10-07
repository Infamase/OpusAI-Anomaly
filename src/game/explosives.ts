import type { ContentRegistry } from '../content/Registry';
import type { ExplosiveDef } from '../content/types/explosive';
import type { EventBus } from '../core/EventBus';
import type { Entity, System, World } from '../ecs/World';
import { applyDamage, CHEST_HEIGHT, segmentHitsSolid } from './combat';
import type { CombatEvents } from './combatEvents';
import { Bolt, Breakable, Character, Collider, Explosive, Faction, Health, Transform } from './components';
import { moveAxis } from './systems/MovementSystem';
import { TILE_PX, type TileMap } from './world/TileMap';

const T = TILE_PX;
const GRAVITY = 900;
/** Thrown from about hand height. */
const THROW_HEIGHT = 30;
/** Below this ground speed a rolling grenade has stopped. */
const REST_SPEED = 6;
/** Rolling grenades that bounced off something slow down at this rate (px/s²). */
const DEFAULT_FRICTION = 320;
/** A thrown grenade higher than this clears low obstacles (fences, barricades), px. */
const LOB_OVER = 20;
/** Half width of a claymore's tripwire, px. */
const TRIPWIRE_HALF = 9;

function base(def: ExplosiveDef, y: number): Omit<Explosive, 'state' | 'timer' | 'owner' | 'faction'> {
  return { defId: def.id, angle: 0, vx: 0, vy: 0, z: 0, vz: 0, friction: DEFAULT_FRICTION, aimX: null, aimY: y, recordId: null, chunkKey: null, generated: false, spotted: false, spin: 0 };
}

/**
 * Throws a grenade from (x, y) toward (tx, ty), clamped to its range. It lands
 * a little short and rolls the rest of the way, coming to a stop near the aim
 * point; the fuse burns only once it's at rest.
 */
export function throwGrenade(world: World, def: ExplosiveDef, x: number, y: number, tx: number, ty: number, owner: Entity | null, faction: string | null): Entity {
  let dx = tx - x;
  let dy = ty - y;
  let d = Math.hypot(dx, dy);
  const max = def.range * T;
  if (d > max) {
    dx = (dx / d) * max;
    dy = (dy / d) * max;
    d = max;
  }
  const flight = 0.38 + (d / max) * 0.32;
  const land = d * 0.7;
  const ux = d > 0 ? dx / d : 0;
  const uy = d > 0 ? dy / d : 0;
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Explosive, {
    ...base(def, y),
    state: 'flying',
    timer: 0,
    owner,
    faction,
    angle: Math.atan2(dy, dx),
    vx: (ux * land) / flight,
    vy: (uy * land) / flight,
    z: THROW_HEIGHT,
    vz: (GRAVITY * flight) / 2 - THROW_HEIGHT / flight,
    aimX: x + dx,
    aimY: y + dy,
  });
  return e;
}

/** Sets a charge down at (x, y) facing `angle`. `armed` skips the arming delay (world hazards). */
export function placeCharge(world: World, def: ExplosiveDef, x: number, y: number, angle: number, owner: Entity | null, faction: string | null, armed = false): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Explosive, { ...base(def, y), state: armed ? 'armed' : 'arming', timer: armed ? 0 : def.arming, owner, faction, angle });
  // Shooting a charge sets it off from a safe distance.
  world.add(e, Breakable, { hp: 1, max: 1, debris: def.art.color, halfW: 7, height: 10 });
  return e;
}

/** Sets a charge or grenade off right away (bullets, a nearby blast). */
export function detonate(world: World, e: Entity, delay = 0): void {
  const ex = world.get(e, Explosive);
  if (!ex || (ex.state === 'triggered' && ex.timer <= delay)) return;
  ex.state = 'triggered';
  ex.timer = delay;
  ex.vx = ex.vy = 0;
}

/** Live grenades that people should get away from: position and danger radius (px). */
export function liveGrenades(world: World, content: ContentRegistry): { e: Entity; x: number; y: number; radius: number; left: number }[] {
  const out: { e: Entity; x: number; y: number; radius: number; left: number }[] = [];
  for (const e of world.query(Explosive, Transform)) {
    const ex = world.req(e, Explosive);
    if (ex.state !== 'rolling' && ex.state !== 'fuse' && !(ex.state === 'flying' && ex.z < 20)) continue;
    const def = content.tryGet('explosive', ex.defId);
    if (!def || def.use !== 'throw') continue;
    const t = world.req(e, Transform);
    out.push({ e, x: t.x, y: t.y, radius: def.blast.radius * T, left: ex.state === 'fuse' ? ex.timer : def.fuse });
  }
  return out;
}

/**
 * Grenades in flight and on the ground, charges waiting for someone, and the
 * blasts. Runs after the AI (so NPC throws move this tick) and before
 * movement (knockback slides along walls).
 */
export class ExplosiveSystem implements System {
  readonly name = 'explosives';

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    const map = this.map();
    const living: Entity[] = [];
    for (const e of world.query(Character, Transform, Health)) if (!world.req(e, Health).dead) living.push(e);
    const bolts = [...world.query(Bolt, Transform)];
    for (const e of [...world.query(Explosive, Transform)]) {
      if (!world.isAlive(e)) continue;
      const ex = world.req(e, Explosive);
      const def = this.content.tryGet('explosive', ex.defId);
      if (!def) continue;
      const t = world.req(e, Transform);
      t.prevX = t.x;
      t.prevY = t.y;
      switch (ex.state) {
        case 'flying':
          this.fly(map, ex, t, dt);
          // Molotovs burst where they land (or against a wall).
          if (def.trigger === 'impact' && (ex.state !== 'flying' || ex.aimX === null)) this.explode(world, map, e, def);
          break;
        case 'rolling':
          this.roll(map, ex, t, def, dt);
          break;
        case 'fuse':
        case 'triggered':
          if ((ex.timer -= dt) <= 0) this.explode(world, map, e, def);
          break;
        case 'arming':
          if ((ex.timer -= dt) <= 0) {
            ex.state = 'armed';
            this.events.emit('explosive', { entity: e, x: t.x, y: t.y, defId: def.id, phase: 'armed' });
          }
          break;
        case 'armed':
          if (this.tripped(world, map, ex, def, t, living, bolts)) {
            detonate(world, e, def.delay);
            this.events.emit('explosive', { entity: e, x: t.x, y: t.y, defId: def.id, phase: 'triggered' });
          }
          break;
      }
    }
  }

  // ---- thrown ---------------------------------------------------------------

  private fly(map: TileMap | null, ex: Explosive, t: { x: number; y: number }, dt: number): void {
    this.slide(map, ex, t, dt);
    ex.vz -= GRAVITY * dt;
    ex.z += ex.vz * dt;
    if (ex.z > 0) return;
    ex.z = 0;
    if (ex.vz < -110 && this.content.tryGet('explosive', ex.defId)?.trigger !== 'impact') {
      // Bounce: it hops on, losing most of its speed.
      ex.vz = -ex.vz * 0.3;
      ex.vx *= 0.62;
      ex.vy *= 0.62;
      this.events.emit('grenadeBounce', { x: t.x, y: t.y });
      return;
    }
    ex.vz = 0;
    ex.state = 'rolling';
    // Roll to a stop at the aim point (unless it's hit a wall since).
    const speed = Math.hypot(ex.vx, ex.vy);
    if (ex.aimX !== null && speed > 1) {
      const ahead = ((ex.aimX - t.x) * ex.vx + (ex.aimY - t.y) * ex.vy) / speed;
      ex.friction = Math.max(120, Math.min(900, (speed * speed) / (2 * Math.max(10, ahead))));
    } else ex.friction = DEFAULT_FRICTION;
  }

  private roll(map: TileMap | null, ex: Explosive, t: { x: number; y: number }, def: ExplosiveDef, dt: number): void {
    const speed = Math.hypot(ex.vx, ex.vy);
    const next = speed - ex.friction * dt;
    if (next <= REST_SPEED || (map && map.tiles.low[map.getTile(Math.floor(t.x / T), Math.floor(t.y / T))])) {
      ex.vx = ex.vy = 0;
      ex.state = 'fuse';
      ex.timer = def.fuse;
      return;
    }
    ex.vx *= next / speed;
    ex.vy *= next / speed;
    ex.spin += next * dt;
    this.slide(map, ex, t, dt);
  }

  /** Moves along the ground, bouncing off walls (and closed doors). High enough, it sails over fences and barricades. */
  private slide(map: TileMap | null, ex: Explosive, t: { x: number; y: number }, dt: number): void {
    const nx = t.x + ex.vx * dt;
    const ny = t.y + ex.vy * dt;
    const blocked = (tx: number, ty: number) => !!map && map.blocksShots(tx, ty) && (ex.z < LOB_OVER || !map.tiles.defs[map.getTile(tx, ty)]!.prop);
    if (blocked(Math.floor(nx / T), Math.floor(t.y / T))) {
      ex.vx = -ex.vx * 0.45;
      ex.aimX = null;
      ex.friction = DEFAULT_FRICTION;
      this.events.emit('grenadeBounce', { x: t.x, y: t.y });
    } else t.x = nx;
    if (blocked(Math.floor(t.x / T), Math.floor(ny / T))) {
      ex.vy = -ex.vy * 0.45;
      ex.aimX = null;
      ex.friction = DEFAULT_FRICTION;
      this.events.emit('grenadeBounce', { x: t.x, y: t.y });
    } else t.y = ny;
  }

  // ---- placed ---------------------------------------------------------------

  /** Did someone (or a bolt) set it off? */
  private tripped(world: World, map: TileMap | null, ex: Explosive, def: ExplosiveDef, t: { x: number; y: number }, living: Entity[], bolts: Entity[]): boolean {
    const reach = def.sense * T;
    const fx = Math.cos(ex.angle);
    const fy = Math.sin(ex.angle);
    const hits = (px: number, py: number, pad: number) => {
      const dx = px - t.x;
      const dy = py - t.y;
      if (def.trigger === 'proximity') return Math.hypot(dx, dy) <= reach + pad;
      // Tripwire: along the line out in front, within a narrow band.
      const along = dx * fx + dy * fy;
      const across = Math.abs(dx * fy - dy * fx);
      if (along < 0 || along > reach || across > TRIPWIRE_HALF + pad) return false;
      return !map || segmentHitsSolid(map, t.x, t.y - 2, t.x + fx * along, t.y + fy * along - 2) === null;
    };
    for (const e of living) {
      if (ex.faction !== null && world.get(e, Faction)?.id === ex.faction) continue;
      const p = world.req(e, Transform);
      if (hits(p.x, p.y, (world.get(e, Collider)?.w ?? 12) / 2)) return true;
    }
    // A bolt landing on it (or across the wire) sets it off: the stalker's way of clearing mines.
    for (const b of bolts) {
      const bolt = world.req(b, Bolt);
      if (bolt.z > 8) continue;
      const p = world.req(b, Transform);
      if (hits(p.x, p.y, 4)) return true;
    }
    return false;
  }

  // ---- the bang ---------------------------------------------------------------

  private explode(world: World, map: TileMap | null, e: Entity, def: ExplosiveDef): void {
    const ex = world.req(e, Explosive);
    const at = world.req(e, Transform);
    const cx = at.x;
    const cy = at.y;
    const b = def.blast;
    const r = b.radius * T;
    const owner = ex.owner !== null && world.isAlive(ex.owner) ? ex.owner : null;
    const coneCos = Math.cos(((b.cone / 2) * Math.PI) / 180);
    const fx = Math.cos(ex.angle);
    const fy = Math.sin(ex.angle);
    world.destroy(e);
    this.events.emit('explosion', { entity: e, x: cx, y: cy, defId: def.id, radius: r, owner, recordId: ex.recordId, chunkKey: ex.chunkKey, generated: ex.generated, angle: ex.angle });

    /** 0..1 strength of the blast at a point (0 outside it, behind a claymore, or behind a wall). */
    const strength = (px: number, py: number, height: number): number => {
      const dx = px - cx;
      const dy = py - cy;
      const d = Math.hypot(dx, dy);
      if (d > r) return 0;
      // Full force near the middle, a quarter at the edge.
      let k = 0.25 + 0.75 * Math.min(1, (1 - d / r) * 1.35);
      // Directional charges: outside the cone only a little backblast right next to it.
      if (b.cone < 360 && d > 4 && (dx * fx + dy * fy) / d < coneCos) k = d < T * 1.2 ? k * 0.15 : 0;
      if (k <= 0) return 0;
      if (map && segmentHitsSolid(map, cx, cy - 4, px, py - height) !== null) return 0;
      return k;
    };

    for (const v of world.query(Character, Transform, Health)) {
      const h = world.req(v, Health);
      if (h.dead) continue;
      const t = world.req(v, Transform);
      const k = strength(t.x, t.y, CHEST_HEIGHT * 0.5);
      if (k <= 0) continue;
      const res = applyDamage(world, this.content, v, { amount: b.damage * k, type: b.damageType, ap: b.ap, attacker: owner });
      if (res.dealt > 0) h.cause = owner === v ? `Blown up by your own ${def.name}.` : `Killed by ${/^[aeiou]/i.test(def.name) ? 'an' : 'a'} ${def.name}.`;
      const angle = Math.atan2(t.y - cy, t.x - cx);
      this.events.emit('hit', { target: v, attacker: owner, x: t.x, y: t.y - CHEST_HEIGHT * 0.6, angle, ...res });
      if (res.killed) this.events.emit('death', { entity: v, killer: owner });
      // Thrown back, sliding along walls.
      const col = world.get(v, Collider);
      if (b.knockback && col && map && !h.dead) {
        const push = b.knockback * k;
        for (let i = 0; i < 4; i++) {
          t.x = moveAxis(map, t.x, t.y, (Math.cos(angle) * push) / 4, col, 'x');
          t.y = moveAxis(map, t.x, t.y, (Math.sin(angle) * push) / 4, col, 'y');
        }
      }
    }

    // Walls, fences, barricades and crates nearby take a beating.
    if (map && b.shatter > 0) {
      const tx0 = Math.floor((cx - r) / T);
      const ty0 = Math.floor((cy - r) / T);
      for (let ty = ty0; ty <= Math.floor((cy + r) / T); ty++) {
        for (let tx = tx0; tx <= Math.floor((cx + r) / T); tx++) {
          if (!map.inBounds(tx, ty) || !map.tiles.defs[map.getTile(tx, ty)]!.breakable) continue;
          // The nearest point of the tile, and only if nothing else solid is in the way.
          const px = Math.max(tx * T, Math.min(cx, tx * T + T - 0.01));
          const py = Math.max(ty * T, Math.min(cy, ty * T + T - 0.01));
          const d = Math.hypot(px - cx, py - cy);
          if (d > r) continue;
          let k = 1 - d / r;
          if (b.cone < 360 && d > 4 && ((px - cx) * fx + (py - cy) * fy) / d < coneCos) k *= 0.15;
          const f = segmentHitsSolid(map, cx, cy, px, py);
          if (f !== null) {
            const hx = cx + (px - cx) * f;
            const hy = cy + (py - cy) * f;
            if (Math.floor((hx + (px - cx) * 0.001) / T) !== tx && Math.floor((hy + (py - cy) * 0.001) / T) !== ty) continue;
          }
          this.events.emit('tileHit', { tx, ty, x: px, y: py, angle: Math.atan2(py - cy, px - cx), amount: b.shatter * k, attacker: owner });
        }
      }
    }
    for (const p of world.query(Breakable, Transform)) {
      if (world.has(p, Explosive)) continue;
      const t = world.req(p, Transform);
      const k = strength(t.x, t.y, 8);
      if (k > 0) this.events.emit('propHit', { target: p, x: t.x, y: t.y - 8, angle: Math.atan2(t.y - cy, t.x - cx), amount: b.shatter * k * 0.6, attacker: owner });
    }
    // Other explosives in reach go off a moment later.
    for (const o of world.query(Explosive, Transform)) {
      const t = world.req(o, Transform);
      if (Math.hypot(t.x - cx, t.y - cy) < r * 0.9 && strength(t.x, t.y, 2) > 0) detonate(world, o, 0.12 + Math.random() * 0.18);
    }
  }
}
