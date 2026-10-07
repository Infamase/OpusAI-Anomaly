import type { Entity, System, World } from '../ecs/World';
import type { EventBus } from '../core/EventBus';
import type { CombatEvents } from './combatEvents';
import { Character, Collider, Health, Npc, Transform, Velocity } from './components';
import { TILE_PX, type TileMap } from './world/TileMap';

/** What using a door did. */
export type DoorResult = 'opened' | 'closed' | 'unlocked' | 'locked' | 'blocked';

/** The door at a tile, if that tile is one. */
export function doorAt(map: TileMap, tx: number, ty: number) {
  return map.tiles.defs[map.getTile(tx, ty)]!.door;
}

/** True if any character stands in the tile (a door can't close on someone). */
export function tileOccupied(world: World, tx: number, ty: number): boolean {
  const x0 = tx * TILE_PX;
  const y0 = ty * TILE_PX;
  for (const e of world.query(Character, Transform)) {
    const t = world.req(e, Transform);
    const half = (world.get(e, Collider)?.w ?? 12) / 2;
    const h = world.get(e, Collider)?.h ?? 8;
    if (t.x + half > x0 && t.x - half < x0 + TILE_PX && t.y > y0 && t.y - h < y0 + TILE_PX) return true;
  }
  return false;
}

/**
 * Uses the door at (tx, ty): opens or closes it. A locked door opens only for
 * someone carrying its keycard (and stays unlocked from then on).
 */
export function useDoor(world: World, map: TileMap, tx: number, ty: number, hasItem: (id: string) => boolean): DoorResult | null {
  const tile = map.getTile(tx, ty);
  const door = map.tiles.defs[tile]!.door;
  if (!door) return null;
  const closed = map.tiles.solid[tile] === 1;
  if (!closed && tileOccupied(world, tx, ty)) return 'blocked';
  if (door.key && !hasItem(door.key)) return 'locked';
  map.setTile(tx, ty, door.toggle);
  return door.key ? 'unlocked' : closed ? 'opened' : 'closed';
}

/**
 * NPCs open unlocked doors in their way: if the spot just ahead of a walking
 * NPC is a closed door they could open, it opens. (Paths already lead through
 * such doors; see pathfinding.)
 */
export class DoorSystem implements System {
  readonly name = 'doors';

  constructor(
    private map: () => TileMap | null,
    private events?: EventBus<CombatEvents>,
  ) {}

  update(world: World, _dt: number): void {
    const map = this.map();
    if (!map) return;
    for (const e of world.query(Npc, Transform, Velocity)) {
      if (world.get(e, Health)?.dead) continue;
      const v = world.req(e, Velocity);
      const speed = Math.hypot(v.x, v.y);
      if (speed < 1) continue;
      const t = world.req(e, Transform);
      const tx = Math.floor((t.x + (v.x / speed) * 18) / TILE_PX);
      const ty = Math.floor((t.y - 4 + (v.y / speed) * 18) / TILE_PX);
      if (!map.isOpenableDoor(tx, ty)) continue;
      const tileId = map.tiles.id(map.getTile(tx, ty));
      if (useDoor(world, map, tx, ty, () => false) === 'opened') this.emit(e, tx, ty, tileId);
    }
  }

  private emit(by: Entity, tx: number, ty: number, tile: string): void {
    this.events?.emit('door', { by, tx, ty, x: (tx + 0.5) * TILE_PX, y: (ty + 0.5) * TILE_PX, tile, result: 'opened' });
  }
}
