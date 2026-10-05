import type { ContentRegistry } from '../../content/Registry';
import type { System, World } from '../../ecs/World';
import { Encumbrance, Equipment, Inventory, Stats } from '../components';
import { inventoryWeight } from '../items';

const SOURCE = 'encumbrance';
/** Above the carry limit you slow down and can't sprint; far above it you barely move. */
export const OVERLOAD_SPEED = 0.7;
export const HEAVY_FACTOR = 1.4;
export const HEAVY_SPEED = 0.25;

/** Recomputes carried weight (inventory + worn gear) and applies the speed penalty. */
export class EncumbranceSystem implements System {
  readonly name = 'encumbrance';
  private timer = 0;

  constructor(private content: ContentRegistry) {}

  update(world: World, dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.2;
    for (const e of world.query(Encumbrance, Inventory, Stats)) refreshEncumbrance(world, this.content, e);
  }
}

export function refreshEncumbrance(world: World, content: ContentRegistry, e: number): void {
  const enc = world.req(e, Encumbrance);
  const stats = world.req(e, Stats);
  const worn = Object.values(world.get(e, Equipment) ?? {}).filter((x) => x !== undefined);
  enc.weight = inventoryWeight(content, [...world.req(e, Inventory), ...worn]);
  enc.limit = stats.get('carry_weight');
  const level = enc.weight > enc.limit * HEAVY_FACTOR ? 2 : enc.weight > enc.limit ? 1 : 0;
  if (level === enc.level && stats.modifiersFor('move_speed').some((m) => m.source === SOURCE) === level > 0) return;
  enc.level = level;
  stats.removeSource(SOURCE);
  if (level > 0) stats.addModifier({ stat: 'move_speed', op: 'mult', value: level === 2 ? HEAVY_SPEED : OVERLOAD_SPEED, source: SOURCE });
}
