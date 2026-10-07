import { parseOrThrow, v } from '../../content/schema';
import type { AnomalyDef } from '../../content/types/anomaly';
import type { ArtifactDef } from '../../content/types/artifact';
import type { BiomeDef } from '../../content/types/biome';
import type { StructureDef } from '../../content/types/structure';
import { orientedCell, resolveDrawing, type Cell, type Drawing } from './drawings';
import { deriveSeed, fbm2D, hashInts, Rng } from '../../core/rng';
import { registerGenerator, type CampSpawn, type Landmark, type PortalSpawn, type WorldGenerator, type WorldObjectSpawn } from './generators';
import type { TileSet } from './TileSet';

/**
 * Planets: climate noise picks a biome everywhere (meadow, forest, swamp…),
 * an elevation field makes lakes, rivers run downhill into them, hand-drawn
 * structures are placed by rules and joined by roads found with A*, and each
 * biome scatters its own ground patches, rock outcrops and decorations.
 *
 * Everything large (structure spots, roads, rivers) is decided once per seed
 * in a "plan"; chunks are then generated independently from the plan plus
 * per-tile noise, so any chunk can be rebuilt on its own.
 */

const T = 32;

const paramsSchema = v.object({
  biomes: v.array(v.id(), { min: 1 }),
  /** Cliffs around the edge of the map. */
  border: v.object({ tile: v.id(), width: v.number({ int: true, min: 1 }) }),
  /** Size of hills / lakes and of climate regions, in tiles. */
  elevationScale: v.optional(v.number({ min: 8 }), 110),
  climateScale: v.optional(v.number({ min: 8 }), 150),
  water: v.object({
    deep: v.id(),
    shallow: v.id(),
    /** Share of the map under lakes. */
    lakes: v.number({ min: 0, max: 0.6 }),
    rivers: v.optional(v.number({ int: true, min: 0, max: 12 }), 2),
    riverWidth: v.optional(v.number({ min: 0.5, max: 8 }), 2),
  }),
  roads: v.object({
    tile: v.id(),
    shoulder: v.optional(v.id()),
    bridge: v.id(),
    width: v.optional(v.number({ min: 1, max: 8 }), 3),
    /** Extra connections beyond the minimum needed to join every place (loops). */
    extraLinks: v.optional(v.number({ int: true, min: 0 }), 2),
  }),
  /** The structure the player arrives at, placed near the middle (in one of `startBiomes` if possible). */
  start: v.id(),
  startBiomes: v.optional(v.array(v.id())),
  structures: v.array(
    v.object({
      id: v.id(),
      count: v.tuple2(v.number({ int: true, min: 0 }), v.number({ int: true, min: 0 })),
      /** Minimum gap to other structures, tiles. */
      spacing: v.optional(v.number({ min: 0 }), 24),
      /** Only in these biomes (any if omitted). */
      biomes: v.optional(v.array(v.id())),
      /** Joined to the road network. */
      road: v.optional(v.boolean(), true),
    }),
  ),
  /** Squads walking the roads between places. */
  patrols: v.optional(
    v.array(v.object({ id: v.id(), faction: v.id(), templates: v.array(v.id(), { min: 1 }), count: v.optional(v.number({ int: true, min: 1 }), 1) })),
    [],
  ),
  /** Supply crates lying around in the wild. */
  crates: v.optional(v.object({ chance: v.number({ min: 0, max: 1 }), lootTable: v.id() })),
  /**
   * Anomaly fields: clusters of one or more anomaly kinds, kept away from roads
   * and places, where artifacts grow. Plus `stray` lone anomalies in the wild.
   */
  anomalies: v.optional(
    v.object({
      fields: v.array(
        v.object({
          anomalies: v.array(v.id(), { min: 1 }),
          count: v.tuple2(v.number({ int: true, min: 0 }), v.number({ int: true, min: 0 })),
          /** Anomalies per field. */
          size: v.tuple2(v.number({ int: true, min: 1 }), v.number({ int: true, min: 1 })),
          /** How far members spread from the center, tiles. */
          spread: v.optional(v.number({ min: 1 }), 6),
          biomes: v.optional(v.array(v.id())),
          /** Chance a field holds an artifact (rolled for each of up to 2). */
          artifacts: v.optional(v.number({ min: 0, max: 1 }), 0.6),
        }),
      ),
      stray: v.optional(v.object({ anomalies: v.array(v.id(), { min: 1 }), count: v.number({ int: true, min: 0 }) })),
    }),
  ),
});

// ---- resolved (tile indices) ----------------------------------------------

interface Biome {
  def: BiomeDef;
  index: number;
  ground: number;
  patches: { tile: number; threshold: number; scale: number }[];
  rock: { tile: number; threshold: number; scale: number } | null;
  decor: { tile: number; density: number; clump: number; on: number | null }[];
  /** The highest total decoration chance any tile can have (rolls above it skip the noise). */
  decorMax: number;
  poolThreshold: number;
}

interface Structure extends Drawing {
  def: StructureDef;
  rubble: number;
}

interface Params {
  biomes: Biome[];
  border: { tile: number; width: number };
  elevationScale: number;
  climateScale: number;
  water: { deep: number; shallow: number; lakes: number; rivers: number; riverWidth: number };
  roads: { tile: number; shoulder: number | null; bridge: number; width: number; extraLinks: number };
  start: Structure;
  startBiomes: Set<number> | null;
  structures: { s: Structure; count: [number, number]; spacing: number; biomes: Set<number> | null; road: boolean }[];
  patrols: { id: string; faction: string; templates: string[]; count: number }[];
  crates: { chance: number; lootTable: string } | null;
  anomalyFields: { anomalies: AnomalyDef[]; count: [number, number]; size: [number, number]; spread: number; biomes: Set<number> | null; artifacts: number; growable: ArtifactDef[] }[];
  strays: { anomalies: AnomalyDef[]; count: number } | null;
  plans: Map<string, Plan>;
}

