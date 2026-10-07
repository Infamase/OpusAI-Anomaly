import { parseOrThrow, v } from '../../content/schema';
import { THEME_SLOTS, type ThemeSlot } from '../../content/types/legend';
import type { RoomDef } from '../../content/types/room';
import { deriveSeed, Rng } from '../../core/rng';
import { orientedCell, orientedSize, resolveDrawing, type Cell, type Drawing } from './drawings';
import { registerGenerator, type CampSpawn, type Landmark, type PortalSpawn, type WorldGenerator, type WorldObjectSpawn } from './generators';
import type { TileSet } from './TileSet';

/**
 * Interiors: space stations, ships and underground labs assembled from room
 * drawings. Rooms carry door sockets on their outer walls; starting from the
 * entrance, the generator keeps attaching rooms at open sockets (rotating
 * them to fit, walls shared, never overlapping floors), then opens a few
 * extra doors where two rooms' sockets happen to meet (loops) and seals the
 * rest. The theme decides which tiles "$wall", "$floor"… become, so the same
 * rooms build a white lab or a rusty freighter.
 */

const T = 32;

const paramsSchema = v.object({
  theme: v.object(Object.fromEntries(THEME_SLOTS.map((s) => [s, v.id()])) as Record<ThemeSlot, ReturnType<typeof v.id>>),
  /** The room you arrive in (holds the way back out). */
  start: v.id(),
  /** Which rooms to use: by id or by tag, with weights and limits. */
  rooms: v.array(
    v.object({
      id: v.optional(v.id()),
      tag: v.optional(v.id()),
      weight: v.optional(v.number({ min: 0 }), 1),
      min: v.optional(v.number({ int: true, min: 0 }), 0),
      max: v.optional(v.number({ int: true, min: 0 }), 99),
    }),
    { min: 1 },
  ),
  /** How many rooms, entrance included. */
  count: v.tuple2(v.number({ int: true, min: 1 }), v.number({ int: true, min: 1 })),
  /** Chance to open a door where two rooms' sockets meet (more = more loops). */
  loops: v.optional(v.number({ min: 0, max: 1 }), 0.5),
});

interface RoomRes extends Drawing {
  def: RoomDef;
}

interface Pool {
  rooms: RoomRes[];
  weight: number;
  min: number;
  max: number;
  used: number;
}

interface Params {
  theme: Record<ThemeSlot, number>;
  start: RoomRes;
  pools: Pool[];
  count: [number, number];
  loops: number;
  plans: Map<string, Plan>;
}

interface Placed {
  index: number;
  room: RoomRes;
  x: number;
  y: number;
  w: number;
  h: number;
  orient: number;
  /** Oriented local indices (j * w + i) of sockets turned into doorways. */
  open: Set<number>;
  hasCamp: boolean;
}

interface Plan {
  W: number;
  H: number;
  tiles: Uint16Array;
  placed: Placed[];
}

type Facing = 0 | 1 | 2 | 3; // N E S W
const STEP: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** Which way a socket on a room's edge faces (outward). */
function facingOf(i: number, j: number, w: number, h: number): Facing {
  if (j === 0) return 0;
  if (i === w - 1) return 1;
  if (j === h - 1) return 2;
  return 3;
}

const cellAt = (p: Placed, i: number, j: number): Cell | null => orientedCell(p.room, p.orient, i, j);

