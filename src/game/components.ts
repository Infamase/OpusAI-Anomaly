import type { Direction } from '../core/math';
import { defineComponent } from '../ecs/World';
import type { ChannelColors } from '../render/palette';
import type { CharacterView } from '../render/CharacterView';
import type { DamageType } from '../content/types/weapon';
import type { EquipmentSave, ItemInstance, WeaponSlotId } from '../save/types';
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

// ---- Combat (Module 8) ------------------------------------------------------

export interface Health {
  hp: number;
  /** Hit points lost per second until it wears off or is bandaged. */
  bleed: number;
  dead: boolean;
  /** Seconds since the last hit (for health bars / regen later). */
  sinceHit: number;
  /** Dev: ignore damage. */
  god?: boolean;
  /** Active heal-over-time effects (medkits, food). */
  regen: { rate: number; left: number }[];
}
export const Health = defineComponent<Health>('Health');

export interface Stamina {
  current: number;
  /** Ran dry: no sprinting until stamina recovers past a threshold. */
  exhausted: boolean;
  /** Seconds before regeneration resumes. */
  regenDelay: number;
}
export const Stamina = defineComponent<Stamina>('Stamina');

/**
 * Weapon handling state. Intents (trigger, reload, switch) are written by the
 * player's input or by AI; WeaponSystem turns them into shots. Magazine
 * contents live on the weapon's ItemInstance so they persist in saves.
 */
export interface Combatant {
  active: WeaponSlotId | null;
  trigger: boolean;
  triggerPrev: boolean;
  wantReload: boolean;
  wantSwitch: WeaponSlotId | 'next' | null;
  cooldown: number;
  reloadLeft: number;
  reloadTotal: number;
  switchLeft: number;
  burstLeft: number;
  /** Extra spread from sustained fire, in degrees. */
  bloom: number;
  /** NPCs fire from a bottomless pouch until they get real inventories. */
  infiniteAmmo?: boolean;
}
export const Combatant = defineComponent<Combatant>('Combatant');

export const newCombatant = (active: WeaponSlotId | null): Combatant => ({
  active,
  trigger: false,
  triggerPrev: false,
  wantReload: false,
  wantSwitch: null,
  cooldown: 0,
  reloadLeft: 0,
  reloadTotal: 0,
  switchLeft: 0,
  burstLeft: 0,
  bloom: 0,
});

/** Carried items that aren't equipped. */
export const Inventory = defineComponent<ItemInstance[]>('Inventory');

/** Who this entity sides with. Module 10 adds a relationship table; for now different factions are hostile. */
export const Faction = defineComponent<{ id: string }>('Faction');

export interface Projectile {
  owner: number;
  faction: string;
  damage: number;
  ap: number;
  type: DamageType;
  vx: number;
  vy: number;
  travelled: number;
  range: number;
}
export const Projectile = defineComponent<Projectile>('Projectile');

/** Temporary "hold position and shoot" brain for test bandits; replaced by Module 10's AI. */
export interface ShooterAI {
  target: number | null;
  lastSeenX: number;
  lastSeenY: number;
  sinceSeen: number;
  scanTimer: number;
  reaction: number;
  burstTimer: number;
  firing: boolean;
  strafeDir: 1 | -1;
  strafeTimer: number;
  homeX: number;
  homeY: number;
}
export const ShooterAI = defineComponent<ShooterAI>('ShooterAI');

// ---- Inventory (Module 9) ----------------------------------------------------

/** Carried weight vs. limit. level: 0 fine, 1 overloaded (slow, no sprint), 2 barely moving. */
export interface Encumbrance {
  weight: number;
  limit: number;
  level: 0 | 1 | 2;
}
export const Encumbrance = defineComponent<Encumbrance>('Encumbrance');

/** An item lying on the ground. `recordId` links it to its saved chunk record. */
export interface WorldItem {
  item: ItemInstance;
  recordId: string;
  chunkKey: string;
}
export const WorldItem = defineComponent<WorldItem>('WorldItem');

/**
 * Something with contents: a crate (generated with the world, contents saved
 * once touched) or a body (temporary). `items` is null until first opened,
 * then rolled from `lootTable`.
 */
export interface Container {
  id: string;
  label: string;
  kind: 'crate' | 'body';
  chunkKey: string | null;
  lootTable: string | null;
  items: ItemInstance[] | null;
}
export const Container = defineComponent<Container>('Container');

/** A static prop sprite (items on the ground, crates). */
export const PropView = defineComponent<import('../render/PropView').PropView>('PropView');
