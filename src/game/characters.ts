import type { Direction } from '../core/math';
import type { ContentRegistry } from '../content/Registry';
import type { RaceDef } from '../content/types';
import type { Entity, World } from '../ecs/World';
import { CharacterView } from '../render/CharacterView';
import type { ChannelColors } from '../render/palette';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave, ItemInstance } from '../save/types';
import { StatBlock } from '../stats/Stats';
import { Aim, Character, Collider, Equipment, Stats, Transform, Velocity, View } from './components';
import { applyEquipmentStats, ARMOR_SLOTS, fitProblem, prepareEquipmentArt, refreshArmorLayers } from './equipment';

/** The race's default colors, with any overrides applied. */
export function resolveColors(race: RaceDef, colors: ChannelColors = {}): ChannelColors {
  const out: ChannelColors = {};
  for (const ch of race.colorChannels) out[ch.channel] = colors[ch.channel] ?? ch.default;
  return out;
}

/** Fresh stat block for a race: stat defaults, then the race's base values. */
export function buildRaceStats(content: ContentRegistry, race: RaceDef): StatBlock {
  const defs = new Map(content.all('stat').map((d) => [d.id, d]));
  const stats = new StatBlock(defs);
  for (const [id, value] of Object.entries(race.baseStats)) stats.setBase(id, value);
  return stats;
}

/** Race base stats plus every worn item's modifiers. */
export function buildCharacterStats(content: ContentRegistry, race: RaceDef, equipment: EquipmentSave): StatBlock {
  const stats = buildRaceStats(content, race);
  applyEquipmentStats(stats, content, equipment);
  return stats;
}

/** Loads the body sheet and all worn armor sheets. Call before spawning or changing appearance. */
export async function prepareCharacterArt(
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  raceId: string,
  equipment: EquipmentSave = {},
): Promise<void> {
  const race = content.get('race', raceId);
  await Promise.all([
    sheets.prepare(race.sheet, content.get('spriteLayout', race.spriteLayout)),
    prepareEquipmentArt(content, sheets, equipment),
  ]);
}

export interface SpawnCharacterOptions {
  raceId: string;
  colors?: ChannelColors;
  equipment?: EquipmentSave;
  x: number;
  y: number;
  facing?: Direction;
}

/**
 * Builds any biped — the player, a friendly Stalker, a bandit — from race,
 * colors and worn gear. Call prepareCharacterArt() first. Behaviour components
 * (PlayerControlled, AI...) are added by the caller.
 */
export function spawnCharacter(world: World, content: ContentRegistry, sheets: SpriteSheetCache, opts: SpawnCharacterOptions): Entity {
  const race = content.get('race', opts.raceId);
  const colors = resolveColors(race, opts.colors);
  const equipment: EquipmentSave = { ...(opts.equipment ?? {}) };
  const e = world.create();
  world.add(e, Transform, { x: opts.x, y: opts.y, prevX: opts.x, prevY: opts.y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: race.hitbox.w, h: race.hitbox.h });
  world.add(e, Character, { raceId: race.id, colors, facing: opts.facing ?? 'down', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Equipment, equipment);
  world.add(e, Stats, buildCharacterStats(content, race, equipment));
  world.add(e, Aim, { dir: null });
  const view = new CharacterView();
  view.setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), colors));
  world.add(e, View, view);
  refreshArmorLayers(world, content, sheets, e);
  return e;
}

/**
 * Switches a character's race and/or colors. On a race change, worn armor that
 * no longer fits comes off and is returned so the caller can stash it.
 */
export function setCharacterAppearance(
  world: World,
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  e: Entity,
  raceId: string,
  colors: ChannelColors,
): ItemInstance[] {
  const race = content.get('race', raceId);
  const ch = world.req(e, Character);
  const resolved = resolveColors(race, colors);
  const removed: ItemInstance[] = [];
  if (ch.raceId !== raceId) {
    const eq = world.req(e, Equipment);
    for (const slot of ARMOR_SLOTS) {
      const item = eq[slot];
      const def = item && content.tryGet('armor', item.defId);
      if (item && def && fitProblem(content, raceId, def)) {
        removed.push(item);
        delete eq[slot];
      }
    }
    world.add(e, Stats, buildCharacterStats(content, race, eq));
    world.add(e, Collider, { w: race.hitbox.w, h: race.hitbox.h });
  }
  ch.raceId = raceId;
  ch.colors = resolved;
  world.req(e, View).setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), resolved));
  refreshArmorLayers(world, content, sheets, e);
  return removed;
}
