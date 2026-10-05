import { length, normalize, toDirection } from '../../core/math';
import type { System, World } from '../../ecs/World';
import type { Camera } from '../../render/Camera';
import type { InputManager } from '../../input/InputManager';
import { CHEST_HEIGHT } from '../combat';
import { Aim, Character, Combatant, Encumbrance, Health, PlayerControlled, Stamina, Stats, Transform, Velocity } from '../components';

/** Turns input actions into the player's movement, aim and weapon intents. */
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
      const combat = world.get(e, Combatant);
      if (world.get(e, Health)?.dead) {
        vel.x = vel.y = 0;
        ch.sprinting = false;
        continue;
      }

      const move = this.input.move;
      const firing = this.input.isDown('fire');
      const stamina = world.get(e, Stamina);
      // Sprinting lowers the gun: holding fire cancels it, and it costs stamina.
      const overloaded = (world.get(e, Encumbrance)?.level ?? 0) > 0;
      ch.sprinting = this.input.isDown('sprint') && length(move) > 0.1 && !firing && !(stamina?.exhausted ?? false) && !overloaded;
      const speed = stats.get('move_speed') * (ch.sprinting ? stats.get('sprint_multiplier') : 1);
      vel.x = move.x * speed;
      vel.y = move.y * speed;

      // Aim: mouse points at a spot, sticks give a direction.
      const a = this.input.aim;
      if (a.kind === 'point') {
        const pr = this.pixelRatio();
        const target = this.camera.screenToWorld(a.screen.x * pr, a.screen.y * pr);
        // Aim from chest height so pointing at the character's own head doesn't flip facing.
        aim.dir = normalize({ x: target.x - t.x, y: target.y - (t.y - CHEST_HEIGHT) });
      } else if (a.kind === 'direction') {
        aim.dir = normalize(a.dir);
      } else {
        aim.dir = null;
      }

      // Face where you aim; otherwise face where you walk.
      const faceVec = aim.dir ?? (length(move) > 0.1 ? move : null);
      if (faceVec) ch.facing = toDirection(faceVec, ch.facing);

      if (combat) {
        combat.trigger = firing && !ch.sprinting && aim.dir !== null;
        if (this.input.justPressed('reload')) combat.wantReload = true;
        if (this.input.justPressed('weapon1')) combat.wantSwitch = 'primary';
        else if (this.input.justPressed('weapon2')) combat.wantSwitch = 'sidearm';
        else if (this.input.justPressed('swapWeapon')) combat.wantSwitch = 'next';
      }
    }
  }
}