// ---- noise helpers -----------------------------------------------------------

/**
 * fbm values bunch up around 0.5, so "cover 20%" can't be a fixed threshold.
 * These tables (sampled once) turn a share of area into the right threshold.
 */
function sampledCdf(octaves: number): Float32Array {
  const n = 4096;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fbm2D(9173 + octaves, (i % 64) * 3.71 + i * 0.013, Math.floor(i / 64) * 3.29, octaves);
  return out.sort();
}
const CDF3 = sampledCdf(3);
const CDF4 = sampledCdf(4);
/** The fbm value below which `share` of all values fall. */
const quantile = (table: Float32Array, share: number) => table[Math.max(0, Math.min(table.length - 1, Math.floor(share * table.length)))]!;
/** 0..1 rank of an fbm value (uniformly distributed). */
function rank(table: Float32Array, value: number): number {
  let lo = 0;
  let hi = table.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / table.length;
}

/** Normalizes clumping so a clumped decoration keeps its average density: mean of max(0, u - 0.4) for uniform u. */
const GROVE_MEAN = 0.18;

const dist2Seg = (px: number, py: number, s: Segment) => {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len)) : 0;
  const x = s.ax + dx * t - px;
  const y = s.ay + dy * t - py;
  return x * x + y * y;
};

// ---- the plan ------------------------------------------------------------------

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  width: number;
}

interface Placed {
  index: number;
  s: Structure;
  x: number;
  y: number;
  /** Size after rotation. */
  w: number;
  h: number;
  /** 0..7: rotation (×90°) + 4 if mirrored. */
  orient: number;
  broken: Set<number>;
  hasCamp: boolean;
}

interface Plan {
  W: number;
  H: number;
  seed: number;
  terrain: Terrain;
  /** Per tile: distance to the nearest river's bank (negative = in the river). */
  riverEdge: Float32Array;
  /** Per tile: distance to the nearest road's center line. */
  roadDist: Float32Array;
  placed: Placed[];
  roads: Segment[];
  rivers: Segment[];
  /** Road polylines between places (tile coords), for patrol routes. */
  routes: { from: number; to: number; points: { x: number; y: number }[] }[];
  /** Anomaly fields: members and artifacts (tile coords, centers). */
  fields: { x: number; y: number; name: string; spread: number; members: { id: string; x: number; y: number }[]; artifacts: { id: string; x: number; y: number }[] }[];
  /** Lone anomalies. */
  strays: { id: string; x: number; y: number }[];
  chunkCache: Map<string, Placed[]>;
}

/** The authored cell at a placed structure's local (i, j), undoing its rotation/mirror. */
const cellAt = (p: Placed, i: number, j: number): Cell | null => orientedCell(p.s, p.orient, i, j);

/** Large fields are sampled every STEP tiles and interpolated (they're smooth at that scale). */
const STEP = 4;

/**
 * The big, smooth fields of a planet (elevation, moisture, temperature),
 * sampled once on a coarse grid. Ranks (0..1) rather than raw noise, so
 * shares of area (lakes: 9%) and climate points mean what they say.
 */
class Terrain {
  private gw: number;
  private elev: Float32Array;
  private moist: Float32Array;
  private temp: Float32Array;

  constructor(
    readonly p: Params,
    readonly seed: number,
    readonly W: number,
    readonly H: number,
  ) {
    const gw = (this.gw = Math.ceil(W / STEP) + 2);
    const gh = Math.ceil(H / STEP) + 2;
    this.elev = new Float32Array(gw * gh);
    this.moist = new Float32Array(gw * gh);
    this.temp = new Float32Array(gw * gh);
    const s = seed;
    const warp = (x: number, y: number): [number, number] => [
      x + (fbm2D(deriveSeed(s, 'wx'), x / 45, y / 45, 3) - 0.5) * 40,
      y + (fbm2D(deriveSeed(s, 'wy'), x / 45, y / 45, 3) - 0.5) * 40,
    ];
    const es = p.elevationScale;
    const cs = p.climateScale;
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const x = i * STEP;
        const y = j * STEP;
        const [ex, ey] = warp(x, y);
        this.elev[j * gw + i] = rank(CDF4, fbm2D(deriveSeed(s, 'elev'), ex / es, ey / es, 4));
        const [cx, cy] = warp(x * 1.3 + 500, y * 1.3);
        this.moist[j * gw + i] = rank(CDF3, fbm2D(deriveSeed(s, 'moist'), cx / cs, cy / cs, 3));
        this.temp[j * gw + i] = rank(CDF3, fbm2D(deriveSeed(s, 'temp'), cy / cs, cx / cs, 3));
      }
    }
  }

  private sample(f: Float32Array, x: number, y: number): number {
    const gx = Math.max(0, x / STEP);
    const gy = Math.max(0, y / STEP);
    const i = Math.min(this.gw - 2, Math.floor(gx));
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const k = j * this.gw + i;
    const top = f[k]! + (f[k + 1]! - f[k]!) * fx;
    const bottom = (f[k + this.gw] ?? f[k]!) + ((f[k + this.gw + 1] ?? f[k + 1]!) - (f[k + this.gw] ?? f[k]!)) * fx;
    return top + (bottom - top) * fy;
  }

  /** 0..1 rank of elevation (so `< lakes` is exactly the lake share). */
  elevation(x: number, y: number): number {
    return this.sample(this.elev, x, y);
  }

  biome(x: number, y: number): Biome {
    // A little per-tile jitter roughens biome borders.
    const jitter = (hashInts(this.seed, Math.floor(x), Math.floor(y), 3) / 4294967296 - 0.5) * 0.03;
    const m = this.sample(this.moist, x, y) + jitter;
    const t = this.sample(this.temp, x, y) - jitter;
    let best = this.p.biomes[0]!;
    let bd = Infinity;
    for (const b of this.p.biomes) {
      const d = Math.hypot(m - b.def.climate.moisture, t - b.def.climate.temperature) / b.def.climate.weight;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    return best;
  }

  borderDepth(x: number, y: number): number {
    const d = Math.min(x, y, this.W - 1 - x, this.H - 1 - y);
    if (d > this.p.border.width + 5) return d;
    return d - (fbm2D(deriveSeed(this.seed, 'border'), x / 9, y / 9, 3) - 0.5) * 8;
  }

  isLake(x: number, y: number): boolean {
    return this.elevation(x, y) < this.p.water.lakes;
  }
}

