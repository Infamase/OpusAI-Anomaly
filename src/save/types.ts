import type { Direction } from '../core/math';
import type { ChannelColors } from '../render/palette';

/**
 * Bump when the save format changes, and add a step to migrations.ts that
 * upgrades the previous version. Old saves keep loading forever.
 */
export const SAVE_VERSION = 3;

export interface SaveMeta {
  slotId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  playTimeSec: number;
  gameVersion: string;
  /** Packs active when saved, so we can warn if one goes missing. */
  contentPacks: { id: string; version: string }[];
}

/** One concrete item the player owns. Defs are content; instances are save data. */
export interface ItemInstance {
  /** Unique per item, used as the stat-modifier source ("item:<uid>"). */
  uid: string;
  /** Content id of the item's definition. */
  defId: string;
  /** 0..1 durability. Worn armor protects less; worn guns spread more. */
  condition: number;
  /** Stack size for stackable items (ammo). Missing means 1. */
  count?: number;
  /** Weapons: rounds in the magazine and which ammo they are. */
  loaded?: number;
  loadedAmmo?: string;
}

export type ArmorSlotId = 'head' | 'torso' | 'legs';
export type WeaponSlotId = 'primary' | 'sidearm';
export type EquipmentSlot = ArmorSlotId | WeaponSlotId;
export type EquipmentSave = Partial<Record<EquipmentSlot, ItemInstance>>;

export interface PlayerSave {
  name: string;
  raceId: string;
  colors: ChannelColors;
  worldId: string;
  x: number;
  y: number;
  facing: Direction;
  equipment: EquipmentSave;
  /** Everything carried that isn't equipped. */
  inventory: ItemInstance[];
  /** Weapon slot in hand, or null for holstered. */
  activeWeapon: WeaponSlotId | null;
  /** Current hit points; missing means full. */
  health?: number;
}

/**
 * A world (planet, station, ship) is saved as the recipe to regenerate it —
 * never the full map. What the player changed is stored separately as chunk deltas.
 */
export interface WorldRecord {
  worldId: string;
  /** worldGen content id. */
  genId: string;
  seed: number;
  /** Generator version at creation; lets future generator changes keep old worlds stable. */
  genVersion: number;
  firstVisitedAt: number;
  lastVisitedAt: number;
}

export interface SaveData {
  version: number;
  meta: SaveMeta;
  player: PlayerSave;
  worlds: Record<string, WorldRecord>;
  /** Free-form progression flags (quests, discoveries...). */
  flags: Record<string, unknown>;
}

/**
 * Everything the player changed in one chunk compared to what the generator
 * produces from the seed. Tile ids are content ids (not numeric indices) so
 * saves survive content being added or reordered.
 */
export interface ChunkDelta {
  /** Local tile index (y * chunkSize + x) -> tile id. */
  tiles: Record<string, string>;
  /** Generated entities that no longer exist (looted crates, killed spawns...). */
  removed: string[];
  /** Entities the player introduced or changed (dropped items, looted containers...). */
  entities: WorldEntityRecord[];
}

/**
 * A saved world object. `kind` decides how it's restored:
 * - "item": an item lying on the ground (data: ItemInstance)
 * - "container": the current contents of a generated container (data: ItemInstance[])
 */
export interface WorldEntityRecord {
  id: string;
  kind: string;
  x: number;
  y: number;
  data: unknown;
}

export interface ChunkDeltaRecord {
  slotId: string;
  worldId: string;
  chunkKey: string;
  version: number;
  delta: ChunkDelta;
}

export const emptyChunkDelta = (): ChunkDelta => ({ tiles: {}, removed: [], entities: [] });

export function isChunkDeltaEmpty(d: ChunkDelta): boolean {
  return Object.keys(d.tiles).length === 0 && d.removed.length === 0 && d.entities.length === 0;
}