function makePlan(p: Params, seed: number, W: number, H: number): Plan {
  const rng = new Rng(deriveSeed(seed, 'interior'));
  // 0 empty, 1 wall, 2 floor.
  const occ = new Uint8Array(W * H);
  const placed: Placed[] = [];
  const open: { room: number; i: number; j: number; facing: Facing }[] = [];
  const margin = 2;

  const fits = (room: RoomRes, orient: number, x: number, y: number): boolean => {
    const { w, h } = orientedSize(room, orient);
    if (x < margin || y < margin || x + w > W - margin || y + h > H - margin) return false;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = orientedCell(room, orient, i, j);
        if (!c) continue;
        const o = occ[(y + j) * W + x + i]!;
        if (o === 0) continue;
        // Walls may share walls; nothing may sit on a floor.
        if (o === 2 || !(c.wall || c.door)) return false;
      }
    }
    return true;
  };

  const place = (room: RoomRes, orient: number, x: number, y: number): Placed => {
    const { w, h } = orientedSize(room, orient);
    const pr: Placed = { index: placed.length, room, x, y, w, h, orient, open: new Set(), hasCamp: false };
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const c = orientedCell(room, orient, i, j);
        if (!c) continue;
        const k = (y + j) * W + x + i;
        if (c.wall || c.door) {
          if (occ[k] === 0) occ[k] = 1;
        } else occ[k] = 2;
        if (c.door) open.push({ room: pr.index, i, j, facing: facingOf(i, j, w, h) });
      }
    }
    pr.hasCamp = !!room.def.camp && new Rng(deriveSeed(seed, 'roomcamp', pr.index)).chance(room.def.camp.chance);
    placed.push(pr);
    return pr;
  };

  // The entrance, in the middle.
  const s0 = orientedSize(p.start, 0);
  place(p.start, 0, Math.floor(W / 2 - s0.w / 2), Math.floor(H / 2 - s0.h / 2));

  const target = rng.int(p.count[0], Math.max(p.count[0], p.count[1]));
  const pools = p.pools.map((pool) => ({ ...pool, used: 0 }));
  /**
   * Pools still short of their minimum come first; otherwise weighted by
   * `weight`. `relaxed` ignores the minimums (when a must-have room won't fit
   * at this socket, something else should, or growth would stall).
   */
  const pickPool = (relaxed: boolean) => {
    const short = relaxed ? [] : pools.filter((q) => q.used < q.min);
    const can = short.length ? short : pools.filter((q) => q.used < q.max && q.weight > 0);
    if (!can.length) return null;
    let r = rng.range(0, can.reduce((t, q) => t + (short.length ? 1 : q.weight), 0));
    return can.find((q) => (r -= short.length ? 1 : q.weight) <= 0) ?? can[can.length - 1]!;
  };

  let guard = 0;
  while (placed.length < target && open.length && guard++ < 4000) {
    // Grow from a random open socket.
    const si = rng.int(0, open.length - 1);
    const s = open[si]!;
    const a = placed[s.room]!;
    const wx = a.x + s.i;
    const wy = a.y + s.j;
    // The cell beyond the socket must be free for a room to attach there.
    const [dx, dy] = STEP[s.facing]!;
    if (occ[(wy + dy) * W + wx + dx] !== 0) {
      open.splice(si, 1);
      continue;
    }
    /** Tries to attach `room` at this socket in some orientation. */
    const attach = (pool: Pool, room: RoomRes): boolean => {
      const orients = room.def.rotate ? [0, 1, 2, 3, 4, 5, 6, 7] : [0];
      // Shuffle the orientations so rooms don't all face one way.
      for (let k = orients.length - 1; k > 0; k--) {
        const r = rng.int(0, k);
        [orients[k], orients[r]] = [orients[r]!, orients[k]!];
      }
      for (const orient of orients) {
        const { w, h } = orientedSize(room, orient);
        const sockets: { i: number; j: number }[] = [];
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            if (orientedCell(room, orient, i, j)?.door && facingOf(i, j, w, h) === ((s.facing + 2) % 4)) sockets.push({ i, j });
          }
        }
        if (!sockets.length) continue;
        const t = sockets[rng.int(0, sockets.length - 1)]!;
        const bx = wx - t.i;
        const by = wy - t.j;
        if (!fits(room, orient, bx, by)) continue;
        const b = place(room, orient, bx, by);
        b.open.add(t.j * w + t.i);
        a.open.add(s.j * a.w + s.i);
        pool.used++;
        return true;
      }
      return false;
    };
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const pool = pickPool(attempt >= 3);
      if (!pool) break;
      done = attach(pool, pool.rooms[rng.int(0, pool.rooms.length - 1)]!);
    }
    // Before sealing a socket for good, try every room still allowed (in random
    // order): early on, a few unlucky picks of big rooms would otherwise stop
    // the whole layout from growing.
    if (!done) {
      const all = pools.filter((q) => q.used < q.max && (q.weight > 0 || q.used < q.min)).flatMap((q) => q.rooms.map((room) => ({ q, room })));
      for (let k = all.length - 1; k > 0; k--) {
        const r = rng.int(0, k);
        [all[k], all[r]] = [all[r]!, all[k]!];
      }
      for (const { q, room } of all) if (attach(q, room)) break;
    }
    open.splice(open.indexOf(s), 1);
  }

  // Loops: where two rooms' sockets share a cell, sometimes open a door.
  const sockets = new Map<number, { room: Placed; local: number }[]>();
  for (const r of placed) {
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        if (!cellAt(r, i, j)?.door) continue;
        const k = (r.y + j) * W + r.x + i;
        const list = sockets.get(k) ?? [];
        list.push({ room: r, local: j * r.w + i });
        sockets.set(k, list);
      }
    }
  }
  const lrng = new Rng(deriveSeed(seed, 'loops'));
  for (const list of sockets.values()) {
    if (list.length < 2 || list.some((x) => x.room.open.has(x.local))) continue;
    if (!lrng.chance(p.loops)) continue;
    for (const x of list) x.room.open.add(x.local);
  }

  // Paint: outside first, then each room (floors win over walls; open sockets become doors).
  const tiles = new Uint16Array(W * H).fill(p.theme.outside);
  const isFloor = new Uint8Array(W * H);
  for (const r of placed) {
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        const c = cellAt(r, i, j);
        if (!c) continue;
        const k = (r.y + j) * W + r.x + i;
        if (c.door) {
          if (r.open.has(j * r.w + i)) {
            tiles[k] = p.theme.door;
            isFloor[k] = 1;
          } else if (!isFloor[k]) tiles[k] = c.tile;
        } else if (c.wall) {
          if (!isFloor[k]) tiles[k] = c.tile;
        } else if (c.tile >= 0) {
          tiles[k] = c.tile;
          isFloor[k] = 1;
        }
      }
    }
  }
  return { W, H, tiles, placed };
}

