import type { Direction } from '../core/math';
import type { ContentRegistry } from '../content/Registry';
import type { RaceDef } from '../content/types';
import type { Entity, World } from '../ecs/World';
import { CharacterView } from '../render/CharacterView';
import type { ChannelColors } from '../render/palette';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import { StatBlock } from '../stats/Stats';
import { Aim, Character, Collider, Stats, Transform, Velocity, View } from './components';

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

export async function prepareRaceArt(content: ContentRegistry, sheets: SpriteSheetCache, raceId: string): Promise<void> {
  const race = content.get('race', raceId);
  await sheets.prepare(race.sheet, content.get('spriteLayout', race.spriteLayout));
}

export interface SpawnCharacterOptions {
  raceId: string;
  colors?: ChannelColors;
  x: number;
  y: number;
  facing?: Direction;
}

/**
 * Builds any biped — the player, a friendly Stalker, a bandit — from race + colors.
 * Call prepareRaceArt() first. Behaviour components (PlayerControlled, AI...) are added by the caller.
 */
export function spawnCharacter(
  world: World,
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  opts: SpawnCharacterOptions,
): Entity {
  const race = content.get('race', opts.raceId);
  const colors = resolveColors(race, opts.colors);
  const e = world.create();
  world.add(e, Transform, { x: opts.x, y: opts.y, prevX: opts.x, prevY: opts.y });
  world.add(e, Velocity, { x: 0, y: 0 });
  world.add(e, Collider, { w: race.hitbox.w, h: race.hitbox.h });
  world.add(e, Character, { raceId: race.id, colors, facing: opts.facing ?? 'down', anim: 'idle', animTime: 0, sprinting: false });
  world.add(e, Stats, buildRaceStats(content, race));
  world.add(e, Aim, { dir: null });
  const view = new CharacterView();
  view.setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), colors));
  world.add(e, View, view);
  return e;
}

/** Switches an existing character's race and/or colors (player customization, debug). */
export function setCharacterAppearance(
  world: World,
  content: ContentRegistry,
  sheets: SpriteSheetCache,
  e: Entity,
  raceId: string,
  colors: ChannelColors,
): void {
  const race = content.get('race', raceId);
  const ch = world.req(e, Character);
  const resolved = resolveColors(race, colors);
  if (ch.raceId !== raceId) {
    // Race changed: rebuild racial stats. Gear/effect modifiers will be re-applied by their systems in Phase 1.
    world.add(e, Stats, buildRaceStats(content, race));
    world.add(e, Collider, { w: race.hitbox.w, h: race.hitbox.h });
  }
  ch.raceId = raceId;
  ch.colors = resolved;
  world.req(e, View).setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), resolved));
}
