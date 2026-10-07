import type { ContentRegistry } from '../content/Registry';
import { SOUND_BUSES, type SoundBus, type SoundCue, type SoundDef } from '../content/types/sound';
import { hashString } from '../core/rng';
import { synthesize, SYNTH_RATE } from './synth';

export interface AudioVolumes {
  master: number;
  sfx: number;
  ambient: number;
  ui: number;
  voice: number;
}

export interface PlayOptions {
  /** World position; omit for UI / non-positional sounds. */
  x?: number;
  y?: number;
  volume?: number;
  pitch?: number;
}

/** Stereo and loudness for a sound `dx, dy` px from the listener, or null if out of earshot. */
export function spatialize(dx: number, dy: number, range: number): { gain: number; pan: number; muffle: number } | null {
  if (range <= 0) return { gain: 1, pan: 0, muffle: 0 };
  const d = Math.hypot(dx, dy);
  if (d >= range) return null;
  const near = d / range;
  // Loud up close, a long quiet tail, exactly silent at the range.
  const gain = (1 - near) / (1 + (d / (range * 0.22)) ** 2);
  return { gain, pan: Math.max(-1, Math.min(1, dx / 360)) * 0.75, muffle: near };
}

interface Voice {
  src: AudioBufferSourceNode;
  out: GainNode;
  at: number;
}

export interface LoopHandle {
  stop(fade?: number): void;
  /** Scales the loop's loudness (0..1 of its own volume), easing there. */
  setLevel?(level: number): void;
}

const MAX_VOICES_TOTAL = 40;

