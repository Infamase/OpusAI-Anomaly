import type { AudioVolumes } from '../audio/AudioEngine';
import type { Game } from '../core/Game';
import { saveSettings } from '../core/Settings';
import { button, el } from './dom';

const VOLUMES: [keyof AudioVolumes, string][] = [
  ['master', 'Master volume'],
  ['sfx', 'Effects'],
  ['ambient', 'Ambience'],
  ['voice', 'Voices'],
  ['ui', 'Interface'],
];

/**
 * Settings dialog (sound, display), opened from the title screen and the pause
 * menu. Every change applies and saves at once. Settings are per device, not
 * part of a save game.
 */
export class OptionsPanel {
  private overlay: HTMLElement;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      this.close();
    }
  };

  constructor(
    private game: Game,
    private onClose: () => void = () => {},
  ) {
    const s = game.settings;
    const rows: HTMLElement[] = [el('h3', 'opt-section', 'Sound')];
    for (const [key, label] of VOLUMES) {
      rows.push(
        this.slider(label, s.volume[key], 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
          s.volume[key] = v;
          this.applyAudio();
        }),
      );
    }
    rows.push(
      this.toggle('Mute all sound', s.muted, (on) => {
        s.muted = on;
        this.applyAudio();
      }),
    );
    rows.push(el('h3', 'opt-section', 'Display'));
    rows.push(
      this.slider('Camera zoom', s.zoomBias, -3, 4, 1, (v) => (v === 0 ? 'auto' : v > 0 ? `+${v}` : `${v}`), (v) => game.setZoomBias(v)),
      this.select(
        'Renderer',
        [
          ['webgpu', 'WebGPU (falls back to WebGL)'],
          ['webgl', 'WebGL'],
        ],
        s.renderer,
        (v) => {
          s.renderer = v as typeof s.renderer;
          saveSettings(s);
          restart.hidden = v === game.renderer.backend;
        },
      ),
    );
    const restart = el('p', 'opt-note', 'Renderer change applies the next time the game starts.');
    restart.hidden = s.renderer === game.renderer.backend;
    rows.push(restart, this.toggle('Performance overlay (F3)', game.debugVisible, (on) => game.setDebugVisible(on)));

    const done = button('Done', () => this.close(), 'btn primary');
    this.overlay = el(
      'div',
      'modal-overlay options-overlay',
      undefined,
      el('div', 'modal-box options-box', undefined, el('h2', '', 'Options'), ...rows, el('div', 'modal-buttons', undefined, done)),
    );
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    game.root.append(this.overlay);
    window.addEventListener('keydown', this.onKey, true);
    done.focus();
  }

  close(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.overlay.remove();
    saveSettings(this.game.settings);
    this.onClose();
  }

  private applyAudio(): void {
    this.game.audio.setVolumes(this.game.settings.volume, this.game.settings.muted);
    saveSettings(this.game.settings);
  }

  private slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const input = el('input', 'opt-range');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    input.setAttribute('aria-label', label);
    const out = el('span', 'opt-value', fmt(value));
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      onInput(v);
    });
    // Let the player hear the new effects level.
    input.addEventListener('change', () => this.game.audio.playCue('ui_click'));
    return el('label', 'opt-row', undefined, el('span', 'opt-label', label), input, out);
  }

  private toggle(label: string, value: boolean, onChange: (on: boolean) => void): HTMLElement {
    const input = el('input', 'opt-check');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', 'opt-row', undefined, el('span', 'opt-label', label), input);
  }

  private select(label: string, options: [string, string][], value: string, onChange: (v: string) => void): HTMLElement {
    const sel = el('select', 'opt-select');
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = v;
      sel.append(o);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return el('label', 'opt-row', undefined, el('span', 'opt-label', label), sel);
  }
}
