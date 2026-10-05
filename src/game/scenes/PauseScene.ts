import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';

/**
 * Overlay scene pushed on top of gameplay. Because it blocks updates, the world
 * underneath freezes but keeps rendering — the scene stack in action.
 */
export class PauseScene implements Scene {
  readonly id = 'pause';
  readonly blocksUpdate = true;
  private overlay: HTMLElement | null = null;
  private closing = false;

  constructor(private game: Game) {}

  enter(): void {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pause-overlay';
    this.overlay.innerHTML = `
      <div class="pause-box">
        <h2>Paused</h2>
        <p class="hint">Esc / Start / ❚❚ to resume</p>
        <button class="resume">Resume</button>
      </div>`;
    this.overlay.querySelector('.resume')!.addEventListener('click', () => this.close());
    this.game.root.appendChild(this.overlay);
    this.game.input.enabled = false;
  }

  exit(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.game.input.enabled = true;
  }

  update(): void {
    if (this.game.input.justPressed('pause')) this.close();
  }

  render(): void {}

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.game.scenes.pop();
  }
}
