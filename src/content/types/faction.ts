import type { ContentTypeSpec } from '../Registry';
import { v, type Infer } from '../schema';
import { checkSoundRefs, soundRefs } from './sound';

declare module '../Registry' {
  interface ContentMap {
    faction: FactionDef;
  }
}

export const ATTITUDES = ['hostile', 'neutral', 'friendly'] as const;
export type Attitude = (typeof ATTITUDES)[number];

/**
 * A group in the Zone. Attitudes between two factions are taken from both
 * sides: hostile if either side is hostile, friendly only if both are.
 * The player belongs to one faction (their affiliation) and also has a personal
 * reputation with every faction (see game/factions.ts).
 */
const schema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  description: v.optional(v.string(), ''),
  /** UI color for names and markers. */
  color: v.color(),
  /** Attitude toward other factions; unlisted ones use defaultAttitude. Members of the same faction are always friendly. */
  relations: v.optional(v.record(v.literal(...ATTITUDES)), {} as Record<string, Attitude>),
  defaultAttitude: v.optional(v.literal(...ATTITUDES), 'neutral'),
  /** Callsigns for generated members. */
  names: v.array(v.string({ nonEmpty: true }), { min: 1 }),
  /** Short lines NPCs shout. Missing keys fall back to generic lines. */
  barks: v.optional(v.record(v.array(v.string({ nonEmpty: true }))), {} as Record<string, string[]>),
  /** Played with a bark (otherwise the bark cue): a radio squelch, a grunt… */
  sounds: soundRefs('bark'),
});

export type FactionDef = Infer<typeof schema>;

export const factionType: ContentTypeSpec<'faction'> = {
  type: 'faction',
  schema,
  crossCheck(def, ctx) {
    for (const id of Object.keys(def.relations)) ctx.ref('faction', id, `relations.${id}`);
    checkSoundRefs(def.sounds, ctx);
  },
};
