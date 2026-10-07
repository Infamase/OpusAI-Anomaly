import type { System, World } from '../../ecs/World';
import { TILE_PX, type TileMap } from '../world/TileMap';
import { Collider, Transform, Velocity } from '../components';

/**
 * Moves entities and resolves collisions against solid tiles. X and Y are
 * resolved separately, which makes characters slide along walls instead of
 * sticking to them.
 */
export class MovementSystem implements System {
  readonly name = 'movement';

  constructor(private map: () => TileMap | null) {}

  update(world: World, dt: number): void {
    const map = this.map();
    for (const e of world.query(Transform, Velocity)) {
      const t = world.req(e, Transform);
      const v = world.req(e, Velocity);
      t.prevX = t.x;
      t.prevY = t.y;
      const col = world.get(e, Collider);
      if (!map || !col) {
        t.x += v.x * dt;
        t.y += v.y * dt;
        continue;
      }
      // Mud and shallows slow you down (controls set velocity afresh every tick).
      const k = map.speedAt(t.x, t.y);
      v.x *= k;
      v.y *= k;
      t.x = moveAxis(map, t.x, t.y, v.x * dt, col, 'x');
      t.y = moveAxis(map, t.x, t.y, v.y * dt, col, 'y');
    }
  }
}

const EPS = 0.001;

/**
 * Moves along one axis, stopping flush against the nearest solid tile in the way.
 * Only tiles the box newly enters are tested, so an entity overlapping a wall
 * (e.g. one was built on top of it) can still walk out.
 */
export function moveAxis(map: TileMap, x: number, y: number, delta: number, col: Collider, axis: 'x' | 'y'): number {
  if (delta === 0) return axis === 'x' ? x : y;
  const T = TILE_PX;
  // Box: [x - w/2, x + w/2] by [y - h, y]
  const half = col.w / 2;
  const rowsOrCols = (lo: number, hi: number) => [Math.floor(lo / T), Math.floor((hi - EPS) / T)] as const;

  if (axis === 'x') {
    const [ty0, ty1] = rowsOrCols(y - col.h, y);
    const blocked = (tx: number) => {
      for (let ty = ty0; ty <= ty1; ty++) if (map.isSolid(tx, ty)) return true;
      return false;
    };
    if (delta > 0) {
      const from = Math.floor((x + half - EPS) / T) + 1;
      const to = Math.floor((x + delta + half - EPS) / T);
      for (let tx = from; tx <= to; tx++) if (blocked(tx)) return tx * T - half - EPS;
    } else {
      const from = Math.floor((x - half) / T) - 1;
      const to = Math.floor((x + delta - half) / T);
      for (let tx = from; tx >= to; tx--) if (blocked(tx)) return (tx + 1) * T + half + EPS;
    }
    return x + delta;
  }

  const [tx0, tx1] = rowsOrCols(x - half, x + half);
  const blocked = (ty: number) => {
    for (let tx = tx0; tx <= tx1; tx++) if (map.isSolid(tx, ty)) return true;
    return false;
  };
  if (delta > 0) {
    const from = Math.floor((y - EPS) / T) + 1;
    const to = Math.floor((y + delta - EPS) / T);
    for (let ty = from; ty <= to; ty++) if (blocked(ty)) return ty * T - EPS;
  } else {
    const from = Math.floor((y - col.h) / T) - 1;
    const to = Math.floor((y + delta - col.h) / T);
    for (let ty = from; ty >= to; ty--) if (blocked(ty)) return (ty + 1) * T + col.h + EPS;
  }
  return y + delta;
}
