import { length, type Vec2 } from '../core/math';
import { BUTTON_ACTIONS, type AimInput, type ButtonAction, type InputDevice, type InputSource } from './actions';

/**
 * Merges every input source into one per-tick snapshot.
 *
 * Call update() once per fixed simulation step. Movement comes from whichever
 * source is pushing hardest, buttons from all sources, and aim from the most
 * recently used device. `device` tracks the last-used device so the UI can show
 * touch controls or keyboard prompts as appropriate.
 */
export class InputManager {
  move: Vec2 = { x: 0, y: 0 };
  aim: AimInput = { kind: 'none' };
  device: InputDevice;
  onDeviceChange: ((d: InputDevice) => void) | null = null;

  private down = new Set<ButtonAction>();
  private prev = new Set<ButtonAction>();
  /** Lets UI or scripted sequences block gameplay input (e.g. while a menu is open). */
  enabled = true;

  constructor(
    readonly sources: InputSource[],
    initialDevice: InputDevice = 'keyboardMouse',
  ) {
    this.device = initialDevice;
  }

  update(): void {
    let bestMove: Vec2 = { x: 0, y: 0 };
    let active = this.sources[0];
    const nextDown = new Set<ButtonAction>();
    const states = this.sources.map((s) => {
      const st = s.poll();
      if (length(st.move) > length(bestMove)) bestMove = st.move;
      for (const b of st.buttons) nextDown.add(b);
      if (!active || s.lastActivity > active.lastActivity) active = s;
      return st;
    });

    if (active && active.lastActivity > 0 && active.device !== this.device) {
      this.device = active.device;
      this.onDeviceChange?.(this.device);
    }
    const activeIdx = active ? this.sources.indexOf(active) : -1;

    this.prev = this.down;
    if (this.enabled) {
      this.move = bestMove;
      this.aim = activeIdx >= 0 ? states[activeIdx]!.aim : { kind: 'none' };
      this.down = nextDown;
    } else {
      this.move = { x: 0, y: 0 };
      this.aim = { kind: 'none' };
      // Keep menu/system buttons alive so a paused game can be unpaused.
      this.down = new Set([...nextDown].filter((b) => b === 'pause' || b === 'debugToggle'));
    }
  }

  isDown(action: ButtonAction): boolean {
    return this.down.has(action);
  }

  justPressed(action: ButtonAction): boolean {
    return this.down.has(action) && !this.prev.has(action);
  }

  justReleased(action: ButtonAction): boolean {
    return !this.down.has(action) && this.prev.has(action);
  }

  /** Debug view of currently held actions. */
  get held(): ButtonAction[] {
    return BUTTON_ACTIONS.filter((a) => this.down.has(a));
  }

  reset(): void {
    for (const s of this.sources) s.reset();
    this.down.clear();
    this.prev.clear();
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
  }
}
