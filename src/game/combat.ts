import type { ContentRegistry } from '../content/Registry';
import type { WeaponDef } from '../content/types';
import { resistStat, type DamageType } from '../content/types/weapon';
import type { Entity, World } from '../ecs/World';
import { generateWeaponArt } from '../render/placeholder/weapons';
import type { ItemInstance } from '../save/types';
import { Collider, Equipment, Health, Stats, Transform } from './components';
import { ARMOR_SLOTS, refreshItemStats } from './equipment';
import { TILE_PX, type TileMap } from './world/TileMap';

// ---- Tuning ------------------------------------------------------------------

/** Resistance can never block more than this much damage. */
export const MAX_RESIST = 0.9;
/** Armor condition lost per point of incoming damage. */
export const ARMOR_WEAR_PER_DAMAGE = 0.0025;
/** Weapon condition lost per shot. */
export const WEAPON_WEAR_PER_SHOT = 0.0004;
/** Height of the gun / chest above the feet, in px. */
export const CHEST_HEIGHT = 26;
/** Which armor piece takes the hit (and the wear). */
const HIT_SLOT_WEIGHTS: [(typeof ARMOR_SLOTS)[number], number][] = [
  ['torso', 0.6],
  ['legs', 0.25],
  ['head', 0.15],
];

// ---- Damage ------------------------------------------------------------------

export interface Hit {
  amount: number;
  type: DamageType;
  /** Armor piercing: ignores this much resistance. */
  ap: number;
  attacker: Entity | null;
}

export interface DamageResult {
  dealt: number;
  /** Fraction blocked by resistance (0..MAX_RESIST). */
  blocked: number;
  killed: boolean;
}

/** Resistance actually applied after armor piercing. */
export function effectiveResist(resist: number, ap: number): number {
  return Math.max(0, Math.min(MAX_RESIST, resist - ap));
}

/**
 * Applies one hit: resistance (minus armor piercing) reduces it, a random armor
 * piece wears down (lowering its protection), and bullets or claws that get
 * through can cause bleeding.
 */
export function applyDamage(world: World, content: ContentRegistry, target: Entity, hit: Hit, roll = Math.random()): DamageResult {
  const health = world.get(target, Health);
  if (!health || health.dead) return { dealt: 0, blocked: 0, killed: false };
  const stats = world.get(target, Stats);
  const blocked = effectiveResist(stats ? stats.get(resistStat(hit.type)) : 0, hit.ap);
  const dealt = health.god ? 0 : hit.amount * (1 - blocked);
  health.hp -= dealt;
  health.sinceHit = 0;

  const eq = world.get(target, Equipment);
  if (eq && stats) {
    const slot = pickWeighted(HIT_SLOT_WEIGHTS, roll);
    const piece = eq[slot];
    if (piece) {
      piece.condition = Math.max(0, piece.condition - hit.amount * ARMOR_WEAR_PER_DAMAGE);
      refreshItemStats(stats, content, piece);
    }
  }
  if ((hit.type === 'ballistic' || hit.type === 'rupture') && dealt >= 6) {
    health.bleed = Math.min(4, health.bleed + dealt * 0.03);
  }
  const killed = health.hp <= 0;
  if (killed) {
    health.hp = 0;
    health.dead = true;
    health.bleed = 0;
  }
  return { dealt, blocked, killed };
}

function pickWeighted<T>(entries: [T, number][], roll: number): T {
  let r = roll * entries.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of entries) {
    r -= w;
    if (r < 0) return v;
  }
  return entries[entries.length - 1]![0];
}

// ---- Weapons -----------------------------------------------------------------

export interface WeaponGeometry {
  grip: [number, number];
  muzzle: [number, number];
}

const geometryCache = new Map<string, WeaponGeometry>();

/** Where the hand holds the gun and where bullets leave it, in the weapon art's pixels. */
export function weaponGeometry(def: WeaponDef): WeaponGeometry {
  if (def.sprite) return { grip: def.sprite.grip, muzzle: def.sprite.muzzle };
  const key = def.placeholder!.style;
  let g = geometryCache.get(key);
  if (!g) {
    const art = generateWeaponArt(def.placeholder!.style);
    g = { grip: art.grip, muzzle: art.muzzle };
    geometryCache.set(key, g);
  }
  return g;
}

