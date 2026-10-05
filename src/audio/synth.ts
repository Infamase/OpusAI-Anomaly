import { Rng } from '../core/rng';

/**
 * A tiny offline synthesizer: sounds are recipes in content files (layers of
 * oscillators and filtered noise with envelopes), rendered to sample buffers
 * once at startup. Stand-in audio, like the generated placeholder art: a sound
 * def can point at a real recording instead and the game doesn't care which.
 *
 * Pure and deterministic (seeded), so it runs and is tested without WebAudio.
 */

export const SYNTH_WAVES = ['sine', 'square', 'saw', 'triangle', 'noise', 'brown', 'crackle'] as const;
export type SynthWave = (typeof SYNTH_WAVES)[number];
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];

export interface SynthLayer {
  wave: SynthWave;
  /** Oscillator pitch in Hz at the start and end (exponential sweep). Crackle: impulses per second. */
  freq?: [number, number];
  /** When the layer starts and how long it lasts, in seconds. */
  start?: number;
  length: number;
  /** Fade-in time (s), then full volume for `hold` seconds, then the decay. */
  attack?: number;
  hold?: number;
  /** Decay shape: 1 = linear fade, higher = punchier. 0 = no decay (sustain, for loops). */
  curve?: number;
  gain?: number;
  /** A filter whose cutoff sweeps from the first to the second value (Hz). */
  filter?: { type: FilterType; freq: [number, number]; q?: number };
  /** Slow volume wobble: [rate Hz, depth 0..1]. */
  lfo?: [number, number];
}

export interface SynthRecipe {
  layers: SynthLayer[];
  /** Soft-clip saturation (1 = none, 3 = gritty). */
  drive?: number;
  /** A single feedback echo, for room or valley reflections. */
  echo?: { delay: number; feedback: number; mix: number };
  /** Peak level after normalizing (0..1). */
  gain?: number;
  /** Rendered so the end flows into the start (ambience). */
  loop?: boolean;
  /** How much each variant randomizes pitches and cutoffs (0..0.5). */
  vary?: number;
}

export const SYNTH_RATE = 24000;
const LOOP_XFADE = 0.25;

/** Renders one variant of a recipe to mono samples in -1..1. */
export function synthesize(recipe: SynthRecipe, seed: number, rate = SYNTH_RATE): Float32Array {
  const rng = new Rng(seed);
  const vary = recipe.vary ?? 0;
  const jitter = (x: number) => x * (1 + (rng.next() * 2 - 1) * vary);
  const tail = recipe.echo ? recipe.echo.delay * 4 : 0;
  const end = Math.max(...recipe.layers.map((l) => (l.start ?? 0) + l.length));
  const len = recipe.loop ? end : end + tail;
  const extra = recipe.loop ? LOOP_XFADE : 0;
  const n = Math.max(1, Math.ceil((len + extra) * rate));
  const out = new Float32Array(n);

  for (const layer of recipe.layers) {
    const freq = layer.freq ? ([jitter(layer.freq[0]), jitter(layer.freq[1])] as const) : null;
    const filter = layer.filter ? { ...layer.filter, freq: [jitter(layer.filter.freq[0]), jitter(layer.filter.freq[1])] as const } : null;
    renderLayer(out, layer, freq, filter, rng, rate, recipe.loop ? extra : 0);
  }

  if (recipe.echo) {
    const d = Math.max(1, Math.round(recipe.echo.delay * rate));
    const { feedback, mix } = recipe.echo;
    const wet = new Float32Array(n);
    for (let i = d; i < n; i++) wet[i] = (out[i - d]! + wet[i - d]! * feedback) * 1;
    for (let i = 0; i < n; i++) out[i] = out[i]! + wet[i]! * mix;
  }

  const drive = recipe.drive ?? 1;
  if (drive > 1) {
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]! * drive) / norm;
  }

  let result = out;
  if (recipe.loop) {
    // Crossfade the overhang past the end into the start, then cut: a seamless loop.
    const body = Math.ceil(len * rate);
    const xf = Math.min(n - body, body);
    result = out.slice(0, body);
    for (let i = 0; i < xf; i++) {
      const t = i / xf;
      result[i] = result[i]! * t + out[body + i]! * (1 - t);
    }
  }

  // Normalize to the requested peak so recipes don't need hand-balanced gains.
  let peak = 0;
  for (let i = 0; i < result.length; i++) peak = Math.max(peak, Math.abs(result[i]!));
  if (peak > 0) {
    const k = (recipe.gain ?? 0.8) / peak;
    for (let i = 0; i < result.length; i++) result[i] = result[i]! * k;
  }
  return result;
}

function renderLayer(
  out: Float32Array,
  l: SynthLayer,
  freq: readonly [number, number] | null,
  filter: { type: FilterType; freq: readonly [number, number]; q?: number } | null,
  rng: Rng,
  rate: number,
  overhang: number,
): void {
  const start = Math.round((l.start ?? 0) * rate);
  const count = Math.ceil((l.length + overhang) * rate);
  const length = l.length;
  const attack = l.attack ?? 0.002;
  const hold = l.hold ?? 0;
  const curve = l.curve ?? 2;
  const gain = l.gain ?? 1;
  const biquad = filter ? new Biquad() : null;
  let phase = rng.next();
  let brown = 0;

  for (let i = 0; i < count && start + i < out.length; i++) {
    const t = i / rate;
    const u = Math.min(1, t / length);
    const f = freq ? freq[0] * Math.pow(freq[1] / freq[0], u) : 440;
    let s: number;
    switch (l.wave) {
      case 'sine':
        s = Math.sin(phase * 2 * Math.PI);
        break;
      case 'square':
        s = phase < 0.5 ? 1 : -1;
        break;
      case 'saw':
        s = phase * 2 - 1;
        break;
      case 'triangle':
        s = 1 - 4 * Math.abs(phase - 0.5);
        break;
      case 'noise':
        s = rng.next() * 2 - 1;
        break;
      case 'brown':
        brown = (brown + (rng.next() * 2 - 1) * 0.08) * 0.995;
        s = brown * 3;
        break;
      case 'crackle':
        s = rng.next() < f / rate ? (rng.next() * 2 - 1) * 1.5 : 0;
        break;
    }
    phase = (phase + f / rate) % 1;

    if (biquad && filter) {
      if ((i & 31) === 0) biquad.set(filter.type, filter.freq[0] * Math.pow(filter.freq[1] / filter.freq[0], u), filter.q ?? 0.8, rate);
      s = biquad.run(s);
    }

    let env: number;
    if (t < attack) env = t / attack;
    else if (curve === 0 || t < attack + hold) env = 1;
    else env = Math.pow(Math.max(0, 1 - (t - attack - hold) / Math.max(1e-4, length - attack - hold)), curve);
    if (l.lfo) env *= 1 - l.lfo[1] * 0.5 * (1 + Math.sin(2 * Math.PI * l.lfo[0] * t));
    out[start + i] = out[start + i]! + s * env * gain;
  }
}

/** RBJ-cookbook biquad (direct form I). */
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  set(type: FilterType, cutoff: number, q: number, rate: number): void {
    const w = (2 * Math.PI * Math.min(cutoff, rate * 0.45)) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    let b0: number, b1: number, b2: number;
    if (type === 'lowpass') {
      b1 = 1 - cos;
      b0 = b2 = b1 / 2;
    } else if (type === 'highpass') {
      b1 = -(1 + cos);
      b0 = b2 = (1 + cos) / 2;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}
