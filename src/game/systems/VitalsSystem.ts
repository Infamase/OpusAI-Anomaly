import { decayRate, sicknessDamage } from '../radiation';
import type { EventBus } from '../../core/EventBus';
import type { System, World } from '../../ecs/World';
import type { CombatEvents } from '../combatEvents';
import { Character, Combatant, Health, Stamina, Stats, Velocity } from '../components';

const BLEED_DECAY = 0.06; // hp/s of bleeding that stops on its own each second
const SPRINT_COST = 22; // stamina per second
const STAMINA_REGEN = 16;
const REGEN_DELAY = 0.8;
const RECOVER_AT = 0.3; // fraction of max needed to sprint again after running dry

/** Bleeding, death, and stamina for sprinting. */
export class VitalsSystem implements System {
  readonly name = 'vitals';

  constructor(private events: EventBus<CombatEvents>) {}

  update(world: World, dt: number): void {
    for (const e of world.query(Health)) {
      const h = world.req(e, Health);
      h.sinceHit += dt;
      if (h.dead) {
        const v = world.get(e, Velocity);
        if (v) v.x = v.y = 0;
        const c = world.get(e, Combatant);
        if (c) c.trigger = false;
        continue;
      }
      const max = world.get(e, Stats)?.get('max_health') ?? 100;
      for (const r of h.regen) {
        const t = Math.min(dt, r.left);
        h.hp += r.rate * t;
        r.left -= t;
      }
      if (h.regen.length) h.regen = h.regen.filter((r) => r.left > 0);
      // Radiation sickness, while the body slowly clears the dose.
      if (h.rads > 0) {
        const sick = sicknessDamage(h.rads);
        if (!h.god) h.hp -= sick * dt;
        if (sick > h.bleed) h.cause = 'Radiation sickness killed you.';
        h.rads = Math.max(0, h.rads - decayRate(h.rads) * dt);
      }
      if (h.bleed > 0) {
        if (!h.god) h.hp -= h.bleed * dt;
        h.bleed = Math.max(0, h.bleed - BLEED_DECAY * dt);
      }
      h.hp = Math.min(h.hp, max);
      if (h.hp <= 0) {
        h.hp = 0;
        h.dead = true;
        h.bleed = 0;
        this.events.emit('death', { entity: e, killer: null });
      }
    }

    for (const e of world.query(Stamina, Character, Stats)) {
      const s = world.req(e, Stamina);
      const max = world.req(e, Stats).get('max_stamina');
      if (world.req(e, Character).sprinting) {
        s.current -= SPRINT_COST * dt;
        s.regenDelay = REGEN_DELAY;
        if (s.current <= 0) {
          s.current = 0;
          s.exhausted = true;
        }
      } else if (s.regenDelay > 0) {
        s.regenDelay -= dt;
      } else {
        s.current = Math.min(max, s.current + STAMINA_REGEN * dt);
      }
      if (s.exhausted && s.current >= max * RECOVER_AT) s.exhausted = false;
    }
  }
}
