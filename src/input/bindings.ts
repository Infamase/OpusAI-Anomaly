import type { ButtonAction } from './actions';

/**
 * Default bindings. Keyboard uses KeyboardEvent.code (physical key position), so
 * WASD stays WASD on AZERTY and other layouts. These tables are what a future
 * "remap controls" screen will edit and store in settings.
 */
export interface KeyboardBindings {
  up: string[];
  down: string[];
  left: string[];
  right: string[];
  buttons: Partial<Record<ButtonAction, string[]>>;
  /** Mouse button index -> action. 0 = left, 1 = middle, 2 = right. */
  mouse: Partial<Record<number, ButtonAction>>;
}

export const DEFAULT_KEYBOARD: KeyboardBindings = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  buttons: {
    reload: ['KeyR'],
    interact: ['KeyE'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    inventory: ['Tab', 'KeyI'],
    pause: ['Escape'],
    debugToggle: ['Backquote', 'F3'],
    fire: ['Space'],
    weapon1: ['Digit1'],
    weapon2: ['Digit2'],
    // "Wheel" is a virtual code for any mouse-wheel step.
    swapWeapon: ['KeyQ', 'Wheel'],
  },
  mouse: { 0: 'fire', 2: 'altFire' },
};

/** Standard Gamepad mapping (https://w3c.github.io/gamepad/#remapping). */
export interface GamepadBindings {
  moveAxes: [number, number];
  aimAxes: [number, number];
  deadzone: number;
  buttons: Partial<Record<ButtonAction, number[]>>;
}

export const DEFAULT_GAMEPAD: GamepadBindings = {
  moveAxes: [0, 1],
  aimAxes: [2, 3],
  deadzone: 0.2,
  buttons: {
    fire: [7], // RT
    altFire: [6], // LT
    reload: [2], // X / Square
    interact: [0], // A / Cross
    sprint: [10], // L3
    inventory: [3], // Y / Triangle
    pause: [9], // Start
    debugToggle: [8], // Select / Back
    swapWeapon: [5], // RB
  },
};
