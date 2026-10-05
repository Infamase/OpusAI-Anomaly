import { beforeAll, describe, expect, it } from 'vitest';
import { spatialize } from '../src/audio/AudioEngine';
import { synthesize, SYNTH_RATE, type SynthRecipe } from '../src/audio/synth';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { SOUND_CUES } from '../src/content/types/sound';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

const rms = (s: Float32Array, from = 0, to = s.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};

describe('synth', () => {
  const pop: SynthRecipe = { layers: [{ wave: 'noise', length: 0.2, curve: 3, filter: { type: 'lowpass', freq: [4000, 300] } }], gain: 0.7 };

  it('is deterministic per seed and differs between seeds', () => {
    expect(synthesize(pop, 1)).toEqual(synthesize(pop, 1));
    expect(synthesize(pop, 1)).not.toEqual(synthesize(pop, 2));
  });

  it('normalizes to the requested peak and decays', () => {
    const s = synthesize(pop, 7);
    expect(s.length).toBe(Math.ceil(0.2 * SYNTH_RATE));
    let peak = 0;
    for (const x of s) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeCloseTo(0.7, 5);
    const q = s.length / 4;
    expect(rms(s, 0, q)).toBeGreaterThan(rms(s, 3 * q) * 4);
  });

  it('renders loops that join up without a click', () => {
    const wind: SynthRecipe = { loop: true, layers: [{ wave: 'brown', length: 2, curve: 0, filter: { type: 'lowpass', freq: [500, 500] } }] };
    const s = synthesize(wind, 3);
    expect(s.length).toBe(2 * SYNTH_RATE);
    // The jump from the last sample back to the first is no bigger than a normal step.
    let maxStep = 0;
    for (let i = 1; i < s.length; i++) maxStep = Math.max(maxStep, Math.abs(s[i]! - s[i - 1]!));
    expect(Math.abs(s[0]! - s[s.length - 1]!)).toBeLessThanOrEqual(maxStep * 1.5);
  });

  it('tunes oscillators to the requested pitch', () => {
    const tone = synthesize({ layers: [{ wave: 'sine', freq: [440, 440], length: 0.5, curve: 0 }] }, 1);
    let crossings = 0;
    for (let i = 1; i < tone.length; i++) if (tone[i - 1]! < 0 && tone[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThanOrEqual(218);
    expect(crossings).toBeLessThanOrEqual(221);
  });
});

describe('spatial audio', () => {
  it('is loud up close, silent past the range, and pans to the side the sound is on', () => {
    expect(spatialize(0, 0, 600)!.gain).toBeCloseTo(1);
    expect(spatialize(700, 0, 600)).toBeNull();
    const near = spatialize(100, 0, 600)!;
    const far = spatialize(400, 0, 600)!;
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(far.muffle).toBeGreaterThan(near.muffle);
    expect(spatialize(-200, 0, 600)!.pan).toBeLessThan(0);
    expect(spatialize(200, 0, 600)!.pan).toBeGreaterThan(0);
    expect(spatialize(5000, 0, 0)).toEqual({ gain: 1, pan: 0, muffle: 0 });
  });
});

describe('sound content', () => {
  it('renders every sound to something audible and unclipped', () => {
    for (const def of content.all('sound')) {
      if (!def.synth) continue;
      const s = synthesize(def.synth, 1);
      let peak = 0;
      for (const x of s) peak = Math.max(peak, Math.abs(x));
      expect(peak, def.id).toBeLessThanOrEqual(1);
      expect(rms(s), def.id).toBeGreaterThan(0.01);
      expect(s.length / SYNTH_RATE, def.id).toBeLessThan(def.synth.loop ? 30 : 5);
    }
  });

  it('gives every engine cue a sound', () => {
    const claimed = new Set(content.all('sound').map((d) => d.cue));
    for (const cue of SOUND_CUES) expect(claimed.has(cue), cue).toBe(true);
  });

  it('gives every weapon a gunshot and every walkable ground a footstep', () => {
    for (const w of content.all('weapon')) expect(w.sounds?.shot, w.id).toBeDefined();
    for (const t of content.all('tile')) if (!t.solid && t.id !== 'void') expect(t.sounds?.step, t.id).toBeDefined();
  });

  it('rejects a sound with neither a recipe nor a file', () => {
    const reg = new ContentRegistry();
    defineCoreContentTypes(reg);
    const report = loadContent(reg, [{ path: '/content/x/pack.json', data: { id: 'x', name: 'x', version: '1' } }, { path: '/content/x/s.json', data: { type: 'sound', id: 'mute' } }]);
    expect(report.errors.join('\n')).toMatch(/exactly one of "synth" or "file"/);
  });
});