function makePlan(p: Params, seed: number, W: number, H: number): Plan {
  const terrain = new Terrain(p, seed, W, H);
  const far = () => new Float32Array(W * H).fill(1e9);
  const plan: Plan = { W, H, seed, terrain, riverEdge: far(), roadDist: far(), placed: [], roads: [], rivers: [], routes: [], fields: [], strays: [], chunkCache: new Map() };
  const margin = p.border.width + 6;

  // --- Rivers: start on high ground and walk downhill until they reach a lake.
  const rrng = new Rng(deriveSeed(seed, 'rivers'));
  for (let r = 0; r < p.water.rivers; r++) {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 200; tries++) {
      x = rrng.range(margin, W - margin);
      y = rrng.range(margin, H - margin);
      if (terrain.elevation(x, y) > 0.78) break;
    }
    let dir = rrng.range(0, Math.PI * 2);
    const heading = dir;
    const width = p.water.riverWidth * rrng.range(0.8, 1.25);
    for (let step = 0; step < 400; step++) {
      let best = dir;
      let bestE = Infinity;
      for (let k = -3; k <= 3; k++) {
        const a = dir + k * 0.35;
        // Downhill, but keeping a general heading so rivers don't loop back on themselves.
        const turn = Math.abs(Math.atan2(Math.sin(a - heading), Math.cos(a - heading)));
        const e = terrain.elevation(x + Math.cos(a) * 7, y + Math.sin(a) * 7) + Math.abs(k) * 0.006 + Math.max(0, turn - 1) * 0.05 + rrng.range(0, 0.01);
        if (e < bestE) {
          bestE = e;
          best = a;
        }
      }
      dir = best;
      const nx = x + Math.cos(dir) * 3.5;
      const ny = y + Math.sin(dir) * 3.5;
      plan.rivers.push({ ax: x, ay: y, bx: nx, by: ny, width });
      x = nx;
      y = ny;
      if (terrain.isLake(x, y)) break;
      if (x < margin || y < margin || x > W - margin || y > H - margin || step === 399) {
        // Rivers that don't reach a lake end in a pond.
        plan.rivers.push({ ax: x, ay: y, bx: x + 0.1, by: y, width: width * 2.6 });
        break;
      }
    }
  }
  for (const s of plan.rivers) stampDistance(plan.riverEdge, W, H, s, s.width + 8, s.width);
  const nearRiver = (x: number, y: number, pad: number) => {
    const k = Math.floor(y) * W + Math.floor(x);
    return k >= 0 && k < W * H && plan.riverEdge[k]! < pad;
  };

  // --- Structures: the start first (near the middle), then the rest by rule.
  const srng = new Rng(deriveSeed(seed, 'structures'));
  const tryPlace = (s: Structure, spacing: number, biomes: Set<number> | null, central: boolean): Placed | null => {
    for (let tries = 0; tries < (central ? 600 : 250); tries++) {
      const orient = s.def.rotate ? srng.int(0, 7) : 0;
      const w = orient & 1 ? s.h : s.w;
      const h = orient & 1 ? s.w : s.h;
      const span = central ? 0.18 : 0.5;
      const x = Math.round(central ? srng.range(W * (0.5 - span), W * (0.5 + span)) - w / 2 : srng.range(margin, W - margin - w));
      const y = Math.round(central ? srng.range(H * (0.5 - span), H * (0.5 + span)) - h / 2 : srng.range(margin, H - margin - h));
      if (x < margin || y < margin || x + w > W - margin || y + h > H - margin) continue;
      if (biomes && !biomes.has(terrain.biome(x + w / 2, y + h / 2).index)) continue;
      let ok = true;
      for (let j = -2; j <= h + 2 && ok; j += 3) {
        for (let i = -2; i <= w + 2 && ok; i += 3) ok = terrain.elevation(x + i, y + j) > p.water.lakes + 0.04 && !nearRiver(x + i, y + j, 4);
      }
      if (!ok) continue;
      const gap = (q: Placed) => Math.max(q.x - (x + w), x - (q.x + q.w), q.y - (y + h), y - (q.y + q.h));
      if (plan.placed.some((q) => gap(q) < Math.max(spacing, 10))) continue;
      const index = plan.placed.length;
      const placed: Placed = { index, s, x, y, w, h, orient, broken: new Set(), hasCamp: false };
      // Ruins: some wall tiles are knocked out (seeded per place).
      const drng = new Rng(deriveSeed(seed, 'decay', index));
      if (s.def.decay > 0) {
        for (let jj = 0; jj < h; jj++) for (let ii = 0; ii < w; ii++) if (cellAt(placed, ii, jj)?.wall && drng.chance(s.def.decay)) placed.broken.add(jj * w + ii);
      }
      placed.hasCamp = !!s.def.camp && (central || new Rng(deriveSeed(seed, 'campchance', index)).chance(s.def.camp.chance));
      plan.placed.push(placed);
      return placed;
    }
    return null;
  };
  if (!tryPlace(p.start, 20, p.startBiomes, true)) tryPlace(p.start, 20, null, true);
  const roadNodes: number[] = [0];
  for (const entry of p.structures) {
    const n = srng.int(entry.count[0], Math.max(entry.count[0], entry.count[1]));
    for (let k = 0; k < n; k++) {
      // The minimum is a promise (a way into an interior must exist): if the rules leave no room, relax them.
      const q = tryPlace(entry.s, entry.spacing, entry.biomes, false) ?? (k < entry.count[0] ? tryPlace(entry.s, 10, null, false) : null);
      if (q && entry.road) roadNodes.push(q.index);
    }
  }

  // --- Roads: join every place (minimum spanning tree plus a few loops), each link found with A*.
  const entrance = (q: Placed) => {
    for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) if (cellAt(q, i, j)?.entrance) return { x: q.x + i, y: q.y + j };
    return { x: q.x + Math.floor(q.w / 2), y: q.y + q.h };
  };
  const nodes = roadNodes.map((i) => ({ i, ...entrance(plan.placed[i]!) }));
  const links: [number, number][] = [];
  const inTree = new Set([0]);
  while (inTree.size < nodes.length) {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (const a of inTree) {
      for (let b = 0; b < nodes.length; b++) {
        if (inTree.has(b)) continue;
        const d = Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y);
        if (d < bd) {
          bd = d;
          best = [a, b];
        }
      }
    }
    links.push(best!);
    inTree.add(best![1]);
  }
  const has = (a: number, b: number) => links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const extra: [number, number, number][] = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) if (!has(a, b)) extra.push([a, b, Math.hypot(nodes[a]!.x - nodes[b]!.x, nodes[a]!.y - nodes[b]!.y)]);
  }
  extra.sort((x, y) => x[2] - y[2]);
  for (const [a, b] of extra.slice(0, p.roads.extraLinks)) links.push([a, b]);

  const grid = new RoadGrid(plan, terrain, p);
  for (const [a, b] of links) {
    const path = grid.route(nodes[a]!, nodes[b]!);
    if (!path) continue;
    plan.routes.push({ from: nodes[a]!.i, to: nodes[b]!.i, points: path });
    for (let k = 1; k < path.length; k++) plan.roads.push({ ax: path[k - 1]!.x, ay: path[k - 1]!.y, bx: path[k]!.x, by: path[k]!.y, width: p.roads.width });
  }
  for (const s of plan.roads) stampDistance(plan.roadDist, W, H, s, s.width + 4, 0);
  placeAnomalies(plan, p, margin);
  return plan;
}

