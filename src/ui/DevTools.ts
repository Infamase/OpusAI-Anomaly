import type { Game } from '../core/Game';
import { saveSettings } from '../core/Settings';
import type { ChannelColors } from '../render/palette';

/** What the active scene exposes to the dev panel. */
export interface DevHooks {
  player(): { raceId: string; colors: ChannelColors; stats: Record<string, number>; tile: { x: number; y: number } } | null;
  setAppearance(raceId: string, colors: ChannelColors): Promise<void>;
  buildMode: boolean;
  saveNow(): Promise<void>;
  newWorld(): Promise<void>;
  info(): Record<string, string | number>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Developer overlay: live stats on the left, a control panel on the right.
 * Toggle with ` (backtick) / F3, gamepad Select, or the DEV touch button.
 * This is scaffolding for testing; the real HUD and character creator are Phase 1.
 */
export class DevTools {
  private info = el('div', 'dev-info');
  private panel = el('div', 'dev-panel');
  private raceSelect = el('select');
  private colorInput = el('input');
  private swatches = el('div', 'swatches');
  private stats = el('div', 'dev-stats');
  private status = el('div', 'dev-status');
  private lastInfo = 0;
  private renderedRace = '';

  constructor(
    private game: Game,
    private hooks: DevHooks,
  ) {
    const root = game.root;
    root.append(this.info, this.panel);

    const races = game.content.all('race').filter((r) => r.playable);
    for (const r of races) this.raceSelect.append(new Option(r.name, r.id));
    this.raceSelect.addEventListener('change', () => void this.applyRace());

    this.colorInput.type = 'color';
    this.colorInput.addEventListener('input', () => void this.applyColor(this.colorInput.value));

    const build = el('input');
    build.type = 'checkbox';
    build.addEventListener('change', () => (hooks.buildMode = build.checked));
    const buildLabel = el('label', 'row');
    buildLabel.append(build, el('span', 'grow', 'Build mode — E / USE toggles a wall in front of you'));

    const zoomRow = el('div', 'row');
    const zoomOut = el('button', '', 'Zoom −');
    const zoomIn = el('button', '', 'Zoom +');
    zoomOut.onclick = () => game.setZoomBias(game.settings.zoomBias - 1);
    zoomIn.onclick = () => game.setZoomBias(game.settings.zoomBias + 1);
    zoomRow.append(zoomOut, zoomIn);

    const rendererSelect = el('select');
    rendererSelect.append(new Option('WebGPU (fallback WebGL)', 'webgpu'), new Option('WebGL only', 'webgl'));
    rendererSelect.value = game.settings.renderer;
    rendererSelect.onchange = () => {
      game.settings.renderer = rendererSelect.value as 'webgpu' | 'webgl';
      saveSettings(game.settings);
      this.setStatus('Renderer saved — reload to apply.');
    };

    const saveRow = el('div', 'row');
    const save = el('button', '', 'Save now');
    save.onclick = async () => {
      try {
        await hooks.saveNow();
        this.setStatus('Saved.');
      } catch (e) {
        this.setStatus(`Save failed: ${(e as Error).message}`);
      }
    };
    const exp = el('button', '', 'Export save');
    exp.onclick = async () => {
      try {
        await hooks.saveNow();
        const slot = game.saves.data.meta.slotId;
        const blob = new Blob([await game.saves.exportSlot(slot)], { type: 'application/json' });
        const a = el('a');
        a.href = URL.createObjectURL(blob);
        a.download = `sfa-${slot}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } catch (e) {
        this.setStatus(`Export failed: ${(e as Error).message}`);
      }
    };
    const imp = el('button', '', 'Import save');
    const file = el('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.style.display = 'none';
    imp.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        await game.saves.importSlot(await f.text(), game.saves.data.meta.slotId);
        location.reload();
      } catch (e) {
        this.setStatus(`Import failed: ${(e as Error).message}`);
      }
    };
    const reset = el('button', 'danger', 'New world');
    reset.onclick = async () => {
      if (confirm('Delete this save and generate a new world?')) await hooks.newWorld();
    };
    saveRow.append(save, exp, imp, reset, file);

    this.panel.append(
      el('h3', '', 'Dev panel'),
      this.labeled('Race', this.raceSelect),
      this.labeled('Color', this.colorInput),
      this.swatches,
      this.stats,
      buildLabel,
      zoomRow,
      this.labeled('Renderer', rendererSelect),
      saveRow,
      this.status,
    );

    game.events.on('debug:toggle', (on) => this.setVisible(on));
    this.setVisible(game.debugVisible);
    if (game.saveWarning) this.setStatus(game.saveWarning);
  }

  setVisible(on: boolean): void {
    this.info.style.display = on ? '' : 'none';
    this.panel.style.display = on ? '' : 'none';
    if (on) this.refreshPanel();
  }

  /** Call every frame; refreshes text a few times per second. */
  update(now: number): void {
    if (!this.game.debugVisible || now - this.lastInfo < 250) return;
    this.lastInfo = now;
    const g = this.game;
    const lines: Record<string, string | number> = {
      FPS: g.fps.toFixed(0),
      Renderer: g.renderer.backend,
      Canvas: `${g.renderer.width}×${g.renderer.height} @${g.renderer.pixelRatio.toFixed(2)}x`,
      Zoom: `${g.camera.zoom}x`,
      Input: g.input.device,
      Held: g.input.held.join(' ') || '—',
      Saves: g.saves.backend.name,
      ...this.hooks.info(),
    };
    this.info.textContent = Object.entries(lines)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const p = this.hooks.player();
    if (p) {
      this.stats.textContent = Object.entries(p.stats)
        .map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`)
        .join(' · ');
      if (p.raceId !== this.renderedRace) this.refreshPanel();
    }
  }

  destroy(): void {
    this.info.remove();
    this.panel.remove();
  }

  private refreshPanel(): void {
    const p = this.hooks.player();
    if (!p) return;
    this.renderedRace = p.raceId;
    this.raceSelect.value = p.raceId;
    const race = this.game.content.get('race', p.raceId);
    const channel = race.colorChannels[0];
    this.swatches.replaceChildren();
    if (!channel) return;
    this.colorInput.value = p.colors[channel.channel] ?? channel.default;
    (this.colorInput.previousElementSibling as HTMLElement).textContent = channel.label;
    for (const hex of channel.presets) {
      const b = el('button', 'swatch');
      b.style.background = hex;
      b.title = hex;
      b.onclick = () => {
        this.colorInput.value = hex;
        void this.applyColor(hex);
      };
      this.swatches.append(b);
    }
  }

  private async applyRace(): Promise<void> {
    await this.hooks.setAppearance(this.raceSelect.value, {});
    this.refreshPanel();
  }

  private async applyColor(hex: string): Promise<void> {
    const p = this.hooks.player();
    if (!p) return;
    const channel = this.game.content.get('race', p.raceId).colorChannels[0];
    if (!channel) return;
    await this.hooks.setAppearance(p.raceId, { ...p.colors, [channel.channel]: hex });
  }

  private labeled(label: string, input: HTMLElement): HTMLElement {
    const row = el('label', 'row');
    row.append(el('span', 'label', label), input);
    return row;
  }

  private setStatus(msg: string): void {
    this.status.textContent = msg;
  }
}
