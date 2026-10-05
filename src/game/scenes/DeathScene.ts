import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';
import { button, el } from '../../ui/dom';

/** "You died" overlay: reload the last save or go back to the menu. */
export class DeathScene implements Scene {
  readonly id = 'death';
  readonly blocksUpdate = false; // the world keeps going (blood settles, enemies wander)
  private overlay: HTMLElement | null = null;

  constructor(
    private game: Game,
    private cause: string,
    private reload: () => Promise<void>,
  ) {}

  enter(): void {
    const load = button('Load last save', () => void this.reload(), 'btn primary');
    this.overlay = el(
      'div',
      'death-overlay',
      undefined,
      el(
        'div',
        'pause-box',
        undefined,
        el('h2', 'death-title', 'You died'),
        el('p', 'hint', this.cause),
        load,
        button('Main menu', () => void this.game.goToMainMenu()),
      ),
    );
    this.game.root.append(this.overlay);
    this.game.input.enabled = false;
    load.focus();
  }

  exit(): void {
    this.overlay?.remove();
    this.game.input.enabled = true;
  }

  update(): void {}
  render(): void {}
}
