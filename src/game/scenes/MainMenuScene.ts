import { Container } from 'pixi.js';
import type { Game } from '../../core/Game';
import { GAME_VERSION } from '../../core/Game';
import { DIRECTIONS } from '../../core/math';
import type { Scene } from '../../core/Scene';
import { SaveManager, type SlotSummary } from '../../save/SaveManager';
import type { EquipmentSave } from '../../save/types';
import { CharacterPreview } from '../../ui/CharacterPreview';
import { button, el, formatDate, formatPlayTime, modal, pickTextFile, downloadText, slug, toast } from '../../ui/dom';
import { drawPortrait } from '../../ui/portrait';
import { prepareCharacterArt } from '../characters';
import { createItem } from '../equipment';
import { CharacterCreatorScene } from './CharacterCreatorScene';
import { GameplayScene } from './GameplayScene';

/** The three races posing in different kits behind the menu. */
const SHOWCASE: { raceId: string; color: string; gear: string[] }[] = [
  { raceId: 'lizardman', color: '#2f6b5e', gear: ['stalker_hood', 'stalker_jacket', 'stalker_pants'] },
  { raceId: 'human', color: '#1c1714', gear: ['military_helmet', 'military_vest', 'military_legs'] },
  { raceId: 'sergal', color: '#e6e2da', gear: ['military_helmet', 'stalker_jacket', 'military_legs'] },
];

/**
 * Title screen: Continue / New Game / Load Game / Import Save.
 * Load lists every save slot (with portrait, play time and last-saved date) and
 * can export or delete them. Import reads a save exported on another device.
 */
export class MainMenuScene implements Scene {
  readonly id = 'main-menu';
  private root = el('div', 'menu-screen');
  private layer = new Container({ label: 'menu-showcase' });
  private previews: CharacterPreview[] = [];
  private time = 0;
  private busy = false;

  constructor(private game: Game) {}

  async enter(): Promise<void> {
    const g = this.game;
    g.setGameplayInput(false);
    g.renderer.screen.addChild(this.layer);
    g.root.append(this.root);
    for (const s of SHOWCASE) {
      const p = new CharacterPreview(g, this.layer);
      const equipment: EquipmentSave = {};
      for (const suffix of s.gear) {
        const id = `${s.raceId}_${suffix}`;
        const def = g.content.tryGet('armor', id);
        if (def) equipment[def.slot] = createItem(id);
      }
      void p.set(s.raceId, { primary: s.color }, equipment);
      this.previews.push(p);
    }
    await this.showHome();
  }

  exit(): void {
    for (const p of this.previews) p.destroy();
    this.previews = [];
    this.layer.destroy({ children: true });
    this.root.remove();
  }

  update(dt: number): void {
    this.time += dt;
    this.previews.forEach((p, i) => {
      p.update(dt);
      // Each character slowly turns to show off all four facings.
      p.dir = DIRECTIONS[Math.floor(this.time / 3 + i * 1.3) % 4]!;
    });
  }

  render(): void {
    const { width: W, height: H } = this.game.renderer;
    const scale = Math.max(2, Math.floor(Math.min(H / 170, W / 210)));
    const gap = 40 * scale;
    // To the right of the menu column.
    const cx = W * 0.66;
    const y = H * 0.62;
    this.previews.forEach((p, i) => {
      p.place(cx + (i - 1) * gap, y, scale);
      p.render();
    });
  }

  // ---- views ---------------------------------------------------------------

