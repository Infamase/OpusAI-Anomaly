import type { ContentRegistry } from '../../content/Registry';
import type { AnomalyDef } from '../../content/types/anomaly';
import type { DamageType } from '../../content/types/weapon';
import type { EventBus } from '../../core/EventBus';
import type { Entity, System, World } from '../../ecs/World';
import { applyDamage, CHEST_HEIGHT } from '../combat';
import type { CombatEvents } from '../combatEvents';
import { Anomaly, Bolt, Character, Collider, Health, Transform, Velocity } from '../components';
import { addRadiation } from '../radiation';
import { moveAxis } from './MovementSystem';
import { TILE_PX, type TileMap } from '../world/TileMap';

/** Damage-over-time is gathered and dealt in chunks this often (one hit event, not sixty). */
const DOT_TICK = 0.4;
const GRAVITY = 900;

/**
 * Anomalies at work: anything alive (or a thrown bolt) coming close sets off
 * a burst after a short wind-up; pulls drag people in; damage-over-time and
 * radiation hurt whoever stands inside. Anomalies hurt NPCs just the same.
 * Runs after the controls and AI (so pulls add to their movement) and before
 * movement.
 */
export class AnomalySystem implements System {
  readonly name = 'anomalies';
  private dot = new Map<Entity, { amount: number; type: DamageType; from: Entity; name: string }>();
  private dotTimer = 0;

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    const living: Entity[] = [];
    for (const e of world.query(Character, Transform, Health)) if (!world.req(e, Health).dead) living.push(e);
    const bolts = [...world.query(Bolt, Transform)];

    for (const a of world.query(Anomaly, Transform)) {
      const an = world.req(a, Anomaly);
      const def = this.content.tryGet('anomaly', an.defId);
      if (!def) continue;
      const at = world.req(a, Transform);
      const r = def.radius * TILE_PX;
      an.sinceBurst += dt;
      if (an.state !== 'idle') {
        an.timer -= dt;
        if (an.timer <= 0) {
          if (an.state === 'windup') {
            this.burst(world, a, def, at.x, at.y, r, living, bolts);
            an.state = 'cooldown';
            an.timer = def.burst!.cooldown;
            an.sinceBurst = 0;
          } else an.state = 'idle';
        }
      }

      for (const e of living) {
        const t = world.req(e, Transform);
        const dx = t.x - at.x;
        const dy = t.y - at.y;
        const d = Math.hypot(dx, dy);
        if (d >= r) continue;
        const near = 1 - d / r;
        if (def.pull && d > 2) {
          const v = world.get(e, Velocity);
          if (v) {
            const f = def.pull * (0.35 + 0.65 * near);
            v.x -= (dx / d) * f;
            v.y -= (dy / d) * f;
          }
        }
        if (def.dot) {
          const acc = this.dot.get(e) ?? { amount: 0, type: def.damageType, from: a, name: def.name };
          acc.amount += def.dot * dt;
          this.dot.set(e, acc);
        }
        if (def.radiation) addRadiation(world, e, def.radiation * (0.25 + 0.75 * near) * dt);
        if (def.burst && an.state === 'idle') this.trigger(a, an, def, at.x, at.y);
      }
      if (def.burst && an.state === 'idle') {
        for (const b of bolts) {
          const bolt = world.req(b, Bolt);
          const t = world.req(b, Transform);
          if (bolt.z < 14 && Math.hypot(t.x - at.x, t.y - at.y) < r) {
            this.trigger(a, an, def, at.x, at.y);
            break;
          }
        }
      }
    }

