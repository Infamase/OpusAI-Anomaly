import type { Direction } from '../core/math';
import type { ContentRegistry } from '../content/Registry';
import type { RaceDef } from '../content/types';
import type { Entity, World } from '../ecs/World';
import { CharacterView } from '../render/CharacterView';
import type { ChannelColors } from '../render/palette';
import type { SpriteSheetCache } from '../render/SpriteSheets';
import type { EquipmentSave, ItemInstance, WeaponSlotId } from '../save/types';
import { StatBlock } from '../stats/Stats';
import { Aim, Character, Collider, Combatant, Encumbrance, Equipment, Faction, Health, Inventory, newCombatant, Stamina, Stats, Transform, Velocity, View } from './components';
import { applyEquipmentStats, ARMOR_SLOTS, defaultActiveWeapon, fitProblem, prepareEquipmentArt, refreshArmorLayers } from './equipment';

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
  view.setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), colors), sheets.rig(race.sheet));
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
  world.req(e, View).setLayer('body', sheets.get(race.sheet, content.get('spriteLayout', race.spriteLayout), resolved), sheets.rig(race.sheet));
  refreshArmorLayers(world, content, sheets, e);
  return removed;
}

export interface CombatOptions {
  faction: string;
  /** Weapon slot in hand; defaults to primary, else sidearm. */
  active?: WeaponSlotId | null;
  inventory?: ItemInstance[];
  /** Starting hit points; defaults to full. */
  hp?: number;
  /** Starting radiation dose. */
  rads?: number;
  infiniteAmmo?: boolean;
}

/** Makes a spawned character able to fight and be hurt: health, stamina, weapons, inventory, faction. */
export function addCombatComponents(world: World, e: Entity, opts: CombatOptions): void {
  const stats = world.req(e, Stats);
  const eq = world.req(e, Equipment);
  const maxHp = stats.get('max_health');
  world.add(e, Health, { hp: Math.min(maxHp, opts.hp ?? maxHp), bleed: 0, dead: false, sinceHit: 99, regen: [], rads: opts.rads ?? 0 });
  world.add(e, Stamina, { current: stats.get('max_stamina'), exhausted: false, regenDelay: 0 });
  const active = opts.active !== undefined && opts.active !== null && eq[opts.active] ? opts.active : defaultActiveWeapon(eq);
  const combat = newCombatant(active);
  if (opts.infiniteAmmo) combat.infiniteAmmo = true;
  world.add(e, Combatant, combat);
  world.add(e, Inventory, opts.inventory ?? []);
  world.add(e, Faction, { id: opts.faction });
  world.add(e, Encumbrance, { weight: 0, limit: 0, level: 0 });
}