/** How far the gun sits out from the chest along the aim. */
export const HOLD_DISTANCE = 5;

/**
 * World position of the muzzle for a character at (x, y) aiming at `angle`.
 * Guns aimed left are mirrored vertically (so they're never upside down).
 */
export function muzzlePosition(def: WeaponDef, x: number, y: number, angle: number): { x: number; y: number } {
  const { grip, muzzle } = weaponGeometry(def);
  const flip = Math.cos(angle) < 0 ? -1 : 1;
  const dx = muzzle[0] - grip[0];
  const dy = (muzzle[1] - grip[1]) * flip;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const px = x + c * HOLD_DISTANCE;
  const py = y - CHEST_HEIGHT + s * HOLD_DISTANCE;
  return { x: px + dx * c - dy * s, y: py + dx * s + dy * c };
}

/** Current cone of fire in degrees: base + movement + sustained-fire bloom, widened by wear. */
export function currentSpread(def: WeaponDef, item: ItemInstance, bloom: number, movingFraction: number): number {
  const wear = 1 + (1 - Math.max(0, Math.min(1, item.condition))) * 0.8;
  return (def.spread + def.moveSpread * Math.max(0, Math.min(1, movingFraction)) + bloom) * wear;
}

// ---- Geometry ----------------------------------------------------------------

/** Area a character can be hit in: a bit wider than the feet collider, up to head height. */
export function hurtbox(world: World, e: Entity): { x0: number; y0: number; x1: number; y1: number } | null {
  const t = world.get(e, Transform);
  const c = world.get(e, Collider);
  if (!t || !c) return null;
  const half = c.w / 2 + 4;
  return { x0: t.x - half, y0: t.y - 50, x1: t.x + half, y1: t.y + 1 };
}

/** Liang–Barsky: entry fraction (0..1) of segment p0→p1 into the box, or null if it misses. */
export function segmentBoxEntry(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  box: { x0: number; y0: number; x1: number; y1: number },
): number | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (clip(-dx, x0 - box.x0) && clip(dx, box.x1 - x0) && clip(-dy, y0 - box.y0) && clip(dy, box.y1 - y0)) return t0;
  return null;
}

/**
 * First solid tile along a segment, as a fraction 0..1 (or null if clear).
 * Walks tile by tile (Amanatides–Woo), so fast bullets never skip a thin wall.
 */
export function segmentHitsSolid(map: TileMap, x0: number, y0: number, x1: number, y1: number, opaqueOnly = false): number | null {
  const blocked = (tx: number, ty: number) => (opaqueOnly ? map.tiles.opaque[map.getTile(tx, ty)] === 1 : map.isSolid(tx, ty));
  let tx = Math.floor(x0 / TILE_PX);
  let ty = Math.floor(y0 / TILE_PX);
  if (blocked(tx, ty)) return 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  const tDeltaX = stepX ? TILE_PX / Math.abs(dx) : Infinity;
  const tDeltaY = stepY ? TILE_PX / Math.abs(dy) : Infinity;
  let tMaxX = stepX > 0 ? ((tx + 1) * TILE_PX - x0) / dx : stepX < 0 ? (tx * TILE_PX - x0) / dx : Infinity;
  let tMaxY = stepY > 0 ? ((ty + 1) * TILE_PX - y0) / dy : stepY < 0 ? (ty * TILE_PX - y0) / dy : Infinity;
  for (let i = 0; i < 256; i++) {
    let t: number;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t > 1) return null;
    if (blocked(tx, ty)) return t;
  }
  return null;
}

/** True if nothing opaque lies between two points. */
export function lineOfSight(map: TileMap, x0: number, y0: number, x1: number, y1: number): boolean {
  return segmentHitsSolid(map, x0, y0, x1, y1, true) === null;
}
