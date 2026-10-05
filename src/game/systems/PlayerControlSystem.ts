import { length, normalize, toDirection } from '../../core/math';
import type { System, World } from '../../ecs/World';
import type { Camera } from '../../render/Camera';
import type { InputManager } from '../../input/InputManager';
import { Aim, Character, PlayerControlled, Stats, Transform, Velocity } from '../components';

/** Turns input actions into the player's velocity, facing and aim. */
export class PlayerControlSystem implements System {
  readonly name = 'playerControl';

  constructor(
    private input: InputManager,
    private camera: Camera,
    /** Converts CSS pixels (pointer events) to device pixels (camera space). */
    private pixelRatio: () => number,
  ) {}

  update(world: World): void {
    for (const e of world.query(PlayerControlled, Transform, Velocity, Character, Stats, Aim)) {
      const t = world.req(e, Transform);
      const vel = world.req(e, Velocity);
      const ch = world.req(e, Character);
      const stats = world.req(e, Stats);
      const aim = world.req(e, Aim);

      const move = this.input.move;
      ch.sprinting = this.input.isDown('sprint') && length(move) > 0.1;
      const speed = stats.get('move_speed') * (ch.sprinting ? stats.get('sprint_multiplier') : 1);
      vel.x = move.x * speed;
      vel.y = move.y * speed;

      // Aim: mouse points at a spot, sticks give a direction.
      const a = this.input.aim;
      if (a.kind === 'point') {
        const pr = this.pixelRatio();
        const target = this.camera.screenToWorld(a.screen.x * pr, a.screen.y * pr);
        // Aim from roughly chest height so pointing at the character's own head doesn't flip facing.
        aim.dir = normalize({ x: target.x - t.x, y: target.y - (t.y - 16) });
      } else if (a.kind === 'direction') {
        aim.dir = normalize(a.dir);
      } else {
        aim.dir = null;
      }

      // Face where you aim; otherwise face where you walk.
      const faceVec = aim.dir ?? (length(move) > 0.1 ? move : null);
      if (faceVec) ch.facing = toDirection(faceVec, ch.facing);
    }
  }
}
