import { segmentHitsSolid } from './combat';
import { TILE_PX, type TileMap } from './world/TileMap';

/** RGB, each 0..1. */
export type RGB01 = [number, number, number];

/** A light in the world (px). `cone` makes it a beam (flashlights). */
export interface LightSource {
  x: number;
  y: number;
  radius: number;
  color: RGB01;
  /** 0..~1.5: how strongly it lights things at its center. */
  intensity: number;
  cone?: { angle: number; width: number };
}

// ---- the clock -------------------------------------------------------------------

/** Game minutes per real second: a full day takes 36 real minutes. */
export const CLOCK_RATE = 24 * 60 / (36 * 60);
/** New games start in the morning. */
export const START_MINUTES = 8 * 60;

/** "HH:MM" for minutes since the first day began. */
export function clockText(minutes: number): string {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Sky light through the day: hour → color (night blue, dawn rose, day white, dusk amber). */
const SKY: [number, RGB01][] = [
  [0, [0.07, 0.09, 0.17]],
  [4.5, [0.07, 0.09, 0.17]],
  [6, [0.62, 0.5, 0.55]],
  [7.5, [1, 1, 1]],
  [17.5, [1, 0.98, 0.94]],
  [19.5, [0.85, 0.55, 0.4]],
  [21, [0.07, 0.09, 0.17]],
  [24, [0.07, 0.09, 0.17]],
];

/** The daylight color at a time of day. */
export function daylight(minutes: number): RGB01 {
  const h = ((((minutes / 60) % 24) + 24) % 24);
  for (let i = 1; i < SKY.length; i++) {
    const [h1, c1] = SKY[i]!;
    const [h0, c0] = SKY[i - 1]!;
    if (h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return SKY[0]![1];
}

/** How bright a color is (perceived), 0..1. */
export const luminance = (c: RGB01): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/** Lifts a dark ambient by the player's brightness setting (0..1), keeping its tint. */
export function brighten(c: RGB01, setting: number): RGB01 {
  const k = Math.max(0, Math.min(1, setting)) * 0.35;
  return [c[0] + (1 - c[0]) * k * 0.8, c[1] + (1 - c[1]) * k * 0.85, c[2] + (1 - c[2]) * k];
}

export function hexToRgb01(hex: string): RGB01 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---- light shapes ---------------------------------------------------------------

/** How a light fades from its center (t = 0) to its edge (t = 1). The lightmap's texture uses the same curve. */
export const falloff = (t: number): number => (t >= 1 ? 0 : Math.pow(1 - t * t, 1.6));

/**
 * The area a light reaches, as a polygon [x0, y0, x1, y1, …] starting at its
 * center: rays stop a little way into the first opaque tile (so the wall face
 * that catches the light is lit, but nothing behind it). Beams cover just
 * their cone.
 */
export function lightPolygon(map: TileMap, l: LightSource, rays?: number): number[] {
  const pts = [l.x, l.y];
  const full = !l.cone;
  const span = full ? Math.PI * 2 : l.cone!.width;
  const start = full ? 0 : l.cone!.angle - span / 2;
  const n = rays ?? (full ? Math.max(24, Math.min(96, Math.round(l.radius / 4))) : 28);
  const steps = full ? n : n - 1;
  for (let i = 0; i <= steps; i++) {
    if (full && i === steps) break;
    const a = start + (span * i) / steps;
    const ex = l.x + Math.cos(a) * l.radius;
    const ey = l.y + Math.sin(a) * l.radius;
    const f = segmentHitsSolid(map, l.x, l.y, ex, ey, 'sight');
    const d = f === null ? l.radius : Math.min(l.radius, f * l.radius + TILE_PX * 0.55);
    pts.push(l.x + Math.cos(a) * d, l.y + Math.sin(a) * d);
  }
  if (full) pts.push(pts[2]!, pts[3]!);
  return pts;
}

/** Light reaching a point from one source (0..intensity), walls considered. */
export function lightFrom(map: TileMap | null, l: LightSource, x: number, y: number): number {
  const dx = x - l.x;
  const dy = y - l.y;
  const d = Math.hypot(dx, dy);
  if (d >= l.radius) return 0;
  if (l.cone && d > 4) {
    let da = Math.atan2(dy, dx) - l.cone.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > l.cone.width / 2) return 0;
  }
  if (map && d > 4 && segmentHitsSolid(map, l.x, l.y, x, y, 'sight') !== null) return 0;
  return l.intensity * falloff(d / l.radius);
}

/** How lit a point is, 0..1+: the ambient level plus every light that reaches it. */
export function lightLevel(map: TileMap | null, ambient: number, lights: Iterable<LightSource>, x: number, y: number): number {
  let level = ambient;
  for (const l of lights) {
    if (Math.abs(x - l.x) > l.radius || Math.abs(y - l.y) > l.radius) continue;
    level += luminance(l.color) * lightFrom(map, l, x, y);
    if (level >= 1) return level;
  }
  return level;
}

/** A light's brightness this moment: steady, or flickering like a failing tube / a fire. */
export function flickered(intensity: number, flicker: number, time: number, seed: number): number {
  if (flicker <= 0) return intensity;
  const s = Math.sin(time * 7.3 + seed) * 0.5 + Math.sin(time * 17.1 + seed * 2.7) * 0.3 + Math.sin(time * 31.7 + seed * 5.1) * 0.2;
  // Failing tubes also cut out now and then.
  const dropout = flicker >= 0.75 && Math.sin(time * 1.9 + seed * 3.3) > 0.93 ? 0.15 : 1;
  return Math.max(0, intensity * (1 - flicker * 0.5 * (s * 0.5 + 0.5)) * dropout);
}