function planFor(p: Params, seed: number, W: number, H: number): Plan {
  const key = `${seed}:${W}x${H}`;
  let plan = p.plans.get(key);
  if (!plan) {
    plan = makePlan(p, seed, W, H);
    p.plans.set(key, plan);
  }
  return plan;
}

/** Every cell of every placed room (world tile coords), for objects, camps and portals. */
function* roomCells(plan: Plan): Generator<{ r: Placed; i: number; j: number; x: number; y: number; c: Cell }> {
  for (const r of plan.placed) {
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        const c = cellAt(r, i, j);
        if (c) yield { r, i, j, x: r.x + i, y: r.y + j, c };
      }
    }
  }
}

export const interiorGenerator: WorldGenerator<Params> = {
  id: 'interior',
  version: 1,

  parseParams(raw, tiles, content) {
    if (!content) throw new Error('interior generator needs the content registry');
    const r = parseOrThrow(paramsSchema, raw, 'interior params');
    const theme = Object.fromEntries(THEME_SLOTS.map((s) => [s, tiles.index(r.theme[s])])) as Record<ThemeSlot, number>;
    const resolve = (def: RoomDef): RoomRes => ({ ...resolveDrawing(def, tiles, theme), def });
    const pools: Pool[] = r.rooms.map((e) => {
      const defs = e.id ? [content.get('room', e.id)] : content.all('room').filter((d) => d.tags.includes(e.tag ?? ''));
      if (!defs.length) throw new Error(`interior params: no rooms match ${e.id ? `id "${e.id}"` : `tag "${e.tag}"`}`);
      return { rooms: defs.map(resolve), weight: e.weight, min: e.min, max: e.max, used: 0 };
    });
    return { theme, start: resolve(content.get('room', r.start)), pools, count: r.count, loops: r.loops, plans: new Map() };
  },

  generateChunk(ctx, out) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H } = ctx;
    const plan = planFor(ctx.params, ctx.seed, W, H);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = plan.tiles[(cy * S + y) * W + cx * S + x]!;
  },

  objects(ctx) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H } = ctx;
    const plan = planFor(ctx.params, ctx.seed, W, H);
    const out: WorldObjectSpawn[] = [];
    const x0 = cx * S;
    const y0 = cy * S;
    for (const { r, i, j, x, y, c } of roomCells(plan)) {
      if (x < x0 || y < y0 || x >= x0 + S || y >= y0 + S) continue;
      if (c.crate) out.push({ id: `crate:${r.index}:${i},${j}`, kind: 'crate', x: (x + 0.5) * T, y: (y + 0.8) * T, variant: c.crate.variant, lootTable: c.crate.lootTable });
      if (c.anomaly) out.push({ id: `anomaly:${r.index}:${i},${j}`, kind: 'anomaly', x: (x + 0.5) * T, y: (y + 0.5) * T, anomaly: c.anomaly });
    }
    return out;
  },

  population(seed, params, W, H) {
    const plan = planFor(params, seed, W, H);
    const camps: CampSpawn[] = [];
    for (const r of plan.placed) {
      const c = r.room.def.camp;
      if (!c || !r.hasCamp) continue;
      let home = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) if (cellAt(r, i, j)?.camp) home = { x: r.x + i + 0.5, y: r.y + j + 0.5 };
      camps.push({ id: `${r.room.def.id}_${r.index}`, faction: c.faction, templates: c.templates, behavior: c.behavior, x: home.x * T, y: home.y * T, radius: c.radius * T, waypoints: [] });
    }
    return camps;
  },

  spawnPoint(seed, params, W, H) {
    const plan = planFor(params, seed, W, H);
    const start = plan.placed[0]!;
    for (let j = 0; j < start.h; j++) for (let i = 0; i < start.w; i++) if (cellAt(start, i, j)?.spawn) return { x: start.x + i, y: start.y + j };
    return { x: start.x + Math.floor(start.w / 2), y: start.y + Math.floor(start.h / 2) };
  },

  portals(seed, params, W, H): PortalSpawn[] {
    const plan = planFor(params, seed, W, H);
    const out: PortalSpawn[] = [];
    for (const { r, i, j, x, y, c } of roomCells(plan)) {
      if (c.portal) out.push({ id: `portal:${r.index}:${i},${j}`, x: (x + 0.5) * T, y: (y + 0.5) * T, world: c.portal.world, label: c.portal.label });
    }
    return out;
  },

  /** Rooms tagged "landmark" get their name on the map. */
  landmarks(seed, params, W, H): Landmark[] {
    const plan = planFor(params, seed, W, H);
    return plan.placed.filter((r) => r.room.def.tags.includes('landmark')).map((r) => ({ id: `room_${r.index}`, name: r.room.def.name, x: r.x + r.w / 2, y: r.y + r.h / 2, w: r.w, h: r.h }));
  },

  /** The name of the room at a tile (for the HUD). */
  areaAt(seed, params, W, H, tx, ty) {
    const plan = planFor(params, seed, W, H);
    for (const r of plan.placed) {
      if (tx > r.x && ty > r.y && tx < r.x + r.w - 1 && ty < r.y + r.h - 1) return r.room.def.name;
    }
    return undefined;
  },
};

registerGenerator(interiorGenerator);

/** For tests and tools. */
export function interiorPlan(params: unknown, seed: number, W: number, H: number): Readonly<Plan> {
  return planFor(params as Params, seed, W, H);
}
