import type { Direction } from '../core/math';
import { defineComponent } from '../ecs/World';
import type { ChannelColors } from '../render/palette';
import type { CharacterView } from '../render/CharacterView';
import type { EquipmentSave } from '../save/types';
import type { StatBlock } from '../stats/Stats';

/** Position of the entity's feet in world pixels. prev* is last tick's, for render interpolation. */
export interface Transform {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
}
export const Transform = defineComponent<Transform>('Transform');

export interface Velocity {
  x: number;
  y: number;
}
export const Velocity = defineComponent<Velocity>('Velocity');

/** Axis-aligned collision box centered horizontally on the feet, extending up by h. */
export interface Collider {
  w: number;
  h: number;
}
export const Collider = defineComponent<Collider>('Collider');

/** Any biped: player, NPC Stalker. Race + colors are all it takes to build one. */
export interface Character {
  raceId: string;
  colors: ChannelColors;
  facing: Direction;
  anim: string;
  animTime: number;
  sprinting: boolean;
}
export const Character = defineComponent<Character>('Character');

export const Stats = defineComponent<StatBlock>('Stats');

/** Tag: driven by the local player's input. */
export const PlayerControlled = defineComponent<true>('PlayerControlled');

/** Where the entity is aiming, as a world-space unit vector (or null when not aiming). */
export interface Aim {
  dir: { x: number; y: number } | null;
}
export const Aim = defineComponent<Aim>('Aim');

/** Render-side handle. Lives in the ECS so destroying an entity can clean up its sprites. */
export const View = defineComponent<CharacterView>('View');

/** Worn armor by slot. Stat modifiers are tagged "item:<uid>" so they can be removed exactly. */
export const Equipment = defineComponent<EquipmentSave>('Equipment');
