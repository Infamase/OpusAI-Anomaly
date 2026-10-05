import type { ContentRegistry } from '../Registry';
import { ammoType } from './ammo';
import { armorType } from './armor';
import { consumableType } from './consumable';
import { factionType } from './faction';
import { npcTemplateType } from './npcTemplate';
import { lootTableType } from './lootTable';
import { raceType } from './race';
import { spriteLayoutType } from './spriteLayout';
import { statType } from './stat';
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
  registry.defineType(spriteLayoutType);
  registry.defineType(raceType);
  registry.defineType(armorType);
  registry.defineType(ammoType);
  registry.defineType(weaponType);
  registry.defineType(consumableType);
  registry.defineType(lootTableType);
  registry.defineType(factionType);
  registry.defineType(npcTemplateType);
  registry.defineType(tileType);
  registry.defineType(worldGenType);
}

export type { AmmoDef } from './ammo';
export type { ArmorDef } from './armor';
export type { ConsumableDef } from './consumable';
export type { FactionDef } from './faction';
export type { NpcTemplateDef } from './npcTemplate';
export type { LootTableDef } from './lootTable';
export type { RaceDef } from './race';
export type { SpriteLayoutDef } from './spriteLayout';
export type { TileDef } from './tile';
export type { WeaponDef } from './weapon';
export type { WorldGenDef } from './worldGen';
