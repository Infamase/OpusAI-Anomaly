import type { ContentRegistry } from '../Registry';
import { ammoType } from './ammo';
import { anomalyType } from './anomaly';
import { artifactType } from './artifact';
import { detectorType } from './detector';
import { keycardType } from './keycard';
import { explosiveType } from './explosive';
import { biomeType } from './biome';
import { armorType } from './armor';
import { consumableType } from './consumable';
import { factionType } from './faction';
import { npcTemplateType } from './npcTemplate';
import { lootTableType } from './lootTable';
import { raceType } from './race';
import { roomType } from './room';
import { soundType } from './sound';
import { spriteLayoutType } from './spriteLayout';
import { statType } from './stat';
import { structureType } from './structure';
import { tileType } from './tile';
import { weaponType } from './weapon';
import { worldGenType } from './worldGen';

/**
 * Every content type the game understands. Adding a new kind of content
 * (weapon, armor, faction, station chunk...) = one new file in this folder + one
 * line here.
 */
export function defineCoreContentTypes(registry: ContentRegistry): void {
  registry.defineType(statType);
  registry.defineType(soundType);
  registry.defineType(spriteLayoutType);
  registry.defineType(raceType);
  registry.defineType(armorType);
  registry.defineType(ammoType);
  registry.defineType(weaponType);
  registry.defineType(consumableType);
  registry.defineType(anomalyType);
  registry.defineType(artifactType);
  registry.defineType(detectorType);
  registry.defineType(keycardType);
  registry.defineType(explosiveType);
  registry.defineType(lootTableType);
  registry.defineType(factionType);
  registry.defineType(npcTemplateType);
  registry.defineType(tileType);
  registry.defineType(biomeType);
  registry.defineType(structureType);
  registry.defineType(roomType);
  registry.defineType(worldGenType);
}

export type { AmmoDef } from './ammo';
export type { AnomalyDef } from './anomaly';
export type { ArtifactDef } from './artifact';
export type { DetectorDef } from './detector';
export type { KeycardDef } from './keycard';
export type { ExplosiveDef } from './explosive';
export type { BiomeDef } from './biome';
export type { StructureDef } from './structure';
export type { ArmorDef } from './armor';
export type { ConsumableDef } from './consumable';
export type { FactionDef } from './faction';
export type { NpcTemplateDef } from './npcTemplate';
export type { LootTableDef } from './lootTable';
export type { RaceDef } from './race';
export type { RoomDef } from './room';
export type { SoundDef } from './sound';
export type { SpriteLayoutDef } from './spriteLayout';
export type { TileDef } from './tile';
export type { WeaponDef } from './weapon';
export type { WorldGenDef } from './worldGen';
