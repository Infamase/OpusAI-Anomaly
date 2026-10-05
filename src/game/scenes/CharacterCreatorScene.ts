import { Container } from 'pixi.js';
import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';
import type { RaceDef } from '../../content/types';
import type { ChannelColors } from '../../render/palette';
import type { EquipmentSave } from '../../save/types';
import { CharacterPreview } from '../../ui/CharacterPreview';
import { button, el, modal } from '../../ui/dom';
import { buildCharacterStats, resolveColors } from '../characters';
import { findItem } from '../../content/items';
import { startingEquipment, startingInventory } from '../equipment';
import { startNewGame } from './GameplayScene';

const NAMES = ['Strelok', 'Ghost', 'Fang', 'Scar', 'Hawk', 'Nomad', 'Kestrel', 'Ash', 'Vex', 'Saber', 'Rook', 'Tarn', 'Juniper', 'Doc', 'Wren', 'Sable'];
const BAR_STATS: [string, string][] = [
  ['max_health', 'Health'],
  ['max_stamina', 'Stamina'],
  ['move_speed', 'Speed'],
  ['carry_weight', 'Carry'],
];
const MAX_NAME = 20;

/**
 * New-character screen. Appearance is deliberately basic for now: race, one
 * color (hair / scales / fur) and name. The NPC generator will reuse the same
 * race + colors model.
 */
export class CharacterCreatorScene implements Scene {
  readonly id = 'character-creator';
  private root = el('div', 'creator');
  private stage = el('div', 'creator-stage');
  private layer = new Container({ label: 'creator-preview' });
  private preview: CharacterPreview;
  private nameInput = el('input', 'name-input');
  private raceCards = el('div', 'race-cards');
  private colorArea = el('div', 'color-area');
  private kitArea = el('div', 'kit');
  private statsArea = el('div', 'stat-table');

  private raceId: string;
  private colors: ChannelColors = {};
  private equipment: EquipmentSave = {};
  private showGear = true;
  private dirIndex = 0;
  private starting = false;

  constructor(private game: Game) {
    this.preview = new CharacterPreview(game, this.layer);
    this.raceId = this.races()[0]!.id;
  }

  enter(): void {
    const g = this.game;
    g.setGameplayInput(false);
    g.renderer.screen.addChild(this.layer);

    this.nameInput.maxLength = MAX_NAME;
    this.nameInput.placeholder = 'Name';
    this.nameInput.value = pick(NAMES);
    this.nameInput.autocomplete = 'off';
    this.nameInput.spellcheck = false;
    const dice = button('🎲', () => (this.nameInput.value = pick(NAMES)), 'btn icon');
    dice.title = 'Random name';

    const controls = el(
      'div',
      'creator-stage-controls',
      undefined,
      button('⟲', () => this.turn(-1), 'btn icon'),
      button('⟳', () => this.turn(1), 'btn icon'),
      this.toggle('Walk', false, (on) => (this.preview.anim = on ? 'walk' : 'idle')),
      this.toggle('Gear', true, (on) => {
        this.showGear = on;
        void this.refreshPreview();
      }),
    );
    this.stage.append(controls);

    const panel = el(
      'aside',
      'creator-panel',
      undefined,
      el('h2', 'menu-heading', 'New Stalker'),
      el('label', 'field', undefined, el('span', 'label', 'Name'), el('div', 'row', undefined, this.nameInput, dice)),
      el('div', 'field', undefined, el('span', 'label', 'Race'), this.raceCards),
      this.colorArea,
      this.kitArea,
      this.statsArea,
      el(
        'div',
        'row creator-actions',
        undefined,
        button('Back', () => void g.goToMainMenu()),
        button('Begin', () => void this.begin(), 'btn primary'),
      ),
    );
    this.root.append(this.stage, panel);
    g.root.append(this.root);
    this.selectRace(this.raceId);
  }

  exit(): void {
    this.preview.destroy();
    this.layer.destroy({ children: true });
    this.root.remove();
  }

  update(dt: number): void {
    this.preview.update(dt);
    if (this.game.input.justPressed('pause')) void this.game.goToMainMenu();
  }

  render(): void {
    const pr = this.game.renderer.pixelRatio;
    const r = this.stage.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const scale = Math.max(2, Math.min(12, Math.floor((r.height * pr * 0.6) / 48)));
    this.preview.place((r.left + r.width / 2) * pr, (r.top + r.height * 0.7) * pr, scale);
    this.preview.render();
  }

  // ---- UI ------------------------------------------------------------------

  private races(): RaceDef[] {
    return this.game.content.all('race').filter((r) => r.playable);
  }

