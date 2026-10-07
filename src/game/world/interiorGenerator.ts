import { parseOrThrow, v } from '../../content/schema';
import { THEME_SLOTS, type ThemeSlot } from '../../content/types/legend';
import type { RoomDef } from '../../content/types/room';
import { deriveSeed, Rng } from '../../core/rng';
import { orientedCell, orientedSize, resolveDrawing, type Cell, type Drawing } from './drawings';
import { registerGenerator, type CampSpawn, type Landmark, type PortalSpawn, type StaticLightSpawn, type WorldGenerator, type WorldObjectSpawn } from './generators';
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
  /** Where sockets meet but stay shut, the chance the wall is the theme's `fragile` one instead (a shortcut to shoot through). */
  secrets: v.optional(v.number({ min: 0, max: 1 }), 0.4),
  /** Real doors: each doorway gets the `tile` (a closed door) with `chance`; the rest stay open doorways. */
  doors: v.optional(v.object({ tile: v.id(), chance: v.number({ min: 0, max: 1 }) })),
  /**
   * Rooms tagged "secure" are locked with `chance`: every way in gets `tile`
   * (a locked door). Its keycard is left somewhere you can reach without it.
   */
  locks: v.optional(v.object({ tile: v.id(), chance: v.number({ min: 0, max: 1 }) })),
  /** Some doorways are barricaded (`tile`) with `chance`: shoot your way through. */
  barricades: v.optional(v.object({ tile: v.id(), chance: v.number({ min: 0, max: 1 }) })),
  /**
   * Booby traps: with `chance`, a doorway gets one of `explosives` just inside
   * (a claymore beside the door with its tripwire across the way in, an IED).
   */
  traps: v.optional(v.object({ explosives: v.array(v.id(), { min: 1 }), chance: v.number({ min: 0, max: 1 }) })),
  /**
   * Ceiling lamps: one per room (two in long ones). `working` of them light
   * up, and `flickering` of those stutter like failing tubes.
   */
  lamps: v.optional(
    v.object({
      color: v.color(),
      radius: v.optional(v.number({ min: 1 }), 6),
      intensity: v.optional(v.number({ min: 0, max: 2 }), 0.9),
      working: v.optional(v.number({ min: 0, max: 1 }), 0.85),
      flickering: v.optional(v.number({ min: 0, max: 1 }), 0.15),
    }),
  ),
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
  secrets: number;
  doors: { tile: number; chance: number } | null;
  locks: { tile: number; chance: number; key: string } | null;
  barricades: { tile: number; chance: number } | null;
  traps: { explosives: string[]; chance: number } | null;
  lamps: { color: string; radius: number; intensity: number; working: number; flickering: number } | null;
  plans: Map<string, Plan>;
}

/** A way between two rooms: the cell (k = y * W + x) where their sockets met, and what fills it. */
interface Link {
  a: number;
  b: number;
  k: number;
  kind: 'doorway' | 'door' | 'locked' | 'barricade';
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
  links: Link[];
  /** Keycards left lying around (tile coords), for the locked rooms. */
  keycards: { item: string; x: number; y: number }[];
  /** Booby traps by doorways (tile coords, facing). */
  traps: { id: string; x: number; y: number; angle: number; faction?: string }[];
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
  const links: Link[] = [];
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
        links.push({ a: a.index, b: b.index, k: wy * W + wx, kind: 'doorway' });
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
  for (const [k, list] of sockets) {
    if (list.length < 2 || list.some((x) => x.room.open.has(x.local))) continue;
    if (!lrng.chance(p.loops)) continue;
    for (const x of list) x.room.open.add(x.local);
    links.push({ a: list[0]!.room.index, b: list[1]!.room.index, k, kind: 'doorway' });
  }

  // What fills each way between rooms: locked doors into secure rooms, then barricades, doors, open doorways.
  const drng = new Rng(deriveSeed(seed, 'doors'));
  if (p.locks) {
    for (const r of placed) {
      if (r.index === 0 || !r.room.def.tags.includes('secure') || !drng.chance(p.locks.chance)) continue;
      for (const l of links) if (l.a === r.index || l.b === r.index) l.kind = 'locked';
    }
  }
  for (const l of links) {
    if (l.kind !== 'doorway') continue;
    // Never barricade the way out of the entrance room.
    if (p.barricades && l.a !== 0 && l.b !== 0 && drng.chance(p.barricades.chance)) l.kind = 'barricade';
    else if (p.doors && drng.chance(p.doors.chance)) l.kind = 'door';
  }