/** Anomaly fields and strays: on dry land, clear of roads, places and each other. */
function placeAnomalies(plan: Plan, p: Params, margin: number): void {
  const { W, H, terrain } = plan;
  const rng = new Rng(deriveSeed(plan.seed, 'anomalies'));
  const k = (x: number, y: number) => Math.floor(y) * W + Math.floor(x);
  // Keep the area around the arrival point safe.
  const start = plan.placed[0];
  const sx = start ? start.x + start.w / 2 : -1e9;
  const sy = start ? start.y + start.h / 2 : -1e9;
  const open = (x: number, y: number, clearance: number) =>
    Math.hypot(x - sx, y - sy) > 30 &&
    x > margin && y > margin && x < W - margin && y < H - margin &&
    !terrain.isLake(x, y) && plan.riverEdge[k(x, y)]! > clearance && plan.roadDist[k(x, y)]! > clearance + 3 &&
    !plan.placed.some((q) => x > q.x - clearance - 4 && x < q.x + q.w + clearance + 4 && y > q.y - clearance - 4 && y < q.y + q.h + clearance + 4);
  for (const f of p.anomalyFields) {
    const n = rng.int(f.count[0], Math.max(f.count[0], f.count[1]));
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < 120; tries++) {
        const x = rng.range(margin, W - margin);
        const y = rng.range(margin, H - margin);
        if (f.biomes && !f.biomes.has(terrain.biome(x, y).index)) continue;
        if (!open(x, y, f.spread)) continue;
        if (plan.fields.some((o) => Math.hypot(o.x - x, o.y - y) < o.spread + f.spread + 12)) continue;
        const members: { id: string; x: number; y: number; r: number }[] = [];
        const size = rng.int(f.size[0], Math.max(f.size[0], f.size[1]));
        for (let m = 0; m < size * 6 && members.length < size; m++) {
          const def = f.anomalies[rng.int(0, f.anomalies.length - 1)]!;
          const a = rng.range(0, Math.PI * 2);
          const d = members.length ? rng.range(1, f.spread) : 0;
          const mx = x + Math.cos(a) * d;
          const my = y + Math.sin(a) * d;
          if (!open(mx, my, def.radius)) continue;
          // Room to walk between them: no overlapping reaches.
          if (members.some((o) => Math.hypot(o.x - mx, o.y - my) < o.r + def.radius + 1)) continue;
          members.push({ id: def.id, x: mx, y: my, r: def.radius });
        }
        if (!members.length) continue;
        // Artifacts grow inside the anomalies that make them: risky to fetch.
        const artifacts: { id: string; x: number; y: number }[] = [];
        for (let a = 0; a < 2; a++) {
          if (!rng.chance(f.artifacts * (a ? 0.4 : 1))) continue;
          const host = members[rng.int(0, members.length - 1)]!;
          const can = f.growable.filter((d) => d.spawnsIn.includes(host.id));
          if (!can.length) continue;
          let roll = rng.range(0, can.reduce((t, d) => t + d.rarity, 0));
          const pick = can.find((d) => (roll -= d.rarity) <= 0) ?? can[0]!;
          const ang = rng.range(0, Math.PI * 2);
          const dist = rng.range(0.2, 0.7) * host.r;
          artifacts.push({ id: pick.id, x: host.x + Math.cos(ang) * dist, y: host.y + Math.sin(ang) * dist });
        }
        const main = f.anomalies[0]!;
        plan.fields.push({ x, y, spread: f.spread, name: `${main.name} Field`, members: members.map(({ id, x, y }) => ({ id, x, y })), artifacts });
        break;
      }
    }
  }
  if (p.strays) {
    for (let i = 0; i < p.strays.count; i++) {
      const def = p.strays.anomalies[rng.int(0, p.strays.anomalies.length - 1)]!;
      for (let tries = 0; tries < 20; tries++) {
        const x = rng.range(margin, W - margin);
        const y = rng.range(margin, H - margin);
        if (!open(x, y, def.radius + 1)) continue;
        if (plan.fields.some((o) => Math.hypot(o.x - x, o.y - y) < o.spread + 6)) continue;
        plan.strays.push({ id: def.id, x, y });
        break;
      }
    }
  }
}