  private async showHome(): Promise<void> {
    const g = this.game;
    const saves = await g.saves.listSummaries();
    const latest = saves.find((s) => !s.error);
    const nav = el('nav', 'menu-buttons');
    if (latest) {
      nav.append(button(`Continue — ${latest.meta.name}`, () => void this.load(latest.meta.slotId), 'btn primary big'));
    }
    nav.append(
      button('New Game', () => void this.game.scenes.change(new CharacterCreatorScene(g)), `btn big ${latest ? '' : 'primary'}`),
      button('Load Game', () => void this.showLoad(), 'btn big'),
      button('Import Save', () => void this.importSave(), 'btn big'),
    );
    this.root.replaceChildren(
      el('div', 'menu-column', undefined, this.title(), nav),
      el('div', 'menu-footer', `v${GAME_VERSION} · ${g.renderer.backend}${g.saveWarning ? ' · saving unavailable' : ''}`),
    );
    (nav.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  private async showLoad(highlight?: string): Promise<void> {
    const g = this.game;
    const list = el('div', 'save-list');
    const saves = await g.saves.listSummaries();
    if (!saves.length) list.append(el('p', 'muted', 'No saves yet. Start a new game, or import a save from another device.'));
    for (const s of saves) list.append(await this.saveRow(s, s.meta.slotId === highlight));
    const back = button('Back', () => void this.showHome());
    const imp = button('Import Save', () => void this.importSave());
    this.root.replaceChildren(
      el('div', 'menu-column wide', undefined, el('h2', 'menu-heading', 'Load Game'), list, el('div', 'row', undefined, back, imp)),
    );
    list.querySelector('.save-row.highlight')?.scrollIntoView({ block: 'nearest' });
  }

  private async saveRow(s: SlotSummary, highlight: boolean): Promise<HTMLElement> {
    const g = this.game;
    const row = el('div', `save-row${highlight ? ' highlight' : ''}`);
    const race = g.content.tryGet('race', s.player?.raceId);
    let portrait: HTMLElement = el('div', 'portrait placeholder', '?');
    if (race && !s.error) {
      try {
        await prepareCharacterArt(g.content, g.sheets, race.id, s.player.equipment);
        portrait = drawPortrait(g.content, g.sheets, race.id, s.player.colors, s.player.equipment);
      } catch (e) {
        console.warn('[menu] portrait failed', e);
      }
    }
    const details = el(
      'div',
      'save-info',
      undefined,
      el('div', 'save-name', s.meta.name),
      el('div', 'muted', s.error ? `Can't load: ${s.error}` : `${race?.name ?? s.player.raceId} · played ${formatPlayTime(s.meta.playTimeSec)}`),
      el('div', 'muted', `Saved ${formatDate(s.meta.updatedAt)}`),
    );
    const actions = el('div', 'save-actions');
    const load = button('Load', () => void this.load(s.meta.slotId), 'btn primary');
    load.disabled = !!s.error;
    actions.append(
      load,
      button('Export', () => void this.exportSave(s)),
      button('Delete', () => void this.deleteSave(s), 'btn danger'),
    );
    row.append(portrait, details, actions);
    return row;
  }

  private title(): HTMLElement {
    return el('div', 'menu-title', 'STALKER', el('span', '', 'FUTURE ANOMALY'));
  }

  // ---- actions -------------------------------------------------------------

  private async load(slotId: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.game.scenes.change(new GameplayScene(this.game, slotId));
    } catch (e) {
      this.busy = false;
      await modal(this.game.root, 'Could not load', (e as Error).message, [{ label: 'OK', value: null }]);
      await this.game.goToMainMenu();
    }
  }

  private async exportSave(s: SlotSummary): Promise<void> {
    try {
      const json = await this.game.saves.exportSlot(s.meta.slotId);
      downloadText(`${slug(s.meta.name)}-${new Date().toISOString().slice(0, 10)}.sfa.json`, json);
    } catch (e) {
      toast(this.game.root, `Export failed: ${(e as Error).message}`);
    }
  }

  private async deleteSave(s: SlotSummary): Promise<void> {
    const ok = await modal(this.game.root, 'Delete save?', `"${s.meta.name}" will be gone for good (export it first if you want a backup).`, [
      { label: 'Cancel', value: false },
      { label: 'Delete', value: true, cls: 'danger' },
    ]);
    if (!ok) return;
    await this.game.saves.deleteSlot(s.meta.slotId);
    toast(this.game.root, `Deleted ${s.meta.name}`);
    await this.showLoad();
  }

  /** Reads a save exported on another device (or as a backup) into this device's storage. */
  private async importSave(): Promise<void> {
    const g = this.game;
    const file = await pickTextFile('.json,application/json');
    if (!file) return;
    let preview;
    try {
      preview = g.saves.previewImport(file.text);
    } catch (e) {
      await modal(g.root, 'Import failed', (e as Error).message, [{ label: 'OK', value: null }]);
      return;
    }
    const { meta } = preview.data;
    let target = meta.slotId;
    if (await g.saves.slotExists(meta.slotId)) {
      const choice = await modal(
        g.root,
        'Save already on this device',
        `"${meta.name}" (saved ${formatDate(meta.updatedAt)}) is already here. Replace the copy on this device, or keep both?`,
        [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Keep both', value: 'both' },
          { label: 'Replace', value: 'replace', cls: 'primary' },
        ],
      );
      if (choice === 'cancel') return;
      if (choice === 'both') target = SaveManager.newSlotId();
    }
    try {
      const slotId = await g.saves.importSlot(file.text, target);
      toast(g.root, `Imported ${meta.name}`);
      await this.showLoad(slotId);
    } catch (e) {
      await modal(g.root, 'Import failed', (e as Error).message, [{ label: 'OK', value: null }]);
    }
  }
}