  // Paint: outside first, then each room (floors win over walls; open sockets become doors).
  const fill = new Map<number, number>();
  for (const l of links) {
    if (l.kind === 'locked') fill.set(l.k, p.locks!.tile);
    else if (l.kind === 'barricade') fill.set(l.k, p.barricades!.tile);
    else if (l.kind === 'door') fill.set(l.k, p.doors!.tile);
  }
  const tiles = new Uint16Array(W * H).fill(p.theme.outside);
  const isFloor = new Uint8Array(W * H);
  /** Which room each floor cell belongs to (+1; 0 = none). */
  const roomOf = new Int16Array(W * H);
  for (const r of placed) {
    for (let j = 0; j < r.h; j++) {
      for (let i = 0; i < r.w; i++) {
        const c = cellAt(r, i, j);
        if (!c) continue;
        const k = (r.y + j) * W + r.x + i;
        if (c.door) {
          if (r.open.has(j * r.w + i)) {
            tiles[k] = fill.get(k) ?? p.theme.door;
            isFloor[k] = 1;
          } else if (!isFloor[k]) tiles[k] = c.tile;
        } else if (c.wall) {
          if (!isFloor[k]) tiles[k] = c.tile;
        } else if (c.tile >= 0) {
          tiles[k] = c.tile;
          isFloor[k] = 1;
          roomOf[k] = r.index + 1;
        }
      }
    }
  }
  // Weak spots: where two rooms that aren't joined share a one-tile wall, sometimes it's fragile (a shortcut to shoot through).
  const linked = new Set(links.map((l) => `${Math.min(l.a, l.b)}:${Math.max(l.a, l.b)}`));
  const between = new Map<string, number[]>();
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const k = y * W + x;
      if (tiles[k] !== p.theme.wall) continue;
      for (const [a, b] of [
        [k - 1, k + 1],
        [k - W, k + W],
      ] as const) {
        const ra = roomOf[a]!;
        const rb = roomOf[b]!;
        if (!ra || !rb || ra === rb) continue;
        const pair = `${Math.min(ra, rb) - 1}:${Math.max(ra, rb) - 1}`;
        if (linked.has(pair)) continue;
        const list = between.get(pair) ?? [];
        list.push(k);
        between.set(pair, list);
      }
    }
  }
  const frng = new Rng(deriveSeed(seed, 'fragile'));
  for (const cells of between.values()) {
    if (!frng.chance(p.secrets)) continue;
    tiles[cells[Math.floor(cells.length / 2)]!] = p.theme.fragile;
  }

  // Booby traps just inside some doorways (never into the entrance room).
  const traps: Plan['traps'] = [];
  if (p.traps) {
    const trng = new Rng(deriveSeed(seed, 'traps'));
    const busy = new Set<number>();
    for (const r of placed) {
      for (let j = 0; j < r.h; j++) {
        for (let i = 0; i < r.w; i++) {
          const c = cellAt(r, i, j);
          if (c && (c.crate || c.anomaly || c.portal || c.spawn || c.camp)) busy.add((r.y + j) * W + r.x + i);
        }
      }
    }
    for (const l of links) {
      if ((l.kind !== 'doorway' && l.kind !== 'door') || l.a === 0 || l.b === 0 || !trng.chance(p.traps.chance)) continue;
      const x = l.k % W;
      const y = (l.k - x) / W;
      // Which way is into room b?
      const into = ([[0, -1], [1, 0], [0, 1], [-1, 0]] as const).find(([dx, dy]) => roomOf[(y + dy) * W + x + dx] === l.b + 1);
      if (!into) continue;
      const [ix, iy] = into;
      const id = p.traps.explosives[trng.int(0, p.traps.explosives.length - 1)]!;
      for (const side of trng.chance(0.5) ? [1, -1] : [-1, 1]) {
        // One step in and one to the side, facing across the way in.
        const sx = -iy * side;
        const sy = ix * side;
        const tx = x + ix + sx;
        const ty = y + iy + sy;
        const k = ty * W + tx;
        if (roomOf[k] !== l.b + 1 || busy.has(k) || !isFloor[k]) continue;
        busy.add(k);
        const camp = placed[l.b]!;
        traps.push({ id, x: tx, y: ty, angle: Math.atan2(-sy, -sx), faction: camp.hasCamp ? camp.room.def.camp?.faction : undefined });
        break;
      }
    }
  }
  return { W, H, tiles, placed, links, keycards: placeKeycards(p, seed, placed, links), traps };
}

/**
 * Leaves the keycard for the locked rooms in a room you can reach from the
 * entrance without going through a locked door or a barricade, on clear floor
 * away from anomalies.
 */
