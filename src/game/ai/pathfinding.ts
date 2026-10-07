import { segmentHitsSolid } from '../combat';
import { TILE_PX, type TileMap } from '../world/TileMap';

export interface Point {
  x: number;
  y: number;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= this.keys[i]!) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0]!;
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.items.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** Nearest walkable tile to (tx, ty) within a few tiles, or null. */
export function nearestWalkable(map: TileMap, tx: number, ty: number, maxRing = 4): Point | null {
  if (!map.isSolid(tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= maxRing; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!map.isSolid(tx + dx, ty + dy)) return { x: tx + dx, y: ty + dy };
      }
    }
  }
  return null;
}

/**
 * A* over the tile grid (8 directions, no cutting corners past walls), from
 * and to world positions. Returns world-space waypoints (smoothed), or null if
 * the goal can't be reached within `maxNodes` expansions — the search is
 * bounded so a hopeless request never stalls a frame.
 */
export function findPath(map: TileMap, from: Point, to: Point, maxNodes = 3000, avoid?: Avoid): Point[] | null {
  const T = TILE_PX;
  const start = nearestWalkable(map, Math.floor(from.x / T), Math.floor(from.y / T));
  const goal = nearestWalkable(map, Math.floor(to.x / T), Math.floor(to.y / T));
  if (!start || !goal) return null;
  if (start.x === goal.x && start.y === goal.y) return [{ x: to.x, y: to.y }];

  const key = (x: number, y: number) => (y + 32768) * 65536 + (x + 32768);
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - goal.x);
    const dy = Math.abs(y - goal.y);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  const sk = key(start.x, start.y);
  g.set(sk, 0);
  open.push(sk, h(start.x, start.y));
  let expanded = 0;
  const goalKey = key(goal.x, goal.y);

  while (open.size && expanded < maxNodes) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    if (cur === goalKey) return smooth(map, reconstruct(came, cur, key), from, to, avoid);
    closed.add(cur);
    expanded++;
    const cx = (cur % 65536) - 32768;
    const cy = Math.floor(cur / 65536) - 32768;
    const cg = g.get(cur)!;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (map.isSolid(nx, ny)) continue;
      // No squeezing diagonally between two walls.
      if (dx && dy && (map.isSolid(cx + dx, cy) || map.isSolid(cx, cy + dy))) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      // Hazards are very expensive rather than forbidden, so someone standing in one can still path out.
      const ng = cg + cost + (avoid?.(nx, ny) ? 25 : 0);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, cur);
        open.push(nk, ng + h(nx, ny));
      }
    }
  }
  return null;
}

function reconstruct(came: Map<number, number>, end: number, _key: (x: number, y: number) => number): Point[] {
  const out: Point[] = [];
  let k: number | undefined = end;
  while (k !== undefined) {
    out.push({ x: (k % 65536) - 32768, y: Math.floor(k / 65536) - 32768 });
    k = came.get(k);
  }
  return out.reverse();
}

/** Tiles to stay out of (anomalies). Paths go around them; a straight shortcut never crosses one. */
export type Avoid = (tx: number, ty: number) => boolean;

/** True if a character (about 12px wide) can walk straight from a to b. */
export function walkableLine(map: TileMap, a: Point, b: Point, halfWidth = 6, avoid?: Avoid): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  for (const s of [-1, 0, 1]) {
    if (segmentHitsSolid(map, a.x + nx * s, a.y - 4 + ny * s, b.x + nx * s, b.y - 4 + ny * s, 'walk') !== null) return false;
  }
  if (avoid) {
    // Sample along the line, a step per half tile.
    const steps = Math.ceil(len / (TILE_PX / 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (avoid(Math.floor((a.x + dx * t) / TILE_PX), Math.floor((a.y + dy * t) / TILE_PX))) return false;
    }
  }
  return true;
}

/** Tile path → world points, dropping waypoints that can be skipped in a straight line. */
function smooth(map: TileMap, tiles: Point[], from: Point, to: Point, avoid?: Avoid): Point[] {
  const T = TILE_PX;
  const pts = tiles.map((t) => ({ x: (t.x + 0.5) * T, y: (t.y + 0.5) * T }));
  pts[pts.length - 1] = map.isSolid(Math.floor(to.x / T), Math.floor(to.y / T)) ? pts[pts.length - 1]! : { x: to.x, y: to.y };
  const out: Point[] = [];
  let anchor = from;
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !walkableLine(map, anchor, pts[j]!, 6, avoid)) j--;
    out.push(pts[j]!);
    anchor = pts[j]!;
    i = j + 1;
  }
  return out;
}
