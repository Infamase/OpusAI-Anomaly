import type { ContentRegistry } from '../content/Registry';
import type { WorldGenDef } from '../content/types';
import { directionVector } from '../core/math';
import type { World } from '../ecs/World';
import type { LightDraw } from '../render/LightRenderer';
import { Aim, Anomaly, Character, Flashlight, Health, Transform, WorldItem } from './components';
import { brighten, daylight, flickered, hexToRgb01, lightLevel, lightPolygon, luminance, type LightSource, type RGB01 } from './lighting';
import type { StaticLightSpawn } from './world/generators';
import { TILE_PX, type TileMap } from './world/TileMap';

const T = TILE_PX;
/** Flashlight beam: reach, width, color. */
const BEAM_RANGE = 9 * T;
const BEAM_WIDTH = 0.8;
const BEAM_COLOR: RGB01 = [1, 0.95, 0.82];
/** Someone holding a lit flashlight is easy to spot, whatever else is dark. */
const BEAM_HOLDER_LEVEL = 0.9;

interface StaticLight {
  src: LightSource;
  flicker: number;
  seed: number;
  poly: number[] | null;
}

interface Flash {
  src: LightSource;
  life: number;
  max: number;
}

/**
 * The light in one world: the ambient (sky by the clock, or a world's fixed
 * gloom), fixed lights (a generator's ceiling lamps, glowing tiles like
 * campfires), flashlights, glowing anomalies and artifacts, and brief flashes
 * (gunfire, explosions). Feeds the lightmap renderer and answers "how lit is
 * this spot?" for NPC eyes.
 */
export class WorldLighting {
  ambient: RGB01 = [1, 1, 1];
  ambientLevel = 1;
  private statics = new Map<string, StaticLight>();
  private flashes: Flash[] = [];
  private time = 0;
  private dynamic: LightSource[] = [];
  private dynamicAt = -1;

  constructor(
    private content: ContentRegistry,
    private world: World,
    private map: TileMap,
    private def: WorldGenDef['lighting'],
    generated: StaticLightSpawn[],
  ) {
    generated.forEach((l, i) => this.addStatic(`gen:${i}`, l.x * T, l.y * T, hexToRgb01(l.color), l.radius * T, l.intensity, l.flicker));
  }

  /** True when this world can get dark at all (otherwise lighting is skipped). */
  get dynamicWorld(): boolean {
    return !!this.def;
  }

  /** Sets the ambient for the time of day (minutes) and the player's brightness setting (0..1). */
  setTime(minutes: number, brightness: number): void {
    const base = !this.def ? ([1, 1, 1] as RGB01) : this.def.dayCycle ? daylight(minutes) : hexToRgb01(this.def.ambient);
    this.ambient = luminance(base) > 0.97 ? base : brighten(base, brightness);
    this.ambientLevel = luminance(this.ambient);
  }

  update(dt: number): void {
    this.time += dt;
    this.flashes = this.flashes.filter((f) => (f.life -= dt) > 0);
  }

  /** A brief light: a muzzle flash, an explosion. */
  flash(x: number, y: number, radius: number, color: RGB01, intensity: number, life: number): void {
    if (this.ambientLevel > 0.97) return;
    this.flashes.push({ src: { x, y, radius, color, intensity }, life, max: life });
  }

  // ---- fixed lights ----------------------------------------------------------------

  private addStatic(key: string, x: number, y: number, color: RGB01, radius: number, intensity: number, flicker: number): void {
    this.statics.set(key, { src: { x, y, radius, color, intensity }, flicker, seed: (x * 13.1 + y * 7.7) % 100, poly: null });
  }

  /** Glowing tiles (campfires, lamp posts) in a chunk that just came into view. */
  chunkShown(cx: number, cy: number): void {
    const S = this.map.chunkSize;
    for (let y = cy * S; y < cy * S + S; y++) {
      for (let x = cx * S; x < cx * S + S; x++) {
        const l = this.map.tiles.defs[this.map.getTile(x, y)]!.light;
        if (l) this.addStatic(`tile:${x},${y}`, (x + 0.5) * T, (y + 0.5) * T, hexToRgb01(l.color), l.radius * T, l.intensity, l.flicker);
      }
    }
  }

  chunkHidden(cx: number, cy: number): void {
    const S = this.map.chunkSize;
    for (const key of [...this.statics.keys()]) {
      if (!key.startsWith('tile:')) continue;
      const [x, y] = key.slice(5).split(',').map(Number) as [number, number];
      if (Math.floor(x / S) === cx && Math.floor(y / S) === cy) this.statics.delete(key);
    }
  }

  /** A tile changed (a door opened, a wall fell): lights that reach it must re-cast their shadows. */
  tileChanged(tx: number, ty: number): void {
    const x = (tx + 0.5) * T;
    const y = (ty + 0.5) * T;
    for (const s of this.statics.values()) if (Math.hypot(s.src.x - x, s.src.y - y) < s.src.radius + T) s.poly = null;
    const key = `tile:${tx},${ty}`;
    const l = this.map.tiles.defs[this.map.getTile(tx, ty)]!.light;
    if (!l) this.statics.delete(key);
    else if (!this.statics.has(key)) this.addStatic(key, x, y, hexToRgb01(l.color), l.radius * T, l.intensity, l.flicker);
  }

