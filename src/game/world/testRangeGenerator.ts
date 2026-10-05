import { fbm2D, deriveSeed, hashInts, Rng } from '../../core/rng';
import { parseOrThrow, v } from '../../content/schema';
import type { TileSet } from './TileSet';
import { registerGenerator, type CampSpawn, type WorldGenerator, type WorldObjectSpawn } from './generators';

/**
 * Phase 0 test map: noise terrain with rock outcrops and a small metal outpost
 * in the middle. It exists to exercise the chunk / seed / delta pipeline that
 * real planet generators (Phase 2) will use.
 */
const paramsSchema = v.object({
  ground: v.id(),
  grass: v.id(),
  grassThreshold: v.number({ min: 0, max: 1 }),
  rock: v.id(),
  rockThreshold: v.number({ min: 0, max: 1 }),
  border: v.id(),
  outpost: v.object({
    floor: v.id(),
    grate: v.id(),
    wall: v.id(),
    hazard: v.id(),
    width: v.number({ int: true, min: 8 }),
    height: v.number({ int: true, min: 8 }),
  }),
  /** Scattered decorations (trees, boulders...), replacing `on` tiles. Denser where the "forest" noise is high. */
  decor: v.optional(
    v.array(v.object({ tile: v.id(), on: v.id(), density: v.number({ min: 0, max: 1 }) })),
    [],
  ),
  camps: v.optional(
    v.array(
      v.object({
        id: v.id(),
        faction: v.id(),
        templates: v.array(v.id(), { min: 1 }),
        behavior: v.literal('guard', 'patrol'),
        /** "outpost" = inside the outpost; "far" = somewhere open, well away from it. */
        at: v.literal('outpost', 'far'),
        radius: v.number({ min: 1 }),
      }),
    ),
    [],
  ),
});

type CampParams = { id: string; faction: string; templates: string[]; behavior: 'guard' | 'patrol'; at: 'outpost' | 'far'; radius: number };

interface Params {
  ground: number;
  grass: number;
  grassThreshold: number;
  rock: number;
  rockThreshold: number;
  border: number;
  outpost: { floor: number; grate: number; wall: number; hazard: number; width: number; height: number };
  decor: { tile: number; on: number; density: number }[];
  camps: CampParams[];
}

function outpostRect(p: Params, W: number, H: number) {
  const x = Math.floor(W / 2 - p.outpost.width / 2);
  const y = Math.floor(H / 2 - p.outpost.height / 2);
  return { x, y, w: p.outpost.width, h: p.outpost.height };
}

function classify(seed: number, p: Params, gx: number, gy: number, W: number, H: number): number {
  if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) return p.border;

  const o = outpostRect(p, W, H);
  const lx = gx - o.x;
  const ly = gy - o.y;
  const inside = lx >= 0 && ly >= 0 && lx < o.w && ly < o.h;
  if (inside) {
    const midX = Math.floor(o.w / 2);
    const midY = Math.floor(o.h / 2);
    const southDoor = ly === o.h - 1 && (lx === midX - 1 || lx === midX);
    const eastDoor = lx === o.w - 1 && (ly === midY - 1 || ly === midY);
    if (southDoor || eastDoor) return p.outpost.hazard;
    if (lx === 0 || ly === 0 || lx === o.w - 1 || ly === o.h - 1) return p.outpost.wall;
    // Cover pillars.
    const pillar = (px: number, py: number) => (lx === px || lx === px + 1) && (ly === py || ly === py + 1);
    if (pillar(3, 3) || pillar(o.w - 5, 3)) return p.outpost.wall;
    if (ly === midY || ly === midY - 1) return p.outpost.grate;
    return p.outpost.floor;
  }

  const nearOutpost = gx >= o.x - 4 && gy >= o.y - 4 && gx < o.x + o.w + 4 && gy < o.y + o.h + 4;
  if (!nearOutpost && fbm2D(deriveSeed(seed, 'rock'), gx / 10, gy / 10, 4) > p.rockThreshold) return p.rock;
  const ground = fbm2D(deriveSeed(seed, 'grass'), gx / 7, gy / 7, 3) > p.grassThreshold ? p.grass : p.ground;
  // Decorations keep a clear ring around the outpost so its doors stay reachable.
  const clearing = gx >= o.x - 7 && gy >= o.y - 7 && gx < o.x + o.w + 7 && gy < o.y + o.h + 7;
  if (clearing || gx < 4 || gy < 4 || gx >= W - 4 || gy >= H - 4) return ground;
  const forest = fbm2D(deriveSeed(seed, 'forest'), gx / 14, gy / 14, 3);
  const roll = (hashInts(seed, gx, gy) >>> 0) / 4294967296;
  let acc = 0;
  for (const d of p.decor) {
    if (d.on !== ground) continue;
    acc += d.density * Math.max(0, forest - 0.3) * 3;
    if (roll < acc) return d.tile;
  }
  return ground;
}