/** Writes min(distance to segment - offset) into the tiles around it. */
function stampDistance(field: Float32Array, W: number, H: number, s: Segment, reach: number, offset: number): void {
  const x0 = Math.max(0, Math.floor(Math.min(s.ax, s.bx) - reach));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(s.ax, s.bx) + reach));
  const y0 = Math.max(0, Math.floor(Math.min(s.ay, s.by) - reach));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(s.ay, s.by) + reach));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.sqrt(dist2Seg(x + 0.5, y + 0.5, s)) - offset;
      const k = y * W + x;
      if (d < field[k]!) field[k] = d;
    }
  }
}

/** A* over a 2-tile grid: cheap on open ground, dear across water (bridges), never through walls. */
class RoadGrid {
  private readonly C = 2;
  private readonly gw: number;
  private readonly gh: number;
  private cost: Float32Array;

  constructor(plan: Plan, terrain: Terrain, p: Params) {
    const C = this.C;
    this.gw = Math.ceil(plan.W / C);
    this.gh = Math.ceil(plan.H / C);
    this.cost = new Float32Array(this.gw * this.gh);
    const margin = p.border.width + 3;
    for (let gy = 0; gy < this.gh; gy++) {
      for (let gx = 0; gx < this.gw; gx++) {
        const x = gx * C + 1;
        const y = gy * C + 1;
        let c = 1;
        if (x < margin || y < margin || x > plan.W - margin || y > plan.H - margin) c = Infinity;
        else if (terrain.isLake(x, y)) c = 14;
        else if (plan.riverEdge[Math.floor(y) * plan.W + Math.floor(x)]! < 1.5) c = 9;
        else {
          const b = terrain.biome(x, y);
          if (b.rock && fbm2D(deriveSeed(plan.seed, 'rock', b.index), x / b.rock.scale, y / b.rock.scale, 3) > b.rock.threshold) c = 4;
          else if (b.poolThreshold < 1 && fbm2D(deriveSeed(plan.seed, 'pools', b.index), x / 6, y / 6, 3) > b.poolThreshold) c = 2.5;
        }
        this.cost[gy * this.gw + gx] = c;
      }
    }
    // Structures: walls are off limits, floors are passable but discouraged.
    for (const q of plan.placed) {
      for (let j = 0; j < q.h; j++) {
        for (let i = 0; i < q.w; i++) {
          const cell = cellAt(q, i, j);
          if (!cell || cell.tile < 0) continue;
          const k = Math.floor((q.y + j) / C) * this.gw + Math.floor((q.x + i) / C);
          this.cost[k] = cell.wall ? Infinity : Math.max(this.cost[k]!, 3);
        }
      }
    }
  }

  route(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number }[] | null {
    const C = this.C;
    const gw = this.gw;
    const start = Math.floor(a.y / C) * gw + Math.floor(a.x / C);
    const goal = Math.floor(b.y / C) * gw + Math.floor(b.x / C);
    const gx = goal % gw;
    const gy = Math.floor(goal / gw);
    // Float64: a float32 g rounds up on store, so the same path keeps looking "better" and the search never ends.
    const g = new Float64Array(this.cost.length).fill(Infinity);
    const from = new Int32Array(this.cost.length).fill(-1);
    const heap = new MinHeap();
    g[start] = 0;
    heap.push(start, 0);
    const SQ2 = Math.SQRT2;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      const cx = cur % gw;
      const cy = Math.floor(cur / gw);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= this.gh) continue;
          const n = ny * gw + nx;
          const c = this.cost[n]!;
          if (c === Infinity && n !== goal) continue;
          const step = (dx && dy ? SQ2 : 1) * (Number.isFinite(c) ? c : 1);
          const ng = g[cur]! + step;
          if (ng >= g[n]!) continue;
          g[n] = ng;
          from[n] = cur;
          const hx = nx - gx;
          const hy = ny - gy;
          // Weighted heuristic: much faster, and roads needn't be perfectly shortest.
          heap.push(n, ng + Math.sqrt(hx * hx + hy * hy) * 1.6);
        }
      }
    }
    if (from[goal] === -1 && goal !== start) return null;
    const cells: number[] = [];
    for (let k = goal; k !== -1; k = from[k]!) cells.push(k);
    cells.reverse();
    // Every few cells, then two rounds of corner cutting for gentle curves.
    let pts = cells.filter((_, i) => i % 3 === 0 || i === cells.length - 1).map((k) => ({ x: (k % gw) * C + C / 2, y: Math.floor(k / gw) * C + C / 2 }));
    pts[0] = { x: a.x + 0.5, y: a.y + 0.5 };
    pts[pts.length - 1] = { x: b.x + 0.5, y: b.y + 0.5 };
    for (let round = 0; round < 2 && pts.length > 2; round++) {
      const out = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i]!;
        const p1 = pts[i + 1]!;
        if (i > 0) out.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
        if (i < pts.length - 2) out.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
      }
      out.push(pts[pts.length - 1]!);
      pts = out;
    }
    return pts;
  }
}

