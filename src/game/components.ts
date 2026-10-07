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
  /** How tall it stands, px (creatures); characters are about 50. Sets the area bullets can hit. */
  tall?: number;
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
  /** Radiation dose in the body (see game/radiation.ts). */
  rads: number;
  /** What last hurt it when there's no attacker (death screen). */
  cause?: string;
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

/** Who this entity sides with (faction content id, or "player"). Attitudes come from game/factions.ts. */
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
  /** Placed by the world generator (taking it is saved as a removal) rather than dropped. */
  generated?: boolean;
  /** Artifacts: invisible until a detector reveals them. */
  hidden?: boolean;
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

/** A prop bullets can break (a wooden crate): `hp` left of `max`; `debris` colors the splinters. */
export interface Breakable {
  hp: number;
  max: number;
  debris: string;
  /** Hit area around the feet point, px: half width and height. */
  halfW: number;
  height: number;
}
export const Breakable = defineComponent<Breakable>('Breakable');

/** A static prop sprite (items on the ground, crates). */
export const PropView = defineComponent<import('../render/PropView').PropView>('PropView');

// ---- AI & factions (Module 10) ----------------------------------------------

/** Who an NPC is. `id` is stable (`<campId>:<index>`) so its death can be saved. */
export interface Npc {
  id: string;
  campId: string;
  templateId: string;
  name: string;
  /** 0..1: accuracy, reaction time, tactics. */
  skill: number;
  /** Entities that attacked this NPC (or its squad): treated as hostile regardless of faction. */
  grudges: Set<number>;
}
export const Npc = defineComponent<Npc>('Npc');

export type BrainState = 'idle' | 'patrol' | 'investigate' | 'combat' | 'retreat';

/** NPC decision-making state (see game/ai/NpcBrainSystem.ts). Not saved: NPCs restart at their camp. */
export interface Brain {
  state: BrainState;
  stateTime: number;
  behavior: 'guard' | 'patrol';
  homeX: number;
  homeY: number;
  radius: number;
  waypoints: { x: number; y: number }[];
  waypointIndex: number;
  /** Current hostile being fought. */
  target: number | null;
  targetVisible: boolean;
  lastSeenX: number;
  lastSeenY: number;
  sinceSeen: number;
  /** Spotting meter for the best not-yet-noticed hostile (0..1). */
  awareness: number;
  candidate: number | null;
  /** Point to investigate (noise, squad alert). */
  interestX: number;
  interestY: number;
  /** Movement goal and the path to it. */
  goal: { x: number; y: number } | null;
  path: { x: number; y: number }[];
  repathIn: number;
  stuckFor: number;
  /** Combat pacing. */
  thinkIn: number;
  reaction: number;
  burstLeft: number;
  pauseLeft: number;
  strafeDir: 1 | -1;
  /** Seconds until the next idle wander / patrol stop ends. */
  waitLeft: number;
  barkCooldown: number;
  /** Faces this point when standing still (talking to the player, looking around). */
  lookAt: { x: number; y: number } | null;
  /** The live grenade this NPC is running from, and the beat before it reacts. */
  dodging: number | null;
  dodgeIn: number;
  /** Seconds before this NPC will consider throwing a grenade again. */
  grenadeIn: number;
}
export const Brain = defineComponent<Brain>('Brain');

export function newBrain(behavior: 'guard' | 'patrol', x: number, y: number, radius: number, waypoints: { x: number; y: number }[]): Brain {
  return {
    state: behavior === 'patrol' ? 'patrol' : 'idle',
    stateTime: 0,
    behavior,
    homeX: x,
    homeY: y,
    radius,
    waypoints,
    waypointIndex: 0,
    target: null,
    targetVisible: false,
    lastSeenX: x,
    lastSeenY: y,
    sinceSeen: 99,
    awareness: 0,
    candidate: null,
    interestX: x,
    interestY: y,
    goal: null,
    path: [],
    repathIn: 0,
    stuckFor: 0,
    dodging: null,
    dodgeIn: 0,
    grenadeIn: 12 + Math.random() * 18,
    thinkIn: Math.random() * 0.25,
    reaction: 0,
    burstLeft: 0,
    pauseLeft: 0,
    strafeDir: 1,
    waitLeft: Math.random() * 3,
    barkCooldown: Math.random() * 4,
    lookAt: null,
  };
}

/** A fixed hazard (see content/types/anomaly.ts). Position is its Transform. */
export interface Anomaly {
  defId: string;
  state: 'idle' | 'windup' | 'cooldown';
  /** Seconds left in the current state. */
  timer: number;
  /** For effects: seconds since it last went off. */
  sinceBurst: number;
}
export const Anomaly = defineComponent<Anomaly>('Anomaly');

/** A thrown bolt: flies in an arc, then lies on the ground (and sets off anomalies it touches). */
export interface Bolt {
  /** Ground position it flies over, and its height above the ground. */
  vx: number;
  vy: number;
  z: number;
  vz: number;
  landed: boolean;
  /** Seconds until it disappears. */
  life: number;
}
export const Bolt = defineComponent<Bolt>('Bolt');