export const testRangeGenerator: WorldGenerator<Params> = {
  id: 'test_range',
  version: 1,

  parseParams(raw: unknown, tiles: TileSet): Params {
    const r = parseOrThrow(paramsSchema, raw, 'test_range params');
    return {
      ground: tiles.index(r.ground),
      grass: tiles.index(r.grass),
      grassThreshold: r.grassThreshold,
      rock: tiles.index(r.rock),
      rockThreshold: r.rockThreshold,
      border: tiles.index(r.border),
      outpost: {
        ...r.outpost,
        floor: tiles.index(r.outpost.floor),
        grate: tiles.index(r.outpost.grate),
        wall: tiles.index(r.outpost.wall),
        hazard: tiles.index(r.outpost.hazard),
      },
      decor: r.decor.map((d) => ({ tile: tiles.index(d.tile), on: tiles.index(d.on), density: d.density })),
      camps: r.camps,
    };
  },

  generateChunk(ctx, out) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H } = ctx;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        out[y * S + x] = classify(ctx.seed, ctx.params, cx * S + x, cy * S + y, W, H);
      }
    }
  },

  objects(ctx, tiles) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H, params } = ctx;
    const T = 32;
    const out: WorldObjectSpawn[] = [];
    // Two military cases in the outpost, beside the cover pillars.
    const o = outpostRect(params, W, H);
    for (const [i, [lx, ly]] of [
      [0, [2, 2]],
      [1, [o.w - 3, 2]],
    ] as const) {
      const gx = o.x + lx;
      const gy = o.y + ly;
      if (Math.floor(gx / S) === cx && Math.floor(gy / S) === cy) {
        out.push({ id: `crate:outpost:${i}`, kind: 'crate', x: (gx + 0.5) * T, y: (gy + 0.8) * T, variant: 'military', lootTable: 'military_crate' });
      }
    }
    // Scattered supply crates on open ground.
    const rng = new Rng(deriveSeed(ctx.seed, 'crates', cx, cy));
    const n = rng.chance(0.45) ? (rng.chance(0.3) ? 2 : 1) : 0;
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const lx = rng.int(1, S - 2);
        const ly = rng.int(1, S - 2);
        const gx = cx * S + lx;
        const gy = cy * S + ly;
        const inOutpost = gx >= o.x - 1 && gy >= o.y - 1 && gx <= o.x + o.w && gy <= o.y + o.h;
        if (inOutpost || ctx.tiles.solid[tiles[ly * S + lx]!] || ctx.tiles.solid[tiles[(ly - 1) * S + lx]!]) continue;
        out.push({ id: `crate:${cx},${cy}:${i}`, kind: 'crate', x: (gx + 0.5) * T, y: (gy + 0.8) * T, variant: 'supply', lootTable: 'supply_crate' });
        break;
      }
    }
    return out;
  },

  population(seed, params, W, H, walkable) {
    const T = 32;
    const o = outpostRect(params, W, H);
    const ocx = o.x + o.w / 2;
    const ocy = o.y + o.h / 2;
    const rng = new Rng(deriveSeed(seed, 'camps'));
    const taken: { x: number; y: number }[] = [{ x: ocx, y: ocy }];
    /** A walkable tile at a distance band from the outpost, away from other camps. */
    const openSpot = (minD: number, maxD: number, spacing: number): { x: number; y: number } => {
      for (let i = 0; i < 400; i++) {
        const a = rng.range(0, Math.PI * 2);
        const d = rng.range(minD, maxD);
        const tx = Math.round(ocx + Math.cos(a) * d);
        const ty = Math.round(ocy + Math.sin(a) * d);
        if (tx < 4 || ty < 4 || tx >= W - 4 || ty >= H - 4) continue;
        let clear = true;
        for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1 && clear; dx++) clear = walkable(tx + dx, ty + dy);
        if (!clear || taken.some((p) => Math.hypot(p.x - tx, p.y - ty) < spacing)) continue;
        taken.push({ x: tx, y: ty });
        return { x: tx, y: ty };
      }
      return { x: ocx, y: o.y + o.h + 3 };
    };
    return params.camps.map((c): CampSpawn => {
      const home = c.at === 'outpost' ? { x: ocx, y: ocy + 1 } : openSpot(22, 45, 14);
      const waypoints =
        c.behavior === 'patrol'
          ? [0, 1, 2, 3].map((i) => {
              // A loose loop around the outpost, one waypoint per quadrant.
              const a = (i / 4) * Math.PI * 2 + rng.range(-0.4, 0.4);
              for (let tries = 0; tries < 60; tries++) {
                const d = rng.range(16, 30);
                const tx = Math.round(ocx + Math.cos(a) * d);
                const ty = Math.round(ocy + Math.sin(a) * d);
                if (tx > 3 && ty > 3 && tx < W - 3 && ty < H - 3 && walkable(tx, ty)) return { x: (tx + 0.5) * T, y: (ty + 0.5) * T };
              }
              return { x: (home.x + 0.5) * T, y: (home.y + 0.5) * T };
            })
          : [];
      return {
        id: c.id,
        faction: c.faction,
        templates: c.templates,
        behavior: c.behavior,
        x: (home.x + 0.5) * T,
        y: (home.y + 0.5) * T,
        radius: c.radius * T,
        waypoints,
      };
    });
  },

  spawnPoint(_seed, params, W, H) {
    const o = outpostRect(params, W, H);
    return { x: o.x + Math.floor(o.w / 2), y: o.y + o.h - 3 };
  },
};

registerGenerator(testRangeGenerator);