class MinHeap {
  private items: number[] = [];
  private prio: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, p: number): void {
    const a = this.items;
    const q = this.prio;
    a.push(item);
    q.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent]! <= q[i]!) break;
      [a[i], a[parent]] = [a[parent]!, a[i]!];
      [q[i], q[parent]] = [q[parent]!, q[i]!];
      i = parent;
    }
  }
  pop(): number {
    const a = this.items;
    const q = this.prio;
    const top = a[0]!;
    const lastA = a.pop()!;
    const lastQ = q.pop()!;
    if (a.length) {
      a[0] = lastA;
      q[0] = lastQ;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && q[l]! < q[m]!) m = l;
        if (r < a.length && q[r]! < q[m]!) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m]!, a[i]!];
        [q[i], q[m]] = [q[m]!, q[i]!];
        i = m;
      }
    }
    return top;
  }
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

/** Structures near a chunk (with a margin for the clearings around them). */
function chunkStructures(plan: Plan, x0: number, y0: number, S: number): Placed[] {
  const key = `${x0},${y0}`;
  let f = plan.chunkCache.get(key);
  if (f) return f;
  const pad = 4;
  f = plan.placed.filter((q) => q.x + q.w >= x0 - pad && q.x <= x0 + S + pad && q.y + q.h >= y0 - pad && q.y <= y0 + S + pad);
  if (plan.chunkCache.size > 4096) plan.chunkCache.clear();
  plan.chunkCache.set(key, f);
  return f;
}

// ---- per-tile classification ------------------------------------------------------

function classify(plan: Plan, near: Placed[], gx: number, gy: number): number {
  const terrain = plan.terrain;
  const p = terrain.p;
  const seed = terrain.seed;
  const x = gx + 0.5;
  const y = gy + 0.5;
  if (terrain.borderDepth(gx, gy) < p.border.width) return p.border.tile;

  // Structures win over everything else.
  let clear = false;
  let nearStructure = false;
  for (const q of near) {
    const i = gx - q.x;
    const j = gy - q.y;
    if (i >= -3 && j >= -3 && i < q.w + 3 && j < q.h + 3) nearStructure = true;
    if (i < 0 || j < 0 || i >= q.w || j >= q.h) continue;
    const cell = cellAt(q, i, j);
    if (!cell) continue;
    if (q.broken.has(j * q.w + i)) {
      if (q.s.rubble >= 0) return q.s.rubble;
      clear = true;
      continue;
    }
    if (cell.tile >= 0) return cell.tile;
    if (cell.clear) clear = true;
  }

  // Water under the spot (lakes, rivers, swamp pools), needed for roads (bridges) too.
  const elev = terrain.elevation(x, y);
  let water = -1;
  if (elev < p.water.lakes) water = elev < p.water.lakes - 0.012 ? p.water.deep : p.water.shallow;
  const k = gy * plan.W + gx;
  const river = plan.riverEdge[k]!;
  if (river < 0) water = p.water.deep;
  else if (river < 1.6 && water < 0) water = p.water.shallow;

  // Roads: a bridge over water, asphalt with a ragged gravel shoulder elsewhere.
  const half = p.roads.width / 2;
  const road = plan.roadDist[k]!;
  if (road < half) return water >= 0 ? p.roads.bridge : p.roads.tile;
  if (water >= 0) return water;
  const nearRoad = road < half + 2;
  if (p.roads.shoulder !== null && road < half + 0.9 && (hashInts(seed, gx, gy, 7) & 3) !== 0) return p.roads.shoulder;

  const b = terrain.biome(x, y);
  if (b.poolThreshold < 1 && !clear && !nearRoad && fbm2D(deriveSeed(seed, 'pools', b.index), x / 6, y / 6, 3) > b.poolThreshold) return p.water.shallow;
  if (b.rock && !clear && !nearRoad && !nearStructure && fbm2D(deriveSeed(seed, 'rock', b.index), x / b.rock.scale, y / b.rock.scale, 3) > b.rock.threshold) return b.rock.tile;

  let ground = b.ground;
  b.patches.forEach((pt, i) => {
    if (fbm2D(deriveSeed(seed, 'patch', b.index, i), x / pt.scale, y / pt.scale, 3) > pt.threshold) ground = pt.tile;
  });
  if (clear || nearRoad || nearStructure) return ground;

  // Decorations: an independent roll per tile, denser in groves when clumped.
  const roll = hashInts(seed, gx, gy, 11) / 4294967296;
  if (roll >= b.decorMax) return ground;
  let acc = 0;
  for (let i = 0; i < b.decor.length; i++) {
    const d = b.decor[i]!;
    if (d.on !== null && d.on !== ground) continue;
    const grove = rank(CDF3, fbm2D(deriveSeed(seed, 'grove', b.index, i), x / 13, y / 13, 3));
    acc += Math.min(0.6, d.density * (1 - d.clump + (d.clump * Math.max(0, grove - 0.4)) / GROVE_MEAN));
    if (roll < acc) return d.tile;
  }
  return ground;
}