  private selectRace(raceId: string): void {
    const g = this.game;
    this.raceId = raceId;
    const race = g.content.get('race', raceId);
    this.colors = resolveColors(race);
    this.equipment = startingEquipment(g.content, raceId);
    this.renderRaceCards();
    this.renderColors(race);
    this.renderKitAndStats(race);
    void this.refreshPreview();
  }

  private renderRaceCards(): void {
    const races = this.races();
    const max = (stat: string) => Math.max(...races.map((r) => r.baseStats[stat] ?? 0), 1);
    this.raceCards.replaceChildren(
      ...races.map((r) => {
        const bars = el('div', 'bars');
        for (const [stat, label] of BAR_STATS) {
          const value = r.baseStats[stat] ?? this.game.content.get('stat', stat).default;
          const fill = el('div', 'bar-fill');
          fill.style.width = `${Math.round((value / max(stat)) * 100)}%`;
          bars.append(el('span', 'bar-label', label), el('div', 'bar', undefined, fill), el('span', 'bar-value', String(value)));
        }
        const card = button('', () => this.selectRace(r.id), `race-card${r.id === this.raceId ? ' selected' : ''}`);
        card.append(el('div', 'race-name', r.name), el('div', 'race-desc', r.description), bars);
        card.setAttribute('aria-pressed', String(r.id === this.raceId));
        return card;
      }),
    );
  }

  private renderColors(race: RaceDef): void {
    const channel = race.colorChannels[0];
    this.colorArea.replaceChildren();
    if (!channel) return;
    const custom = el('input');
    custom.type = 'color';
    custom.value = this.colors[channel.channel] ?? channel.default;
    const swatches = el('div', 'swatches');
    const setColor = (hex: string) => {
      this.colors = { ...this.colors, [channel.channel]: hex };
      custom.value = hex;
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('selected', (s as HTMLElement).dataset.hex === hex));
      void this.refreshPreview();
    };
    for (const hex of channel.presets) {
      const b = button('', () => setColor(hex), `swatch${hex === custom.value ? ' selected' : ''}`);
      b.style.background = hex;
      b.dataset.hex = hex;
      b.title = hex;
      swatches.append(b);
    }
    custom.addEventListener('input', () => setColor(custom.value));
    custom.title = 'Custom color';
    swatches.append(custom);
    this.colorArea.append(el('div', 'field', undefined, el('span', 'label', channel.label), swatches));
  }

  private renderKitAndStats(race: RaceDef): void {
    const g = this.game;
    const names = [...Object.values(this.equipment), ...startingInventory(g.content, race.id)].map((item) => {
      const def = findItem(g.content, item!.defId)?.def;
      const n = item!.count ?? 1;
      return `${def?.name ?? item!.defId}${n > 1 ? ` ×${n}` : ''}`;
    });
    this.kitArea.replaceChildren(
      el('span', 'label', 'Starting gear'),
      names.length ? el('ul', 'kit-list', undefined, ...names.map((n) => el('li', '', n))) : el('p', 'muted', 'None'),
    );
    const stats = buildCharacterStats(g.content, race, this.equipment);
    const rows = g.content
      .all('stat')
      .map((def) => ({ def, value: stats.get(def.id) }))
      .filter(({ def, value }) => value !== 0 && def.id !== 'sprint_multiplier');
    this.statsArea.replaceChildren(
      el('span', 'label', 'With starting gear'),
      el(
        'div',
        'stat-grid',
        undefined,
        ...rows.flatMap(({ def, value }) => [
          el('span', '', def.name),
          el('span', 'num', def.format === 'percent' ? `${Math.round(value * 100)}%` : String(Math.round(value * 10) / 10)),
        ]),
      ),
    );
  }

  private async refreshPreview(): Promise<void> {
    await this.preview.set(this.raceId, this.colors, this.equipment, this.showGear);
  }

  private turn(step: number): void {
    this.dirIndex = (this.dirIndex + step + 4) % 4;
    // Clockwise as seen on screen: down -> left -> up -> right.
    const order = ['down', 'left', 'up', 'right'] as const;
    this.preview.dir = order[this.dirIndex]!;
  }

  private toggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLButtonElement {
    let on = initial;
    const b = button(label, () => {
      on = !on;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      onChange(on);
    });
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    return b;
  }

  private async begin(): Promise<void> {
    if (this.starting) return;
    const name = this.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    if (!name) {
      this.nameInput.classList.add('invalid');
      this.nameInput.focus();
      return;
    }
    this.starting = true;
    try {
      await startNewGame(this.game, { name, raceId: this.raceId, colors: this.colors });
    } catch (e) {
      this.starting = false;
      await modal(this.game.root, 'Could not start', (e as Error).message, [{ label: 'OK', value: null }]);
    }
  }
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}
