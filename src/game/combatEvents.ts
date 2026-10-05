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
}