// ---- the generator ---------------------------------------------------------------

function resolveStructure(def: StructureDef, tiles: TileSet): Structure {
  return { ...resolveDrawing(def, tiles), def, rubble: def.rubble ? tiles.index(def.rubble) : -1 };
}

export const planetGenerator: WorldGenerator<Params> = {
  id: 'planet',
  version: 1,

  parseParams(raw, tiles, content) {
    if (!content) throw new Error('planet generator needs the content registry');
    const r = parseOrThrow(paramsSchema, raw, 'planet params');
    const biomes: Biome[] = r.biomes.map((id, index) => {
      const def = content.get('biome', id);
      return {
        def,
        index,
        ground: tiles.index(def.ground),
        patches: def.patches.map((pt) => ({ tile: tiles.index(pt.tile), threshold: quantile(CDF3, 1 - pt.cover), scale: pt.scale })),
        rock: def.rock ? { tile: tiles.index(def.rock.tile), threshold: quantile(CDF3, 1 - def.rock.cover), scale: def.rock.scale } : null,
        decor: def.decor.map((d) => ({ tile: tiles.index(d.tile), density: d.density, clump: d.clump, on: d.on ? tiles.index(d.on) : null })),
        decorMax: def.decor.reduce((n, d) => n + Math.min(0.6, d.density * (1 - d.clump + (d.clump * 0.6) / GROVE_MEAN)), 0),
        poolThreshold: def.pools > 0 ? quantile(CDF3, 1 - def.pools) : 1,
      };
    });
    const biomeIndex = new Map(biomes.map((b) => [b.def.id, b.index]));
    const structure = (id: string) => resolveStructure(content.get('structure', id), tiles);
    return {
      biomes,
      border: { tile: tiles.index(r.border.tile), width: r.border.width },
      elevationScale: r.elevationScale,
      climateScale: r.climateScale,
      water: { deep: tiles.index(r.water.deep), shallow: tiles.index(r.water.shallow), lakes: r.water.lakes, rivers: r.water.rivers, riverWidth: r.water.riverWidth },
      roads: {
        tile: tiles.index(r.roads.tile),
        shoulder: r.roads.shoulder ? tiles.index(r.roads.shoulder) : null,
        bridge: tiles.index(r.roads.bridge),
        width: r.roads.width,
        extraLinks: r.roads.extraLinks,
      },
      start: structure(r.start),
      startBiomes: r.startBiomes ? new Set(r.startBiomes.map((b) => biomeIndex.get(b) ?? -1)) : null,
      structures: r.structures.map((e) => {
        if (e.biomes) for (const b of e.biomes) if (!biomeIndex.has(b)) throw new Error(`planet params: structure "${e.id}" lists biome "${b}", which this planet doesn't use`);
        return {
          s: structure(e.id),
          count: e.count,
          spacing: e.spacing,
          biomes: e.biomes ? new Set(e.biomes.map((b) => biomeIndex.get(b)!)) : null,
          road: e.road,
        };
      }),
      patrols: r.patrols,
      crates: r.crates ?? null,
      anomalyFields: (r.anomalies?.fields ?? []).map((f) => {
        const anomalies = f.anomalies.map((id) => content.get('anomaly', id));
        const ids = new Set(f.anomalies);
        return {
          anomalies,
          count: f.count,
          size: f.size,
          spread: f.spread,
          biomes: f.biomes ? new Set(f.biomes.map((b) => biomeIndex.get(b) ?? -1)) : null,
          artifacts: f.artifacts,
          growable: content.all('artifact').filter((a) => a.spawnsIn.some((s) => ids.has(s))),
        };
      }),
      strays: r.anomalies?.stray ? { anomalies: r.anomalies.stray.anomalies.map((id) => content.get('anomaly', id)), count: r.anomalies.stray.count } : null,
      plans: new Map(),
    };
  },

  generateChunk(ctx, out) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H, params, seed } = ctx;
    const plan = planFor(params, seed, W, H);
    const near = chunkStructures(plan, cx * S, cy * S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[y * S + x] = classify(plan, near, cx * S + x, cy * S + y);
  },

  objects(ctx, tiles) {
    const { chunkSize: S, cx, cy, widthTiles: W, heightTiles: H, params, seed } = ctx;
    const plan = planFor(params, seed, W, H);
    const out: WorldObjectSpawn[] = [];
    const x0 = cx * S;
    const y0 = cy * S;
    const inChunk = (gx: number, gy: number) => gx >= x0 && gy >= y0 && gx < x0 + S && gy < y0 + S;
    for (const q of chunkStructures(plan, x0, y0, S)) {
      for (let j = 0; j < q.h; j++) {
        for (let i = 0; i < q.w; i++) {
          const cell = cellAt(q, i, j);
          if (!cell || !inChunk(q.x + i, q.y + j)) continue;
          if (cell.anomaly) out.push({ id: `anomaly:${q.s.def.id}:${q.index}:${i},${j}`, kind: 'anomaly', x: (q.x + i + 0.5) * T, y: (q.y + j + 0.5) * T, anomaly: cell.anomaly });
          if (!cell.crate) continue;
          out.push({ id: `crate:${q.s.def.id}:${q.index}:${i},${j}`, kind: 'crate', x: (q.x + i + 0.5) * T, y: (q.y + j + 0.8) * T, variant: cell.crate.variant, lootTable: cell.crate.lootTable });
        }
      }
    }
    // Anomalies and the artifacts they grew (skipping any that ended up on a tree or rock).
    const local = (x: number, y: number) => {
      const gx = Math.floor(x);
      const gy = Math.floor(y);
      return inChunk(gx, gy) && !ctx.tiles.solid[tiles[(gy - y0) * S + (gx - x0)]!];
    };
    plan.fields.forEach((f, fi) => {
      f.members.forEach((m, mi) => {
        if (local(m.x, m.y)) out.push({ id: `anomaly:${fi}:${mi}`, kind: 'anomaly', x: m.x * T, y: m.y * T, anomaly: m.id });
      });
      f.artifacts.forEach((a, ai) => {
        if (local(a.x, a.y)) out.push({ id: `artifact:${fi}:${ai}`, kind: 'artifact', x: a.x * T, y: a.y * T, artifact: a.id });
      });
    });
    plan.strays.forEach((m, i) => {
      if (local(m.x, m.y)) out.push({ id: `anomaly:stray:${i}`, kind: 'anomaly', x: m.x * T, y: m.y * T, anomaly: m.id });
    });
    // A few crates out in the wild, on open ground away from places.
    if (params.crates) {
      const rng = new Rng(deriveSeed(seed, 'crates', cx, cy));
      if (rng.chance(params.crates.chance)) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const lx = rng.int(1, S - 2);
          const ly = rng.int(1, S - 2);
          const t = tiles[ly * S + lx]!;
          if (ctx.tiles.solid[t] || ctx.tiles.solid[tiles[(ly - 1) * S + lx]!] || ctx.tiles.defs[t]!.speed < 1 || ctx.tiles.defs[t]!.prop) continue;
          const gx = x0 + lx;
          const gy = y0 + ly;
          if (plan.placed.some((q) => gx >= q.x - 2 && gy >= q.y - 2 && gx < q.x + q.w + 2 && gy < q.y + q.h + 2)) continue;
          out.push({ id: `crate:${cx},${cy}:0`, kind: 'crate', x: (gx + 0.5) * T, y: (gy + 0.8) * T, variant: 'supply', lootTable: params.crates.lootTable });
          break;
        }
      }
    }
    return out;
  },

  population(seed, params, W, H, walkable) {
    const plan = planFor(params, seed, W, H);
    const camps: CampSpawn[] = [];
    for (const q of plan.placed) {
      const c = q.s.def.camp;
      if (!c || !q.hasCamp) continue;
      let home = { x: q.x + q.w / 2, y: q.y + q.h / 2 };
      for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) if (cellAt(q, i, j)?.camp) home = { x: q.x + i + 0.5, y: q.y + j + 0.5 };
      camps.push({ id: `${q.s.def.id}_${q.index}`, faction: c.faction, templates: c.templates, behavior: c.behavior, x: home.x * T, y: home.y * T, radius: c.radius * T, waypoints: [] });
    }
    // Patrols walk a road between two places and back.
    const rng = new Rng(deriveSeed(seed, 'patrols'));
    for (const pat of params.patrols) {
      for (let k = 0; k < pat.count && plan.routes.length; k++) {
        const route = plan.routes[rng.int(0, plan.routes.length - 1)]!;
        const pts = route.points.filter((_, i) => i % 6 === 0).filter((pt) => walkable(Math.floor(pt.x), Math.floor(pt.y)));
        if (pts.length < 2) continue;
        const waypoints = [...pts, ...pts.slice(1, -1).reverse()].map((pt) => ({ x: pt.x * T, y: pt.y * T }));
        camps.push({ id: `${pat.id}_${k}`, faction: pat.faction, templates: pat.templates, behavior: 'patrol', x: waypoints[0]!.x, y: waypoints[0]!.y, radius: 3 * T, waypoints });
      }
    }
    return camps;
  },

  spawnPoint(seed, params, W, H) {
    const plan = planFor(params, seed, W, H);
    const start = plan.placed[0];
    if (!start) return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
    for (let j = 0; j < start.h; j++) for (let i = 0; i < start.w; i++) if (cellAt(start, i, j)?.spawn) return { x: start.x + i, y: start.y + j };
    return { x: start.x + Math.floor(start.w / 2), y: start.y + start.h };
  },

  /** Ways into other worlds drawn into places (a bunker hatch, a wreck's door). */
  portals(seed, params, W, H): PortalSpawn[] {
    const plan = planFor(params, seed, W, H);
    const out: PortalSpawn[] = [];
    for (const q of plan.placed) {
      for (let j = 0; j < q.h; j++) {
        for (let i = 0; i < q.w; i++) {
          const p = cellAt(q, i, j)?.portal;
          if (p) out.push({ id: `portal:${q.s.def.id}:${q.index}:${i},${j}`, x: (q.x + i + 0.5) * T, y: (q.y + j + 0.5) * T, world: p.world, label: p.label });
        }
      }
    }
    return out;
  },

  landmarks(seed, params, W, H): Landmark[] {
    const plan = planFor(params, seed, W, H);
    return [
      ...plan.placed.filter((q) => q.s.def.label).map((q) => ({ id: `${q.s.def.id}_${q.index}`, name: q.s.def.label!, x: q.x + q.w / 2, y: q.y + q.h / 2, w: q.w, h: q.h })),
      ...plan.fields.map((f, i) => ({ id: `field_${i}`, name: f.name, x: f.x, y: f.y, w: f.spread * 2, h: f.spread * 2, hazard: true })),
    ];
  },

  biomeAt(seed, params, W, H, tx, ty) {
    return planFor(params, seed, W, H).terrain.biome(tx + 0.5, ty + 0.5).def;
  },
};

registerGenerator(planetGenerator);

/** For tests and tools: the large-scale layout of a planet. */
export function planetPlan(params: unknown, seed: number, W: number, H: number): Readonly<Plan> {
  return planFor(params as Params, seed, W, H);
}
