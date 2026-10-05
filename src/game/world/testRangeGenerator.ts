import { fbm2D, deriveSeed } from '../../core/rng';
import { parseOrThrow, v } from '../../content/schema';
import type { TileSet } from './TileSet';
import { registerGenerator, type WorldGenerator } from './generators';

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
});

interface Params {
  ground: number;
  grass: number;
  grassThreshold: number;
  rock: number;
  rockThreshold: number;
  border: number;
  outpost: { floor: number; grate: number; wall: number; hazard: number; width: number; height: number };
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
  if (fbm2D(deriveSeed(seed, 'grass'), gx / 7, gy / 7, 3) > p.grassThreshold) return p.grass;
  return p.ground;
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

  spawnPoint(_seed, params, W, H) {
    const o = outpostRect(params, W, H);
    return { x: o.x + Math.floor(o.w / 2), y: o.y + o.h - 3 };
  },
};

registerGenerator(testRangeGenerator);
