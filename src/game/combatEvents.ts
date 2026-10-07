import type { Entity } from '../ecs/World';

/** Combat happenings, for effects, HUD feedback, sounds and stats. */
export interface CombatEvents {
  shot: { shooter: Entity; x: number; y: number; angle: number; weaponId: string; recoil: number };
  dryFire: { shooter: Entity };
  reloadStart: { shooter: Entity; time: number };
  reloadDone: { shooter: Entity };
  weaponSwitch: { shooter: Entity };
  impact: { x: number; y: number; angle: number };
  hit: {
    target: Entity;
    attacker: Entity | null;
    x: number;
    y: number;
    angle: number;
    dealt: number;
    blocked: number;
    killed: boolean;
  };
  death: { entity: Entity; killer: Entity | null };
  /** An anomaly was set off (`trigger`) or went off (`burst`). */
  anomaly: { entity: Entity; x: number; y: number; defId: string; phase: 'trigger' | 'burst' };
  /** A bolt was thrown, or hit the ground. */
  boltThrown: { thrower: Entity; x: number; y: number };
  boltLanded: { x: number; y: number };
}
