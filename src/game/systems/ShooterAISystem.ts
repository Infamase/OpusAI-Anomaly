import { toDirection } from '../../core/math';
import type { ContentRegistry } from '../../content/Registry';
import type { Entity, System, World } from '../../ecs/World';
import { CHEST_HEIGHT, lineOfSight } from '../combat';
import { Aim, Character, Combatant, Equipment, Faction, Health, ShooterAI, Stats, Transform, Velocity } from '../components';
import type { TileMap } from '../world/TileMap';

const SIGHT = 340;
const PREFERRED_MIN = 120;
const PREFERRED_MAX = 240;

/**
 * TEMPORARY test opponent brain (Module 10 replaces it with proper AI).
 * Spots hostiles in line of sight, keeps a fighting distance while strafing,
 * shoots in bursts with distance-based inaccuracy, and reloads when empty.
 */
export class ShooterAISystem implements System {
  readonly name = 'shooterAI';

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
  ) {}

  update(world: World, dt: number): void {
    const map = this.map();
    if (!map) return;
    for (const e of world.query(ShooterAI, Transform, Velocity, Combatant, Aim, Character)) {
      const ai = world.req(e, ShooterAI);
      const t = world.req(e, Transform);
      const vel = world.req(e, Velocity);
      const c = world.req(e, Combatant);
      const ch = world.req(e, Character);
      if (world.get(e, Health)?.dead) continue;
      const speed = (world.get(e, Stats)?.get('move_speed') ?? 70) * 0.75;

      // Re-scan for targets a few times per second.
      ai.scanTimer -= dt;
      if (ai.scanTimer <= 0) {
        ai.scanTimer = 0.25;
        const found = this.findTarget(world, map, e, t.x, t.y);
        if (found !== null && ai.target === null) ai.reaction = 0.35 + Math.random() * 0.3;
        ai.target = found;
      }
      const target = ai.target !== null && world.isAlive(ai.target) && !world.get(ai.target, Health)?.dead ? ai.target : null;
      if (target === null) ai.target = null;

      vel.x = vel.y = 0;
      c.trigger = false;
      if (target === null) {
        ai.sinceSeen += dt;
        // Investigate the last known position briefly, then drift home.
        const gx = ai.sinceSeen < 3 ? ai.lastSeenX : ai.homeX;
        const gy = ai.sinceSeen < 3 ? ai.lastSeenY : ai.homeY;
        const d = Math.hypot(gx - t.x, gy - t.y);
        if (d > 12) {
          vel.x = ((gx - t.x) / d) * speed * 0.7;
          vel.y = ((gy - t.y) / d) * speed * 0.7;
          ch.facing = toDirection(vel, ch.facing);
        }
        continue;
      }

      const tt = world.req(target, Transform);
      ai.lastSeenX = tt.x;
      ai.lastSeenY = tt.y;
      ai.sinceSeen = 0;
      const dx = tt.x - t.x;
      const dy = tt.y - CHEST_HEIGHT / 2 - (t.y - CHEST_HEIGHT);
      const dist = Math.hypot(dx, dy);
      // Aim error grows with distance; re-rolled every burst.
      const err = ((2.5 + dist / 45) * Math.PI) / 180;
      const angle = Math.atan2(dy, dx) + (ai.firing ? 0 : (Math.random() - 0.5) * err);
      world.req(e, Aim).dir = { x: Math.cos(angle), y: Math.sin(angle) };
      ch.facing = toDirection({ x: dx, y: dy }, ch.facing);

      // Keep a fighting distance, strafing sideways.
      ai.strafeTimer -= dt;
      if (ai.strafeTimer <= 0) {
        ai.strafeTimer = 0.8 + Math.random() * 1.4;
        ai.strafeDir = Math.random() < 0.5 ? 1 : -1;
      }
      const ux = dx / Math.max(1, dist);
      const uy = dy / Math.max(1, dist);
      const along = dist < PREFERRED_MIN ? -1 : dist > PREFERRED_MAX ? 1 : 0;
      vel.x = (ux * along + -uy * ai.strafeDir * 0.6) * speed;
      vel.y = (uy * along + ux * ai.strafeDir * 0.6) * speed;

      // Fire in bursts after a short reaction time.
      if (ai.reaction > 0) {
        ai.reaction -= dt;
        continue;
      }
      const eq = world.get(e, Equipment);
      const weapon = c.active && eq?.[c.active];
      if (weapon && (weapon.loaded ?? 0) <= 0) {
        c.wantReload = true;
        continue;
      }
      ai.burstTimer -= dt;
      if (ai.burstTimer <= 0) {
        ai.firing = !ai.firing;
        ai.burstTimer = ai.firing ? 0.25 + Math.random() * 0.6 : 0.5 + Math.random() * 0.9;
      }
      // Semi-auto guns need the trigger released between shots: pulse it.
      c.trigger = ai.firing && (!c.triggerPrev || this.isAuto(world, e));
    }
  }

  private isAuto(world: World, e: Entity): boolean {
    const c = world.req(e, Combatant);
    const item = c.active ? world.get(e, Equipment)?.[c.active] : undefined;
    return !!item && this.content.tryGet('weapon', item.defId)?.fireMode !== 'semi';
  }

  /** Nearest living hostile within sight range and line of sight. */
  private findTarget(world: World, map: TileMap, self: Entity, x: number, y: number): Entity | null {
    const mine = world.get(self, Faction)?.id;
    let best: Entity | null = null;
    let bestD = SIGHT;
    for (const o of world.query(Health, Transform, Faction)) {
      if (o === self || world.req(o, Health).dead || world.req(o, Faction).id === mine) continue;
      const ot = world.req(o, Transform);
      const d = Math.hypot(ot.x - x, ot.y - y);
      if (d < bestD && lineOfSight(map, x, y - CHEST_HEIGHT, ot.x, ot.y - CHEST_HEIGHT)) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }
}
