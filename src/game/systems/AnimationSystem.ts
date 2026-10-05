import type { System, World } from '../../ecs/World';
import { Character, Velocity } from '../components';

/** Picks each character's animation from what it's doing and advances its clock. */
export class AnimationSystem implements System {
  readonly name = 'animation';

  update(world: World, dt: number): void {
    for (const e of world.query(Character, Velocity)) {
      const ch = world.req(e, Character);
      const v = world.req(e, Velocity);
      const next = Math.hypot(v.x, v.y) > 1 ? 'walk' : 'idle';
      if (next !== ch.anim) {
        ch.anim = next;
        ch.animTime = 0;
      }
      // Sprinting plays the walk cycle faster until a dedicated run animation exists.
      ch.animTime += dt * (ch.sprinting ? 1.5 : 1);
    }
  }
}
