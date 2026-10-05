import { clampLength, type Vec2 } from '../core/math';
import type { ButtonAction, InputSource, SourceState } from './actions';
import { DEFAULT_GAMEPAD, type GamepadBindings } from './bindings';

/** Radial deadzone, rescaled so output still covers the full 0..1 range. */
export function applyDeadzone(v: Vec2, deadzone: number): Vec2 {
  const len = Math.hypot(v.x, v.y);
  if (len < deadzone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (len - deadzone) / (1 - deadzone));
  return clampLength({ x: (v.x / len) * scaled, y: (v.y / len) * scaled }, 1);
}

export class GamepadSource implements InputSource {
  readonly device = 'gamepad' as const;
  lastActivity = 0;

  constructor(private bindings: GamepadBindings = DEFAULT_GAMEPAD) {}

  poll(): SourceState {
    const pad = this.activePad();
    const state: SourceState = { move: { x: 0, y: 0 }, aim: { kind: 'none' }, buttons: new Set() };
    if (!pad) return state;
    const b = this.bindings;
    const axis = (i: number) => pad.axes[i] ?? 0;

    state.move = applyDeadzone({ x: axis(b.moveAxes[0]), y: axis(b.moveAxes[1]) }, b.deadzone);
    const aim = applyDeadzone({ x: axis(b.aimAxes[0]), y: axis(b.aimAxes[1]) }, b.deadzone);
    if (aim.x !== 0 || aim.y !== 0) state.aim = { kind: 'direction', dir: aim };

    for (const [action, indices] of Object.entries(b.buttons) as [ButtonAction, number[]][]) {
      if (indices.some((i) => pad.buttons[i]?.pressed)) state.buttons.add(action);
    }
    if (state.buttons.size || state.move.x || state.move.y || state.aim.kind !== 'none') {
      this.lastActivity = performance.now();
    }
    return state;
  }

  reset(): void {}
  dispose(): void {}

  private activePad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) if (p && p.connected) return p;
    return null;
  }
}
