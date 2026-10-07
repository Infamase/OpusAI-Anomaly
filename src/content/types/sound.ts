import type { ContentTypeSpec } from '../Registry';
import { v, type Infer, type Validator } from '../schema';
import { FILTER_TYPES, SYNTH_WAVES, type SynthRecipe } from '../../audio/synth';

declare module '../Registry' {
  interface ContentMap {
    sound: SoundDef;
  }
}

/** Mixer channels, each with its own volume setting. */
export const SOUND_BUSES = ['sfx', 'ui', 'ambient', 'voice'] as const;
export type SoundBus = (typeof SOUND_BUSES)[number];

/**
 * Things the engine wants to make a noise for. Code names the *moment*; content
 * picks the sound by giving a def `"cue": "<name>"`. More specific references
 * (a weapon's own gunshot, a tile's footstep) win over the cue.
 */
export const SOUND_CUES = [
  'ui_click',
  'ui_open',
  'ui_close',
  'pickup',
  'equip',
  'use_item',
  'shot',
  'dry_fire',
  'reload',
  'reload_done',
  'weapon_switch',
  'impact',
  'hit_flesh',
  'hit_armor',
  'death',
  'footstep',
  'hit_marker',
  'kill_marker',
  'heartbeat',
  'bark',
  'player_death',
  'ambient',
  'anomaly_burst',
  'geiger',
  'bolt_throw',
  'bolt_land',
  'detector_beep',
  'portal',
  'door_open',
  'door_close',
  'door_locked',
  'door_unlock',
  'break',
] as const;
export type SoundCue = (typeof SOUND_CUES)[number];

const range2 = v.tuple2(v.number({ min: 0.1 }), v.number({ min: 0.1 }));

const recipe: Validator<SynthRecipe> = v.object({
  layers: v.array(
    v.object({
      wave: v.literal(...SYNTH_WAVES),
      freq: v.optional(range2),
      start: v.optional(v.number({ min: 0 })),
      length: v.number({ min: 0.005, max: 30 }),
      attack: v.optional(v.number({ min: 0 })),
      hold: v.optional(v.number({ min: 0 })),
      curve: v.optional(v.number({ min: 0, max: 20 })),
      gain: v.optional(v.number({ min: 0 })),
      filter: v.optional(v.object({ type: v.literal(...FILTER_TYPES), freq: range2, q: v.optional(v.number({ min: 0.05, max: 40 })) })),
      lfo: v.optional(v.tuple2(v.number({ min: 0 }), v.number({ min: 0, max: 1 }))),
    }),
    { min: 1 },
  ),
  drive: v.optional(v.number({ min: 1, max: 20 })),
  echo: v.optional(v.object({ delay: v.number({ min: 0.005, max: 1 }), feedback: v.number({ min: 0, max: 0.9 }), mix: v.number({ min: 0, max: 1 }) })),
  gain: v.optional(v.number({ min: 0, max: 1 })),
  loop: v.optional(v.boolean()),
  vary: v.optional(v.number({ min: 0, max: 0.5 })),
});

const schema = v.object({
  id: v.id(),
  /** Engine moment this sound plays for (see SOUND_CUES). */
  cue: v.optional(v.literal(...SOUND_CUES)),
  bus: v.optional(v.literal(...SOUND_BUSES), 'sfx'),
  volume: v.optional(v.number({ min: 0, max: 4 }), 1),
  /** Random pitch change per play, as a fraction (0.05 = ±5%). */
  pitchJitter: v.optional(v.number({ min: 0, max: 0.5 }), 0.05),
  /** Positional sounds fade out to silence at this distance (px; 32 px = 1 tile). 0 = always full volume, centered. */
  range: v.optional(v.number({ min: 0 }), 640),
  /** At most this many copies play at once (the oldest is cut). */
  maxVoices: v.optional(v.number({ int: true, min: 1, max: 32 }), 4),
  /** Repeats closer together than this (seconds) are skipped. */
  minInterval: v.optional(v.number({ min: 0 }), 0.03),
  /** Generated variations to pick from at random. */
  variants: v.optional(v.number({ int: true, min: 1, max: 8 }), 3),
  /** Generated stand-in audio… */
  synth: v.optional(recipe),
  /** …or a recording (a URL relative to the site root, e.g. "audio/ak_shot.ogg"). */
  file: v.optional(v.string({ nonEmpty: true })),
});

export type SoundDef = Infer<typeof schema>;

export const soundType: ContentTypeSpec<'sound'> = {
  type: 'sound',
  schema,
  crossCheck(def, ctx) {
    if (!def.synth === !def.file) ctx.error('needs exactly one of "synth" or "file"');
  },
};

/** Optional per-def sound references, e.g. a weapon's `sounds: { shot: "..." }`. */
export function soundRefs<const K extends string>(...keys: K[]): Validator<Partial<Record<K, string>> | undefined> {
  const shape = Object.fromEntries(keys.map((k) => [k, v.optional(v.id())])) as Record<K, Validator<string | undefined>>;
  return v.optional(v.object(shape)) as Validator<Partial<Record<K, string>> | undefined>;
}

export function checkSoundRefs(refs: Partial<Record<string, string>> | undefined, ctx: { ref(type: 'sound', id: string, where: string): void }): void {
  for (const [k, id] of Object.entries(refs ?? {})) if (id) ctx.ref('sound', id, `sounds.${k}`);
}