function placeKeycards(p: Params, seed: number, placed: Placed[], links: Link[]): Plan['keycards'] {
  if (!p.locks || !links.some((l) => l.kind === 'locked')) return [];
  const reach = new Set([0]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of links) {
      if (l.kind === 'locked' || l.kind === 'barricade') continue;
      if (reach.has(l.a) !== reach.has(l.b)) {
        reach.add(l.a);
        reach.add(l.b);
        grew = true;
      }
    }
  }
  const rng = new Rng(deriveSeed(seed, 'keycard'));
  const rooms = [...reach].filter((i) => i !== 0 || reach.size === 1).map((i) => placed[i]!);
  // Prefer rooms farther from the entrance, so finding it takes a little exploring.
  rooms.sort((a, b) => Math.hypot(b.x - placed[0]!.x, b.y - placed[0]!.y) - Math.hypot(a.x - placed[0]!.x, a.y - placed[0]!.y));
  const far = rooms.slice(0, Math.max(1, Math.ceil(rooms.length / 2)));
  for (let k = far.length - 1; k > 0; k--) {
    const r = rng.int(0, k);
    [far[k], far[r]] = [far[r]!, far[k]!];
  }
  for (const r of [...far, ...rooms]) {
    const spots: { x: number; y: number }[] = [];
    for (let j = 1; j < r.h - 1; j++) {
      for (let i = 1; i < r.w - 1; i++) {
        const c = cellAt(r, i, j);
        if (!c || c.wall || c.door || c.crate || c.anomaly || c.portal || c.tile < 0) continue;
        let nearHazard = false;
        for (let dj = -2; dj <= 2 && !nearHazard; dj++) for (let di = -2; di <= 2; di++) if (cellAt(r, i + di, j + dj)?.anomaly) nearHazard = true;
        if (!nearHazard) spots.push({ x: r.x + i, y: r.y + j });
      }
    }
    if (!spots.length) continue;
    const s = spots[rng.int(0, spots.length - 1)]!;
    return [{ item: p.locks.key, x: s.x, y: s.y }];
  }
  return [];
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
  version: 3,

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
    const lockTile = r.locks ? tiles.index(r.locks.tile) : -1;
    const key = r.locks ? tiles.defs[lockTile]!.door?.key : undefined;
    if (r.locks && !key) throw new Error(`interior params: locks.tile "${r.locks.tile}" is not a locked door`);
    return {
      theme,
      start: resolve(content.get('room', r.start)),
      pools,
      count: r.count,
      loops: r.loops,
      secrets: r.secrets,
      doors: r.doors ? { tile: tiles.index(r.doors.tile), chance: r.doors.chance } : null,
      locks: r.locks ? { tile: lockTile, chance: r.locks.chance, key: key! } : null,
      barricades: r.barricades ? { tile: tiles.index(r.barricades.tile), chance: r.barricades.chance } : null,
      traps: r.traps ? { explosives: r.traps.explosives.map((id) => content.get('explosive', id).id), chance: r.traps.chance } : null,
      lamps: r.lamps ?? null,
      plans: new Map(),
    };
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
      if (c.explosive) out.push({ id: `charge:${r.index}:${i},${j}`, kind: 'explosive', x: (x + 0.5) * T, y: (y + 0.6) * T, explosive: c.explosive, angle: Math.atan2(j + 0.5 - r.h / 2, i + 0.5 - r.w / 2), faction: r.hasCamp ? r.room.def.camp?.faction : undefined });
    }
    plan.traps.forEach((tr, n) => {
      if (tr.x >= x0 && tr.y >= y0 && tr.x < x0 + S && tr.y < y0 + S) out.push({ id: `trap:${n}`, kind: 'explosive', x: (tr.x + 0.5) * T, y: (tr.y + 0.6) * T, explosive: tr.id, angle: tr.angle, faction: tr.faction });
    });
    plan.keycards.forEach((kc, n) => {
      if (kc.x >= x0 && kc.y >= y0 && kc.x < x0 + S && kc.y < y0 + S) out.push({ id: `keycard:${n}`, kind: 'item', x: (kc.x + 0.5) * T, y: (kc.y + 0.6) * T, item: kc.item });
    });
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

  /** Ceiling lamps over the rooms: some dead, some flickering (fixed per seed). */
  lights(seed, params, W, H): StaticLightSpawn[] {
    const plan = planFor(params, seed, W, H);
    const lamps = params.lamps;
    if (!lamps) return [];
    const rng = new Rng(deriveSeed(seed, 'lamps'));
    const out: StaticLightSpawn[] = [];
    for (const r of plan.placed) {
      const long = Math.max(r.w, r.h) >= 12;
      const spots = long
        ? r.w >= r.h
          ? [{ x: r.x + r.w * 0.28, y: r.y + r.h / 2 }, { x: r.x + r.w * 0.72, y: r.y + r.h / 2 }]
          : [{ x: r.x + r.w / 2, y: r.y + r.h * 0.28 }, { x: r.x + r.w / 2, y: r.y + r.h * 0.72 }]
        : [{ x: r.x + r.w / 2, y: r.y + r.h / 2 }];
      for (const s of spots) {
        if (!rng.chance(lamps.working)) continue;
        // On the nearest floor cell (a lamp inside a wall would light nothing).
        let best: { x: number; y: number; d: number } | null = null;
        for (let j = 1; j < r.h - 1; j++) {
          for (let i = 1; i < r.w - 1; i++) {
            const c = cellAt(r, i, j);
            if (!c || c.wall || c.tile < 0) continue;
            const d = Math.hypot(r.x + i + 0.5 - s.x, r.y + j + 0.5 - s.y);
            if (!best || d < best.d) best = { x: r.x + i + 0.5, y: r.y + j + 0.5, d };
          }
        }
        if (!best) continue;
        out.push({ x: best.x, y: best.y, color: lamps.color, radius: lamps.radius, intensity: lamps.intensity, flicker: rng.chance(lamps.flickering) ? 0.8 : 0 });
      }
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