/**
 * Plays content-defined sounds through WebAudio: one mixer bus per category
 * (effects, ambience, interface, voices), positional effects panned and
 * attenuated around the listener (the player), muffled with distance.
 *
 * Browsers only allow audio after a user gesture, so the context starts on the
 * first key press or click. Without WebAudio (tests, old browsers) every call
 * is a harmless no-op.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses = {} as Record<SoundBus, GainNode>;
  private buffers = new Map<string, AudioBuffer[]>();
  private pending = new Map<string, Promise<void>>();
  private cues = new Map<SoundCue, string>();
  private voices = new Map<string, Voice[]>();
  private voiceCount = 0;
  private lastPlay = new Map<string, number>();
  private lastVariant = new Map<string, number>();
  private listener = { x: 0, y: 0 };
  private ambient = new Map<string, LoopHandle>();
  private duckLevel = 1;
  private muted = false;

  constructor(
    private content: ContentRegistry,
    private volumes: AudioVolumes,
  ) {}

  /** Indexes cues once content is loaded, and starts audio on the first user gesture. */
  init(): void {
    this.cues.clear();
    for (const def of this.content.all('sound')) if (def.cue) this.cues.set(def.cue, def.id);
    if (typeof window === 'undefined' || !('AudioContext' in window)) return;
    const unlock = () => {
      this.start();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** The sound a cue maps to, if any content claims it. */
  cue(name: SoundCue): string | undefined {
    return this.cues.get(name);
  }

  setVolumes(v: AudioVolumes, muted = this.muted): void {
    this.volumes = v;
    this.muted = muted;
    this.applyVolumes();
  }

  /** Lowers effects and ambience (pause menu, death screen). */
  duck(on: boolean): void {
    this.duckLevel = on ? 0.35 : 1;
    this.applyVolumes();
  }

  setListener(x: number, y: number): void {
    this.listener.x = x;
    this.listener.y = y;
  }

  suspend(): void {
    void this.ctx?.suspend().catch(() => {});
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {});
  }

  /** Plays `id` (a specific sound) or, if that's missing, the cue's sound. Returns false if nothing played. */
  play(id: string | undefined, opts: PlayOptions = {}, fallback?: SoundCue): boolean {
    const soundId = id ?? (fallback ? this.cues.get(fallback) : undefined);
    if (!soundId || !this.ctx || this.ctx.state !== 'running') return false;
    const def = this.content.tryGet('sound', soundId);
    if (!def) return false;
    const now = this.ctx.currentTime;
    if (now - (this.lastPlay.get(soundId) ?? -1) < def.minInterval) return false;

    let gain = def.volume * (opts.volume ?? 1);
    let pan = 0;
    let muffle = 0;
    if (opts.x !== undefined && opts.y !== undefined) {
      const s = spatialize(opts.x - this.listener.x, opts.y - this.listener.y, def.range);
      if (!s) return false;
      gain *= s.gain;
      pan = s.pan;
      muffle = s.muffle;
    }
    if (gain < 0.004) return false;
    const variants = this.buffers.get(soundId);
    if (!variants) {
      void this.load(def);
      return false;
    }
    this.lastPlay.set(soundId, now);
    this.startVoice(def, variants, gain, pan, muffle, opts.pitch ?? 1);
    return true;
  }

  playCue(cue: SoundCue, opts: PlayOptions = {}): boolean {
    return this.play(undefined, opts, cue);
  }

  /** Starts a looping sound (ambience). */
  loop(id: string, fadeIn = 1.5): LoopHandle {
    const ctx = this.ctx;
    const def = this.content.tryGet('sound', id);
    if (!ctx || !def) return { stop() {} };
    let level = 1;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.buses[def.bus]);
    let src: AudioBufferSourceNode | null = null;
    let stopped = false;
    const begin = (buf: AudioBuffer) => {
      if (stopped) return;
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(out);
      src.start();
      out.gain.setTargetAtTime(def.volume * level, ctx.currentTime, fadeIn / 3);
    };
    const ready = this.buffers.get(id);
    if (ready) begin(ready[0]!);
    else void this.load(def).then(() => this.buffers.get(id) && begin(this.buffers.get(id)![0]!));
    return {
      setLevel: (v: number) => {
        level = Math.max(0, Math.min(1, v));
        if (!stopped && src) out.gain.setTargetAtTime(def.volume * level, ctx.currentTime, 0.4);
      },
      stop: (fade = 1) => {
        stopped = true;
        out.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
        setTimeout(() => {
          src?.stop();
          out.disconnect();
        }, fade * 1000 + 200);
      },
    };
  }

  /** Crossfades the background to this set of loops (empty = silence). */
  setAmbient(ids: string[]): void {
    const want = new Set(ids);
    for (const [id, h] of this.ambient) {
      if (!want.has(id)) {
        h.stop(2);
        this.ambient.delete(id);
      }
    }
    // Before audio is allowed, just remember the set; start() begins it.
    for (const id of want) if (!this.ambient.has(id)) this.ambient.set(id, this.ctx ? this.loop(id, 3) : { stop() {} });
  }

  /** Renders every sound ahead of time, a few per frame, so the first gunshot doesn't hitch. */
  preloadAll(): void {
    const defs = this.content.all('sound').filter((d) => !this.buffers.has(d.id));
    const step = () => {
      const def = defs.shift();
      if (!def) return;
      void this.load(def).finally(() => setTimeout(step, 0));
    };
    step();
  }

  private start(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      // A gentle limiter keeps a firefight from clipping.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 8;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      this.master.connect(limiter).connect(this.ctx.destination);
      for (const bus of SOUND_BUSES) {
        const g = this.ctx.createGain();
        g.connect(this.master);
        this.buses[bus] = g;
      }
      this.applyVolumes();
      this.preloadAll();
      // Ambience requested before audio was allowed starts now.
      const pending = [...this.ambient.keys()];
      this.ambient.clear();
      this.setAmbient(pending);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const curve = (x: number) => Math.max(0, Math.min(1, x)) ** 2;
    this.master.gain.setTargetAtTime(this.muted ? 0 : curve(this.volumes.master), t, 0.03);
    const v = this.volumes;
    const level: Record<SoundBus, number> = { sfx: v.sfx * this.duckLevel, ambient: v.ambient * this.duckLevel, ui: v.ui, voice: v.voice * this.duckLevel };
    for (const bus of SOUND_BUSES) this.buses[bus].gain.setTargetAtTime(curve(level[bus]), t, 0.03);
  }

  private load(def: SoundDef): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return Promise.resolve();
    let p = this.pending.get(def.id);
    if (p) return p;
    p = (async () => {
      try {
        if (def.synth) {
          const count = def.synth.loop ? 1 : def.variants;
          const out: AudioBuffer[] = [];
          for (let i = 0; i < count; i++) {
            const samples = synthesize(def.synth, hashString(`${def.id}:${i}`));
            const buf = ctx.createBuffer(1, samples.length, SYNTH_RATE);
            buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
            out.push(buf);
          }
          this.buffers.set(def.id, out);
        } else if (def.file) {
          const res = await fetch(`${import.meta.env.BASE_URL}${def.file}`);
          this.buffers.set(def.id, [await ctx.decodeAudioData(await res.arrayBuffer())]);
        }
      } catch (err) {
        console.warn(`Sound "${def.id}" failed to load`, err);
        this.buffers.set(def.id, []);
      }
    })();
    this.pending.set(def.id, p);
    return p;
  }

  private startVoice(def: SoundDef, variants: AudioBuffer[], gain: number, pan: number, muffle: number, pitch: number): void {
    const ctx = this.ctx!;
    if (!variants.length) return;
    // Pick a variant, avoiding the one just played.
    let i = Math.floor(Math.random() * variants.length);
    if (variants.length > 1 && i === this.lastVariant.get(def.id)) i = (i + 1) % variants.length;
    this.lastVariant.set(def.id, i);

    const list = this.voices.get(def.id) ?? [];
    this.voices.set(def.id, list);
    while (list.length >= def.maxVoices || (this.voiceCount >= MAX_VOICES_TOTAL && list.length)) this.kill(list.shift()!);
    if (this.voiceCount >= MAX_VOICES_TOTAL) return;

    const src = ctx.createBufferSource();
    src.buffer = variants[i]!;
    src.playbackRate.value = pitch * (1 + (Math.random() * 2 - 1) * def.pitchJitter);
    const out = ctx.createGain();
    out.gain.value = gain;
    let node: AudioNode = src;
    if (muffle > 0.15) {
      // Distant sounds lose their highs.
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 16000 * Math.pow(1 - muffle, 1.6) + 700;
      node = node.connect(lp);
    }
    if (pan !== 0) node = node.connect(new StereoPannerNode(ctx, { pan }));
    node.connect(out).connect(this.buses[def.bus]);
    const voice: Voice = { src, out, at: ctx.currentTime };
    list.push(voice);
    this.voiceCount++;
    src.onended = () => {
      const k = list.indexOf(voice);
      if (k >= 0) {
        list.splice(k, 1);
        this.voiceCount--;
      }
      out.disconnect();
    };
    src.start();
  }

  private kill(v: Voice): void {
    this.voiceCount--;
    const t = this.ctx!.currentTime;
    v.out.gain.setTargetAtTime(0, t, 0.01);
    v.src.onended = null;
    try {
      v.src.stop(t + 0.05);
    } catch {
      /* already stopped */
    }
    setTimeout(() => v.out.disconnect(), 120);
  }
}
