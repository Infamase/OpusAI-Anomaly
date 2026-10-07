import type { Game } from '../core/Game';
import { saveSettings } from '../core/Settings';
import { ARMOR_SLOTS, armorFor, type ArmorSlot } from '../game/equipment';
import type { ChannelColors } from '../render/palette';
import type { EquipmentSave } from '../save/types';
import { el, downloadText, slug } from './dom';

/** What the active scene exposes to the dev panel. */
export interface DevHooks {
  player(): { raceId: string; colors: ChannelColors; stats: Record<string, number>; tile: { x: number; y: number } } | null;
  /** Returns names of armor taken off because it doesn't fit the new race. */
  setAppearance(raceId: string, colors: ChannelColors): Promise<string[]>;
  equipment(): EquipmentSave;
  /** Equips (or with null, removes) armor. Returns an error message or null. */
  equip(slot: ArmorSlot, armorId: string | null): Promise<string | null>;
  resetGear(): Promise<void>;
  listWeapons(): { id: string; name: string; slot: string }[];
  giveWeapon(id: string): void;
  godMode: boolean;
  heal(): void;
  listNpcTemplates(): { id: string; name: string; faction: string }[];
  /** Spawns a small squad from an NPC template near the player. */
  spawnSquad(templateId: string, count: number): Promise<void>;
  clearNpcs(): void;
  /** Resets the player's reputation with every faction to 0. */
  resetReputation(): void;
  buildMode: boolean;
  saveNow(): Promise<void>;
  newWorld(): Promise<void>;
  listWorlds(): { id: string; name: string; current: boolean }[];
  /** Moves the character to another world. */
  travel(worldId: string): Promise<void>;
  info(): Record<string, string | number>;
}

const SLOT_LABEL: Record<ArmorSlot, string> = { head: 'Helmet', torso: 'Top + gloves', legs: 'Pants + boots' };

/**
 * Developer overlay: live stats on the left, a control panel on the right.
 * Toggle with ` (backtick) / F3 or gamepad Select.
 * Scaffolding for testing systems before their real UI exists (inventory comes in Module 9).
 */
export class DevTools {
  private info = el('div', 'dev-info');
  private panel = el('div', 'dev-panel');
  private raceSelect = el('select');
  private colorLabel = el('span', 'label', 'Color');
  private colorInput = el('input');
  private swatches = el('div', 'swatches');
  private gear = el('div', 'dev-gear');
  private stats = el('div', 'dev-stats');
  private status = el('div', 'dev-status');
  private lastInfo = 0;
  private renderedRace = '';

  constructor(
    private game: Game,
    private hooks: DevHooks,
  ) {
    game.root.append(this.info, this.panel);

    for (const r of game.content.all('race').filter((r) => r.playable)) this.raceSelect.append(new Option(r.name, r.id));
    this.raceSelect.addEventListener('change', () => {
      this.raceSelect.blur(); // give the keyboard back to the game
      void this.applyRace();
    });

    this.colorInput.type = 'color';
    this.colorInput.addEventListener('input', () => void this.applyColor(this.colorInput.value));

    const build = el('input');
    build.type = 'checkbox';
    build.addEventListener('change', () => {
      hooks.buildMode = build.checked;
      build.blur();
    });
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
      rendererSelect.blur();
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
        const meta = game.saves.data.meta;
        downloadText(`${slug(meta.name)}-${new Date().toISOString().slice(0, 10)}.sfa.json`, await game.saves.exportSlot(meta.slotId));
      } catch (e) {
        this.setStatus(`Export failed: ${(e as Error).message}`);
      }
    };
    const reset = el('button', 'danger', 'New world');
    reset.title = 'Regenerate this world with a new seed (your character is kept)';
    reset.onclick = () => void hooks.newWorld();
    const worldSelect = el('select');
    for (const w of hooks.listWorlds()) worldSelect.append(new Option(w.current ? `${w.name} (here)` : `Travel: ${w.name}`, w.id, w.current, w.current));
    worldSelect.onchange = () => void hooks.travel(worldSelect.value);
    saveRow.append(save, exp, reset, worldSelect);

    const combat = el('div', 'dev-gear');
    const weaponSelect = el('select');
    weaponSelect.append(new Option('Give weapon…', ''));
    for (const w of hooks.listWeapons()) weaponSelect.append(new Option(`${w.name} (${w.slot})`, w.id));
    weaponSelect.onchange = () => {
      if (weaponSelect.value) hooks.giveWeapon(weaponSelect.value);
      weaponSelect.value = '';
      weaponSelect.blur();
    };
    const god = el('input');
    god.type = 'checkbox';
    god.checked = hooks.godMode;
    god.onchange = () => {
      hooks.godMode = god.checked;
      god.blur();
    };
    const godLabel = el('label', 'row');
    godLabel.append(god, el('span', 'grow', 'God mode (take no damage)'));
    const npcSelect = el('select');
    npcSelect.append(new Option('Spawn squad…', ''));
    for (const t of hooks.listNpcTemplates()) npcSelect.append(new Option(`${t.name} ×3 (${t.faction})`, t.id));
    npcSelect.onchange = () => {
      if (npcSelect.value) void hooks.spawnSquad(npcSelect.value, 3);
      npcSelect.value = '';
      npcSelect.blur();
    };
    const combatRow = el('div', 'row');
    const clear = el('button', '', 'Clear NPCs');
    clear.onclick = () => hooks.clearNpcs();
    const rep = el('button', '', 'Reset rep');
    rep.title = 'Forget every reputation change (factions go back to their default attitude)';
    rep.onclick = () => hooks.resetReputation();
    const heal = el('button', '', 'Heal');
    heal.onclick = () => hooks.heal();
    combatRow.append(clear, rep, heal);
    combat.append(weaponSelect, npcSelect, godLabel, combatRow);

    const colorRow = el('label', 'row');
    colorRow.append(this.colorLabel, this.colorInput);
    this.panel.append(
      el('h3', '', 'Dev panel'),
      this.labeled('Race', this.raceSelect),
      colorRow,
      this.swatches,
      el('h4', '', 'Equipment'),
      this.gear,
      el('h4', '', 'Combat'),
      combat,
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
        .filter(([, v]) => v !== 0)
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
    if (channel) {
      this.colorInput.value = p.colors[channel.channel] ?? channel.default;
      this.colorLabel.textContent = channel.label;
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
    this.refreshGear(p.raceId);
  }

  private refreshGear(raceId: string): void {
    const worn = this.hooks.equipment();
    this.gear.replaceChildren();
    for (const slot of ARMOR_SLOTS) {
      const select = el('select');
      select.append(new Option('— none —', ''));
      for (const a of armorFor(this.game.content, raceId, slot)) select.append(new Option(a.name, a.id));
      select.value = worn[slot]?.defId ?? '';
      select.onchange = async () => {
        select.blur();
        const err = await this.hooks.equip(slot, select.value || null);
        this.setStatus(err ?? '');
      };
      this.gear.append(this.labeled(SLOT_LABEL[slot], select));
    }
    const kit = el('button', '', 'Starting kit');
    kit.onclick = async () => {
      await this.hooks.resetGear();
      this.refreshGear(raceId);
    };
    this.gear.append(kit);
  }

  private async applyRace(): Promise<void> {
    const removed = await this.hooks.setAppearance(this.raceSelect.value, {});
    this.setStatus(removed.length ? `Removed (doesn't fit this race): ${removed.join(', ')}` : '');
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
