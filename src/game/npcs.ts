import type { Rng } from '../core/rng';
import type { ContentRegistry } from '../content/Registry';
import type { ChannelColors } from '../render/palette';
import type { NpcTemplateDef } from '../content/types';
import type { EquipmentSave, ItemInstance } from '../save/types';
import { ARMOR_SLOTS, armorFor, createItem } from './equipment';
import { addItem, createLoadedWeapon } from './items';
import { rollLoot } from './loot';

export interface StalkerLook {
  raceId: string;
  colors: ChannelColors;
  equipment: EquipmentSave;
}

/**
 * Rolls a random Stalker: any playable race, a color from that race's presets
 * (keeps the recolor cache small), armor that fits, and a primary or sidearm.
 * Used for bandits now and for friendly/neutral Stalkers once factions exist.
 */
export function generateStalker(content: ContentRegistry, rng: Rng, opts: { raceId?: string } = {}): StalkerLook {
  const races = content.all('race').filter((r) => r.playable);
  const race = opts.raceId ? content.get('race', opts.raceId) : rng.pick(races);
  const colors: ChannelColors = {};
  for (const ch of race.colorChannels) colors[ch.channel] = ch.presets.length ? rng.pick(ch.presets) : ch.default;

  const equipment: EquipmentSave = {};
  for (const slot of ARMOR_SLOTS) {
    const options = armorFor(content, race.id, slot);
    if (options.length && rng.chance(0.8)) equipment[slot] = createItem(rng.pick(options).id);
  }
  const primaries = content.all('weapon').filter((w) => w.slot === 'primary');
  const sidearms = content.all('weapon').filter((w) => w.slot === 'sidearm');
  if (primaries.length && rng.chance(0.75)) equipment.primary = createLoadedWeapon(content, rng.pick(primaries).id);
  if (sidearms.length) equipment.sidearm = createLoadedWeapon(content, rng.pick(sidearms).id);
  return { raceId: race.id, colors, equipment };
}

export interface NpcLoadout extends StalkerLook {
  name: string;
  skill: number;
  inventory: ItemInstance[];
}

/**
 * Builds one NPC from a template: race, colors, a callsign from the faction,
 * armor from the template's sets, weapons with real spare ammo, and carried
 * items. Everything the NPC owns is what its body drops.
 */
export function generateFromTemplate(content: ContentRegistry, rng: Rng, template: NpcTemplateDef): NpcLoadout {
  const playable = content.all('race').filter((r) => r.playable);
  const allowed = template.races.length ? template.races.map((id) => content.get('race', id)) : playable;
  const race = rng.pick(allowed);
  const colors: ChannelColors = {};
  for (const ch of race.colorChannels) colors[ch.channel] = ch.presets.length ? rng.pick(ch.presets) : ch.default;

  const equipment: EquipmentSave = {};
  for (const slot of ARMOR_SLOTS) {
    const options = armorFor(content, race.id, slot).filter((a) => a.set !== undefined && template.armorSets.includes(a.set));
    if (options.length && rng.chance(template.armorChance)) {
      const piece = createItem(rng.pick(options).id);
      piece.condition = round2(rng.range(0.45, 1));
      equipment[slot] = piece;
    }
  }

  const inventory: ItemInstance[] = [];
  const arm = (slot: 'primary' | 'sidearm', id: string) => {
    const w = createLoadedWeapon(content, id);
    w.condition = round2(rng.range(0.5, 1));
    equipment[slot] = w;
    const def = content.get('weapon', id);
    const mags = rng.int(Math.round(template.spareMagazines[0]), Math.round(template.spareMagazines[1]));
    if (mags > 0) addItem(content, inventory, createItem(def.ammo[0]!, mags * def.magazine));
  };
  if (template.primaries.length && rng.chance(template.primaryChance)) arm('primary', rng.pick(template.primaries));
  arm('sidearm', rng.pick(template.sidearms));

  for (const c of template.carries) {
    if (rng.chance(c.chance)) addItem(content, inventory, createItem(c.item, rng.int(c.count[0], c.count[1])));
  }
  if (template.pockets) for (const it of rollLoot(content, template.pockets, rng)) addItem(content, inventory, it);

  const faction = content.get('faction', template.faction);
  const skill = rng.range(template.skill[0], template.skill[1]);
  return { raceId: race.id, colors, equipment, inventory, skill, name: rng.pick(faction.names) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
