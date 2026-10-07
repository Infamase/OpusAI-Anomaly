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
  /** Someone used a door (`tile` is what it was before). */
  door: { by: Entity; tx: number; ty: number; x: number; y: number; tile: string; result: 'opened' | 'closed' | 'unlocked' | 'locked' | 'blocked' };
  /** A bullet struck a solid tile (breakable or not). */
  tileHit: { tx: number; ty: number; x: number; y: number; angle: number; amount: number; attacker: Entity | null };
  /** A breakable tile or prop gave way (`tile` is the tile it was, if a tile). */
  broken: { x: number; y: number; tile?: string; debris: string; by: Entity | null };
  /** A bullet struck a breakable prop (a crate). */
  propHit: { target: Entity; x: number; y: number; angle: number; amount: number; attacker: Entity | null };
}