  // ---- what's shining right now -------------------------------------------------------

  /** Flashlights, glowing anomalies and artifacts, flashes (rebuilt once per frame / tick). */
  private dynamicSources(): LightSource[] {
    if (this.dynamicAt === this.time) return this.dynamic;
    this.dynamicAt = this.time;
    const out: LightSource[] = [];
    for (const e of this.world.query(Flashlight, Transform)) {
      if (!this.world.req(e, Flashlight).on || this.world.get(e, Health)?.dead) continue;
      const t = this.world.req(e, Transform);
      const dir = this.world.get(e, Aim)?.dir ?? directionVector(this.world.get(e, Character)?.facing ?? 'down');
      const angle = Math.atan2(dir.y, dir.x);
      out.push({ x: t.x + Math.cos(angle) * 6, y: t.y - 4 + Math.sin(angle) * 6, radius: BEAM_RANGE, color: BEAM_COLOR, intensity: 1, cone: { angle, width: BEAM_WIDTH } });
      // A little spill around whoever holds it.
      out.push({ x: t.x, y: t.y - 4, radius: T * 1.8, color: BEAM_COLOR, intensity: 0.35 });
    }
    for (const e of this.world.query(Anomaly, Transform)) {
      const def = this.content.tryGet('anomaly', this.world.req(e, Anomaly).defId);
      if (!def?.light) continue;
      const t = this.world.req(e, Transform);
      const burst = this.world.req(e, Anomaly).sinceBurst < 0.4 ? 1.6 : 1;
      out.push({ x: t.x, y: t.y, radius: def.radius * T * 1.6, color: hexToRgb01(def.light.color), intensity: flickered(def.light.intensity, def.light.flicker, this.time, t.x % 97) * burst });
    }
    for (const e of this.world.query(WorldItem, Transform)) {
      const wi = this.world.req(e, WorldItem);
      const art = wi.generated && !wi.hidden ? this.content.tryGet('artifact', wi.item.defId) : undefined;
      if (!art) continue;
      const t = this.world.req(e, Transform);
      out.push({ x: t.x, y: t.y - 4, radius: T * 1.4, color: hexToRgb01(art.art.glow), intensity: 0.55 + 0.15 * Math.sin(this.time * 2 + t.x) });
    }
    for (const f of this.flashes) out.push({ ...f.src, intensity: f.src.intensity * (f.life / f.max) });
    this.dynamic = out;
    return out;
  }

  /** Everything giving off light this moment. */
  sources(): LightSource[] {
    const out = this.dynamicSources().slice();
    for (const s of this.statics.values()) out.push({ ...s.src, intensity: flickered(s.src.intensity, s.flicker, this.time, s.seed) });
    return out;
  }

  /** How lit a spot is (0 pitch dark .. 1+ broad daylight), for eyes. */
  levelAt(x: number, y: number): number {
    if (this.ambientLevel > 0.97) return this.ambientLevel;
    // Holding a lit flashlight gives you away.
    for (const e of this.world.query(Flashlight, Transform)) {
      if (!this.world.req(e, Flashlight).on) continue;
      const t = this.world.req(e, Transform);
      if (Math.abs(t.x - x) < T && Math.abs(t.y - y) < T) return Math.max(BEAM_HOLDER_LEVEL, this.ambientLevel);
    }
    return lightLevel(this.map, this.ambientLevel, this.sources(), x, y);
  }

  /** What to draw this frame, for lights that reach the view. `eyes`: the player, who always sees a little around them. */
  draws(view: { left: number; top: number; right: number; bottom: number }, eyes: { x: number; y: number } | null): LightDraw[] {
    if (this.ambientLevel > 0.97) return [];
    const out: LightDraw[] = [];
    const inView = (l: LightSource) => l.x + l.radius > view.left && l.x - l.radius < view.right && l.y + l.radius > view.top && l.y - l.radius < view.bottom;
    for (const s of this.statics.values()) {
      if (!inView(s.src)) continue;
      s.poly ??= lightPolygon(this.map, s.src);
      out.push({ poly: s.poly, x: s.src.x, y: s.src.y, radius: s.src.radius, color: s.src.color, intensity: flickered(s.src.intensity, s.flicker, this.time, s.seed) });
    }
    for (const l of this.dynamicSources()) {
      if (!inView(l)) continue;
      out.push({ poly: lightPolygon(this.map, l, l.cone ? 28 : l.radius > T * 3 ? 48 : 24), x: l.x, y: l.y, radius: l.radius, color: l.color, intensity: l.intensity });
    }
    // Eyes adjust: a faint glow around the player so the dark is never total.
    if (eyes) {
      const l: LightSource = { x: eyes.x, y: eyes.y - 4, radius: T * 3.2, color: [0.75, 0.8, 0.9], intensity: 0.22 };
      out.push({ poly: lightPolygon(this.map, l, 32), x: l.x, y: l.y, radius: l.radius, color: l.color, intensity: l.intensity });
    }
    return out;
  }
}
