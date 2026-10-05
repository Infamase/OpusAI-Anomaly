import type { Rng } from '../core/rng';
import type { ContentRegistry } from '../content/Registry';
import type { ChannelColors } from '../render/palette';
import type { EquipmentSave } from '../save/types';
import { ARMOR_SLOTS, armorFor, createItem } from './equipment';
import { createLoadedWeapon } from './items';

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
