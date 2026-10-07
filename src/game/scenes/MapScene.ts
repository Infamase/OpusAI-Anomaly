import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';
import { el } from '../../ui/dom';

export interface MapHost {
  /** The explored terrain, one pixel per tile (fog where unexplored). */
  readonly mapCanvas: HTMLCanvasElement;
  readonly worldName: string;
  /** Player position in tiles and aim angle. */
  playerOnMap(): { x: number; y: number; aim: number | null };
  /** Named places the player has discovered (tile coords). */
  knownPlaces(): { name: string; x: number; y: number; w: number; h: number; hazard?: boolean }[];
  /** 0..1 */
  exploredShare(): number;
  /** Where the player currently is ("Pine Forest", "Rookie Village"). */
  locationName(): string;
}

/**
 * The PDA map: the whole world as far as the player has explored it, with
 * discovered places and the player's position. Pauses the game.
 */
export class MapScene implements Scene {
  readonly id = 'map';
  readonly blocksUpdate = true;
  private root = el('div', 'map-overlay');
  private closing = false;

  constructor(
    private game: Game,
    private host: MapHost,
  ) {}

  enter(): void {
    const g = this.game;
    g.input.enabled = false;
    g.audio.playCue('ui_open');
    const src = this.host.mapCanvas;
    const W = src.width;
    const H = src.height;
    // Fit the map to the screen; whole-number scales keep pixels crisp.
    const avail = Math.min(g.root.clientWidth - 64, g.root.clientHeight - 150);
    const fit = avail / Math.max(W, H);
    const k = fit >= 2 ? Math.floor(fit) : fit;
    const view = el('canvas', 'map-canvas');
    view.width = Math.round(W * k);
    view.height = Math.round(H * k);
    const ctx = view.getContext('2d');
    const labels = el('div', 'map-labels');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, 0, 0, view.width, view.height);
      for (const p of this.host.knownPlaces()) {
        if (p.hazard) {
          // Anomaly fields: a red dashed ring.
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#e0573f';
          ctx.beginPath();
          ctx.ellipse(p.x * k, p.y * k, (p.w / 2) * k, (p.h / 2) * k, 0, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = '#e2c060';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round((p.x - p.w / 2) * k) + 0.5, Math.round((p.y - p.h / 2) * k) + 0.5, Math.round(p.w * k), Math.round(p.h * k));
        }
        const label = el('span', `map-label${p.hazard ? ' hazard' : ''}`, p.name);
        label.style.left = `${p.x * k}px`;
        label.style.top = `${(p.y - p.h / 2) * k - 4}px`;
        labels.append(label);
      }
      const me = this.host.playerOnMap();
      const px = me.x * k;
      const py = me.y * k;
      const a = me.aim ?? -Math.PI / 2;
      const pt = (r: number, t: number): [number, number] => [px + Math.cos(a + t) * r, py + Math.sin(a + t) * r];
      ctx.beginPath();
      ctx.arc(px, py, 11, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(243, 211, 106, 0.6)';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(...pt(8, 0));
      ctx.lineTo(...pt(6, 2.4));
      ctx.lineTo(...pt(2, Math.PI));
      ctx.lineTo(...pt(6, -2.4));
      ctx.closePath();
      ctx.fillStyle = '#f3d36a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fill();
    }
    const frame = el('div', 'map-frame', undefined, view, labels);
    frame.style.width = `${view.width}px`;
    frame.style.height = `${view.height}px`;
    const pct = Math.round(this.host.exploredShare() * 100);
    this.root.append(
      el(
        'div',
        'map-box',
        undefined,
        el('div', 'map-head', undefined, el('h2', '', this.host.worldName), el('span', 'map-where', this.host.locationName()), el('span', 'map-explored', `${pct}% explored`)),
        frame,
        el('div', 'map-hint', 'M / Esc to close'),
      ),
    );
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    g.root.append(this.root);
  }

  exit(): void {
    this.root.remove();
    this.game.input.enabled = true;
    this.game.audio.playCue('ui_close');
  }

  update(): void {
    const input = this.game.input;
    if (input.justPressed('map') || input.justPressed('pause') || input.justPressed('inventory')) this.close();
  }

  render(): void {}

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.game.scenes.pop();
  }
}
