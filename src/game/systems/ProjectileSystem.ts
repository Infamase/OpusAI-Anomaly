import type { EventBus } from '../../core/EventBus';
import type { ContentRegistry } from '../../content/Registry';
import type { Entity, System, World } from '../../ecs/World';
import { applyDamage, hurtbox, segmentBoxEntry, segmentHitsSolid } from '../combat';
import type { CombatEvents } from '../combatEvents';
import { Faction, Health, Projectile, Transform } from '../components';
import type { TileMap } from '../world/TileMap';

/**
 * Moves bullets and resolves what they hit first along their path this tick:
 * a wall or a character's hurtbox. Swept tests mean fast bullets never tunnel.
 */
export class ProjectileSystem implements System {
  readonly name = 'projectiles';

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    const map = this.map();
    const targets: Entity[] = [];
    for (const e of world.query(Health, Transform)) if (!world.req(e, Health).dead) targets.push(e);

    for (const p of world.query(Projectile, Transform)) {
      const pr = world.req(p, Projectile);
      const t = world.req(p, Transform);
      t.prevX = t.x;
      t.prevY = t.y;
      const nx = t.x + pr.vx * dt;
      const ny = t.y + pr.vy * dt;
      const segLen = Math.hypot(nx - t.x, ny - t.y);
      const angle = Math.atan2(pr.vy, pr.vx);

      let best = map ? (segmentHitsSolid(map, t.x, t.y, nx, ny) ?? Infinity) : Infinity;
      let victim: Entity | null = null;
      for (const e of targets) {
        if (e === pr.owner || world.get(e, Faction)?.id === pr.faction) continue;
        const box = hurtbox(world, e);
        const f = box && segmentBoxEntry(t.x, t.y, nx, ny, box);
        if (f !== null && f !== undefined && f < best) {
          best = f;
          victim = e;
        }
      }
      // Range cutoff within this step.
      const rangeLeft = pr.range - pr.travelled;
      if (rangeLeft < segLen && rangeLeft / segLen < best) {
        world.destroy(p);
        continue;
      }
      if (best === Infinity) {
        t.x = nx;
        t.y = ny;
        pr.travelled += segLen;
        continue;
      }
      const hx = t.x + (nx - t.x) * best;
      const hy = t.y + (ny - t.y) * best;
      t.x = hx;
      t.y = hy;
      world.destroy(p);
      if (victim === null) {
        this.events.emit('impact', { x: hx, y: hy, angle });
        continue;
      }
      const attacker = world.isAlive(pr.owner) ? pr.owner : null;
      const res = applyDamage(world, this.content, victim, { amount: pr.damage, type: pr.type, ap: pr.ap, attacker });
      this.events.emit('hit', { target: victim, attacker, x: hx, y: hy, angle, ...res });
      if (res.killed) this.events.emit('death', { entity: victim, killer: attacker });
    }
  }
}
