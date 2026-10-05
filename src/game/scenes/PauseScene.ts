import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';
import { button, el } from '../../ui/dom';
import { OptionsPanel } from '../../ui/OptionsPanel';

/**
 * Overlay scene pushed on top of gameplay. Because it blocks updates, the world
 * underneath freezes but keeps rendering — the scene stack in action.
 */
export class PauseScene implements Scene {
  readonly id = 'pause';
  readonly blocksUpdate = true;
  private overlay: HTMLElement | null = null;
  private closing = false;
  private options: OptionsPanel | null = null;

  constructor(
    private game: Game,
    /** Leaves gameplay for the title screen (the gameplay scene saves on exit). */
    private onQuit: () => Promise<void>,
  ) {}

  enter(): void {
    const resume = button('Resume', () => this.close(), 'btn primary');
    const options = button('Options', () => (this.options = new OptionsPanel(this.game, () => ((this.options = null), options.focus()))));
    const quit = button('Save & Quit to Menu', () => void this.quit());
    this.overlay = el(
      'div',
      'pause-overlay',
      undefined,
      el('div', 'pause-box', undefined, el('h2', '', 'Paused'), el('p', 'hint', 'Esc / Start / ❚❚ to resume'), resume, options, quit),
    );
    this.game.root.appendChild(this.overlay);
    this.game.input.enabled = false;
    this.game.audio.duck(true);
    resume.focus();
  }

  exit(): void {
    this.options?.close();
    this.overlay?.remove();
    this.overlay = null;
    this.game.input.enabled = true;
    this.game.audio.duck(false);
  }

  update(): void {
    if (this.options) return;
    if (this.game.input.justPressed('pause')) this.close();
  }

  render(): void {}

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.game.scenes.pop();
  }

  private async quit(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.overlay?.querySelectorAll('button').forEach((b) => (b.disabled = true));
    await this.onQuit();
  }
}