// ---- Explosives (Module 17) -------------------------------------------------

/**
 * A grenade or a placed charge in the world.
 *   thrown: flying → rolling → fuse (burning down at rest) → bang
 *   placed: arming → armed (waiting for someone) → triggered (click / beep) → bang
 */
export interface Explosive {
  defId: string;
  state: 'flying' | 'rolling' | 'fuse' | 'arming' | 'armed' | 'triggered';
  /** Seconds left in the current state (fuse, arming, trigger delay). */
  timer: number;
  /** Who threw / placed it (credited for the damage). */
  owner: number | null;
  /** The side it ignores (its placer's faction); null = anyone sets it off. */
  faction: string | null;
  /** Facing, radians (claymores fire this way). */
  angle: number;
  /** Thrown: ground velocity, height and vertical speed. */
  vx: number;
  vy: number;
  z: number;
  vz: number;
  /** Thrown: rolling deceleration (px/s²), set on landing so it stops near where it was aimed. */
  friction: number;
  /** Thrown: the aim point; null once it's bounced off a wall. */
  aimX: number | null;
  aimY: number;
  /** Placed ones remember where they're saved: generated hazards (`generated`) or the player's (saved entities). */
  recordId: string | null;
  chunkKey: string | null;
  generated: boolean;
  /** Hidden ones (landmines) once someone has noticed them. */
  spotted: boolean;
  /** For drawing: how far it has rolled (spins the sprite). */
  spin: number;
}
export const Explosive = defineComponent<Explosive>('Explosive');

// ---- Lighting (Module 18) ----------------------------------------------------------

/** A flashlight: a beam in the direction the character aims (or faces). */
export interface Flashlight {
  on: boolean;
}
export const Flashlight = defineComponent<Flashlight>('Flashlight');

// ---- Creatures (Module 20) ---------------------------------------------------

/**
 * A wild creature (see content/types/creature.ts). `id` is stable per lair
 * member and respawn epoch (`<lairId>:<index>@<epoch>`) so its death is saved.
 */
export interface Creature {
  defId: string;
  id: string;
  lairId: string;
  /** Facing, radians (turns smoothly at the creature's agility). */
  heading: number;
  /** Entities that hurt it (or its pack): fought regardless of faction. */
  grudges: Set<number>;
  /** 0 invisible .. 1 plain to see (a shade's cloak). */
  visibility: number;
  /** Under the ground (a burrower): bullets and eyes can't find it. */
  hidden: boolean;
}
export const Creature = defineComponent<Creature>('Creature');

export type CreatureState = 'rest' | 'wander' | 'alert' | 'stalk' | 'chase' | 'attack' | 'flee' | 'return';

/** An attack in progress: wind-up (the tell), the strike itself, then recovery. */
export interface CreatureAttackState {
  /** Index into the def's attacks. */
  index: number;
  phase: 'windup' | 'strike' | 'recover';
  /** Seconds into the phase and its length. */
  t: number;
  dur: number;
  /** Where it was aimed when the strike began (charges and pounces commit to it). */
  aimX: number;
  aimY: number;
  fromX: number;
  fromY: number;
  /** Who it already hit (a charge hits each victim once). */
  hit: number[];
}

/** Creature decision-making state (see game/ai/CreatureBrainSystem.ts). Not saved. */
export interface CreatureBrain {
  state: CreatureState;
  stateTime: number;
  homeX: number;
  homeY: number;
  radius: number;
  target: number | null;
  lastSeenX: number;
  lastSeenY: number;
  sinceSeen: number;
  /** What it's running from. */
  threatX: number;
  threatY: number;
  goal: { x: number; y: number } | null;
  path: { x: number; y: number }[];
  repathIn: number;
  stuckFor: number;
  thinkIn: number;
  waitLeft: number;
  /** Seconds until each attack can be used again. */
  cooldowns: number[];
  attack: CreatureAttackState | null;
  /** Circling a target before darting in: which way round. */
  orbit: 1 | -1;
  /** Seconds until the next idle noise. */
  voiceIn: number;
  /** Pounce height (px) and burrow depth (0 surfaced .. 1 under). */
  lift: number;
  buried: number;
  /** Seconds a cloak stays down after striking or being hurt. */
  revealed: number;
  sinceHurt: number;
}
export const CreatureBrain = defineComponent<CreatureBrain>('CreatureBrain');

/** Render-side handle for a creature. */
export const CreatureViewC = defineComponent<import('../render/CreatureView').CreatureView>('CreatureView');

/** A lobbed glob of acid (a spitter's): arcs to where it was aimed and splashes. */
export interface Spit {
  vx: number;
  vy: number;
  z: number;
  vz: number;
  damage: number;
  type: import('../content/types/weapon').DamageType;
  splash: number;
  color: string;
  owner: number;
  faction: string;
  /** Seconds left in the air (lands when it runs out or hits a wall). */
  left: number;
}
export const Spit = defineComponent<Spit>('Spit');
