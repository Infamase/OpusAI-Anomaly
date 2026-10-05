import type { ContentRegistry } from '../Registry';
import { raceType } from './race';
import { spriteLayoutType } from './spriteLayout';
import { statType } from './stat';
import { tileType } from './tile';
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
  registry.defineType(tileType);
  registry.defineType(worldGenType);
}

export type { RaceDef } from './race';
export type { SpriteLayoutDef } from './spriteLayout';
export type { TileDef } from './tile';
export type { WorldGenDef } from './worldGen';
