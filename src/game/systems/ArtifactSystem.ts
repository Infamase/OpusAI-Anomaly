import type { ContentRegistry } from '../../content/Registry';
import type { System, World } from '../../ecs/World';
import { Equipment, Health, Stats } from '../components';
import { BELT_SLOTS } from '../equipment';
import { addRadiation } from '../radiation';

/** What worn artifacts do over time: radiate (or draw radiation out) and heal (or hurt). Stat bonuses are modifiers. */
export class ArtifactSystem implements System {
  readonly name = 'artifacts';

  constructor(private content: ContentRegistry) {}

  update(world: World, dt: number): void {
    for (const e of world.query(Equipment, Health)) {
      const h = world.req(e, Health);
      if (h.dead) continue;
      const eq = world.req(e, Equipment);
      for (const slot of BELT_SLOTS) {
        const item = eq[slot];
        const def = item && this.content.tryGet('artifact', item.defId);
        if (!def) continue;
        if (def.radiation) addRadiation(world, e, def.radiation * dt);
        if (def.regen) {
          const max = world.get(e, Stats)?.get('max_health') ?? 100;
          h.hp = Math.min(max, h.hp + def.regen * dt);
        }
      }
    }
  }
}