    this.dotTimer += dt;
    if (this.dotTimer >= DOT_TICK) {
      this.dotTimer = 0;
      for (const [e, acc] of this.dot) {
        const from = world.get(acc.from, Transform);
        if (from) this.hurt(world, e, acc.amount, acc.type, from.x, from.y, acc.name);
      }
      this.dot.clear();
    }
  }

  private trigger(a: Entity, an: Anomaly, def: AnomalyDef, x: number, y: number): void {
    an.state = 'windup';
    an.timer = def.burst!.windup;
    this.events.emit('anomaly', { entity: a, x, y, defId: def.id, phase: 'trigger' });
  }

  private burst(world: World, a: Entity, def: AnomalyDef, x: number, y: number, r: number, living: Entity[], bolts: Entity[]): void {
    const b = def.burst!;
    this.events.emit('anomaly', { entity: a, x, y, defId: def.id, phase: 'burst' });
    const map = this.map();
    for (const e of living) {
      const t = world.req(e, Transform);
      const dx = t.x - x;
      const dy = t.y - y;
      const d = Math.hypot(dx, dy);
      if (d >= r * 1.1) continue;
      const near = Math.max(0, 1 - d / r);
      this.hurt(world, e, b.damage * (0.6 + 0.4 * near), def.damageType, x, y, def.name);
      // Thrown clear (or sucked in), sliding along walls.
      const col = world.get(e, Collider);
      if (b.knockback && col && map) {
        const ux = d > 1 ? dx / d : 1;
        const uy = d > 1 ? dy / d : 0;
        const push = b.knockback * (0.5 + 0.5 * near);
        for (let k = 0; k < 4; k++) {
          t.x = moveAxis(map, t.x, t.y, (ux * push) / 4, col, 'x');
          t.y = moveAxis(map, t.x, t.y, (uy * push) / 4, col, 'y');
        }
      }
    }
    // Bolts lying in it get flung.
    for (const e of bolts) {
      const t = world.req(e, Transform);
      const bolt = world.req(e, Bolt);
      const dx = t.x - x;
      const dy = t.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > r) continue;
      bolt.landed = false;
      bolt.vz = 260;
      bolt.vx = (dx / d) * 140;
      bolt.vy = (dy / d) * 140;
    }
  }

  private hurt(world: World, e: Entity, amount: number, type: DamageType, fromX: number, fromY: number, name: string): void {
    const h = world.get(e, Health);
    const t = world.get(e, Transform);
    if (!h || h.dead || !t || amount <= 0) return;
    const res = applyDamage(world, this.content, e, { amount, type, ap: 0, attacker: null });
    if (res.dealt > 0) h.cause = `Killed by ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name.toLowerCase()} anomaly.`;
    const angle = Math.atan2(t.y - fromY, t.x - fromX);
    this.events.emit('hit', { target: e, attacker: null, x: t.x, y: t.y - CHEST_HEIGHT * 0.6, angle, ...res });
    if (res.killed) this.events.emit('death', { entity: e, killer: null });
  }
}

/** Moves thrown bolts: a short arc, a bounce, then they lie there for a while. */
export class BoltSystem implements System {
  readonly name = 'bolts';

  constructor(
    private map: () => TileMap | null,
    private events?: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    const map = this.map();
    for (const e of world.query(Bolt, Transform)) {
      const b = world.req(e, Bolt);
      const t = world.req(e, Transform);
      t.prevX = t.x;
      t.prevY = t.y;
      b.life -= dt;
      if (b.life <= 0) {
        world.destroy(e);
        continue;
      }
      if (b.landed) continue;
      const nx = t.x + b.vx * dt;
      const ny = t.y + b.vy * dt;
      // Walls stop it dead (water doesn't: it flies over).
      if (map && map.blocksShots(Math.floor(nx / TILE_PX), Math.floor(ny / TILE_PX))) {
        b.vx = -b.vx * 0.2;
        b.vy = -b.vy * 0.2;
      } else {
        t.x = nx;
        t.y = ny;
      }
      b.vz -= GRAVITY * dt;
      b.z += b.vz * dt;
      if (b.z <= 0) {
        b.z = 0;
        if (b.vz < -60) this.events?.emit('boltLanded', { x: t.x, y: t.y });
        if (Math.abs(b.vz) > 120) {
          b.vz = -b.vz * 0.3;
          b.vx *= 0.4;
          b.vy *= 0.4;
        } else {
          b.landed = true;
          b.vx = b.vy = b.vz = 0;
        }
      }
    }
  }
}

/** Launches a bolt from (x, y) to land at (tx, ty) (clamped to `maxRange` px). */
export function throwBolt(world: World, x: number, y: number, tx: number, ty: number, maxRange = TILE_PX * 9): Entity {
  let dx = tx - x;
  let dy = ty - y;
  const d = Math.hypot(dx, dy);
  if (d > maxRange) {
    dx = (dx / d) * maxRange;
    dy = (dy / d) * maxRange;
  }
  const flight = 0.35 + (Math.min(d, maxRange) / maxRange) * 0.35;
  const e = world.create();
  world.add(e, Transform, { x, y, prevX: x, prevY: y });
  world.add(e, Bolt, { vx: dx / flight, vy: dy / flight, z: 34, vz: (GRAVITY * flight) / 2 - 34 / flight, landed: false, life: 25 });
  return e;
}
