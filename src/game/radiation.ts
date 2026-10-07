import type { Entity, World } from '../ecs/World';
import { Health, Stats } from './components';

/**
 * Radiation is a dose (rads) that builds up in the body. Below SAFE_DOSE it
 * does nothing; above it, it eats health until it decays on its own
 * or is flushed out with anti-rad drugs. radiation_resist cuts what you take in.
 */
export const SAFE_DOSE = 30;
/** Health lost per second per rad above the safe dose. */
export const SICKNESS_RATE = 0.012;
/** Rads the body clears per second: a little always, more the higher the dose. */
export const BASE_DECAY = 0.5;
export const DECAY_FRACTION = 0.01;
export const decayRate = (rads: number): number => (rads > 0 ? BASE_DECAY + rads * DECAY_FRACTION : 0);
/**
 * A steady source of `perSecond` rads settles at this dose (artifacts: what
 * wearing one costs in the long run).
 */
export const equilibriumDose = (perSecond: number): number => Math.max(0, (perSecond - BASE_DECAY) / DECAY_FRACTION);
/** The HUD calls a dose dangerous from here. */
export const DANGEROUS_DOSE = 150;

/** Adds a dose (before resistance). Returns the rads actually taken in. */
export function addRadiation(world: World, e: Entity, dose: number): number {
  const h = world.get(e, Health);
  if (!h || h.dead || dose === 0) return 0;
  if (dose < 0) {
    const before = h.rads;
    h.rads = Math.max(0, h.rads + dose);
    return h.rads - before;
  }
  const resist = Math.max(0, Math.min(0.95, world.get(e, Stats)?.get('radiation_resist') ?? 0));
  const taken = h.god ? 0 : dose * (1 - resist);
  h.rads += taken;
  return taken;
}

/** Health per second radiation sickness costs at this dose. */
export const sicknessDamage = (rads: number): number => Math.max(0, rads - SAFE_DOSE) * SICKNESS_RATE;
