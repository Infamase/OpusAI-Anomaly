import type { Vec2 } from '../core/math';

/**
 * Game code never asks "is W pressed?" — it asks "is the player moving / firing?".
 * Each device translates its raw input into these actions, so keyboard/mouse
 * and gamepad drive the exact same gameplay code.
 */
export const BUTTON_ACTIONS = [
  'fire',
  'altFire',
  'reload',
  'interact',
  'sprint',
  'inventory',
  'pause',
  'debugToggle',
  'weapon1',
  'weapon2',
  'swapWeapon',
  'quickHeal',
  'map',
  'bolt',
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

export type InputDevice = 'keyboardMouse' | 'gamepad';

/** Mouse aims at a point on screen; sticks aim in a direction; idle sticks don't aim. */
export type AimInput =
  | { kind: 'point'; screen: Vec2 }
  | { kind: 'direction'; dir: Vec2 }
  | { kind: 'none' };

/** What one device reports when polled. */
export interface SourceState {
  /** Movement intent, length 0..1. */
  move: Vec2;
  aim: AimInput;
  /** Buttons held now, plus any pressed and released since the last poll (so quick taps are never lost). */
  buttons: Set<ButtonAction>;
}

export interface InputSource {
  readonly device: InputDevice;
  /** performance.now() of the last real user activity on this device. */
  readonly lastActivity: number;
  poll(): SourceState;
  /** Forget held state (e.g. when the window loses focus). */
  reset(): void;
  dispose(): void;
}

export const emptySourceState = (): SourceState => ({ move: { x: 0, y: 0 }, aim: { kind: 'none' }, buttons: new Set() });
