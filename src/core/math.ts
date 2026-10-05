export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

/** Returns a unit vector, or (0,0) for a zero-length input. */
export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  return len > 0 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

/** Clamps a vector's length to at most `max` (analog sticks can exceed 1 on diagonals). */
export function clampLength(v: Vec2, max: number): Vec2 {
  const len = length(v);
  return len > max ? { x: (v.x / len) * max, y: (v.y / len) * max } : { x: v.x, y: v.y };
}

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** Four-way facing used by the 48px humanoid sprite layout. Order matches sprite sheet rows. */
export const DIRECTIONS = ['down', 'left', 'right', 'up'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Quantizes a direction vector to the nearest of the four cardinal facings. */
export function toDirection(v: Vec2, fallback: Direction = 'down'): Direction {
  if (v.x === 0 && v.y === 0) return fallback;
  if (Math.abs(v.x) > Math.abs(v.y)) return v.x < 0 ? 'left' : 'right';
  return v.y < 0 ? 'up' : 'down';
}

export function directionVector(d: Direction): Vec2 {
  switch (d) {
    case 'down':
      return { x: 0, y: 1 };
    case 'up':
      return { x: 0, y: -1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
  }
}
