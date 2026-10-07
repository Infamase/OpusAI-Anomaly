import { hashInts } from '../core/rng';
import type { RGB01 } from './lighting';

export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'storm', 'fog'] as const;
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** Weather settles for this long (game minutes) before it may change. */
export const WEATHER_SPELL = 6 * 60;
/** The last part of a spell blends into the next one (game minutes). */
const TRANSITION = 50;

/** How each kind of weather looks and feels (0..1 each). */
const KIND: Record<WeatherKind, { cloud: number; rain: number; fog: number; wind: number }> = {
  clear: { cloud: 0, rain: 0, fog: 0, wind: 0.2 },
  cloudy: { cloud: 0.65, rain: 0, fog: 0, wind: 0.45 },
  rain: { cloud: 0.85, rain: 0.65, fog: 0.1, wind: 0.5 },
  storm: { cloud: 1, rain: 1, fog: 0.15, wind: 1 },
  fog: { cloud: 0.45, rain: 0, fog: 0.85, wind: 0.05 },
};

/** The weather at a moment: the current kind (and the next, while it changes over) and how strong each part is. */
export interface Weather {
  kind: WeatherKind;
  next: WeatherKind;
  /** 0 = all `kind`, 1 = all `next`. */
  blend: number;
  cloud: number;
  rain: number;
  fog: number;
  /** Wind: strength 0..1 and the direction it blows toward (radians). */
  wind: number;
  windAngle: number;
  /** Lightning and thunder (storms). */
  lightning: boolean;
}

export type WeatherOdds = Partial<Record<WeatherKind, number>>;

/** The kind of weather in spell number `n` (fixed by the world's seed). */
function spellKind(seed: number, n: number, odds: WeatherOdds): WeatherKind {
  const kinds = WEATHER_KINDS.filter((k) => (odds[k] ?? 0) > 0);
  if (!kinds.length) return 'clear';
  // The first spell of a new game is always fair weather.
  if (n <= 1) return kinds.includes('clear') ? 'clear' : kinds[0]!;
  const total = kinds.reduce((t, k) => t + odds[k]!, 0);
  let r = ((hashInts(seed, n, 77) % 10000) / 10000) * total;
  for (const k of kinds) if ((r -= odds[k]!) < 0) return k;
  return kinds[kinds.length - 1]!;
}

/**
 * The weather at a time of day (game minutes), worked out from the seed so it
 * needn't be saved: spells of WEATHER_SPELL minutes, each blending into the
 * next over its last TRANSITION minutes. `override` pins a kind (dev tools).
 */
export function weatherAt(seed: number, minutes: number, odds: WeatherOdds, override?: WeatherKind | null): Weather {
  const n = Math.floor(minutes / WEATHER_SPELL);
  const into = minutes - n * WEATHER_SPELL;
  const kind = override ?? spellKind(seed, n, odds);
  const next = override ?? spellKind(seed, n + 1, odds);
  const blend = override ? 0 : Math.max(0, Math.min(1, (into - (WEATHER_SPELL - TRANSITION)) / TRANSITION));
  const a = KIND[kind];
  const b = KIND[next];
  const mix = (x: number, y: number) => x + (y - x) * blend;
  const angleA = ((hashInts(seed, n, 31) % 6283) / 1000);
  const angleB = ((hashInts(seed, n + 1, 31) % 6283) / 1000);
  return {
    kind,
    next,
    blend,
    cloud: mix(a.cloud, b.cloud),
    rain: mix(a.rain, b.rain),
    fog: mix(a.fog, b.fog),
    wind: mix(a.wind, b.wind),
    windAngle: angleA + Math.atan2(Math.sin(angleB - angleA), Math.cos(angleB - angleA)) * blend,
    lightning: (kind === 'storm' && blend < 0.7) || (next === 'storm' && blend > 0.3),
  };
}

/** Clouds and rain dim the daylight toward a cool grey. */
export function weatherTint(c: RGB01, w: Weather): RGB01 {
  const k = w.cloud * 0.22 + w.rain * 0.1 + w.fog * 0.05;
  const grey = (c[0] + c[1] + c[2]) / 3;
  const t = (v: number, bias: number) => (v + (grey * bias - v) * Math.min(1, w.cloud * 0.6)) * (1 - k);
  return [t(c[0], 0.95), t(c[1], 0.98), t(c[2], 1.05)];
}

/** How far people can see in this weather (multiplier on sight range). */
export const weatherSight = (w: Weather): number => Math.max(0.3, 1 - w.fog * 0.65 - w.rain * 0.25);

/** A name for the HUD. */
export function weatherLabel(w: Weather): string {
  const k = w.blend > 0.5 ? w.next : w.kind;
  return { clear: 'Clear', cloudy: 'Overcast', rain: 'Rain', storm: 'Storm', fog: 'Fog' }[k];
}
