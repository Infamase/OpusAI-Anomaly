import { findItem, type ItemInfo } from '../../content/items';
import type { Game } from '../../core/Game';
import type { Scene } from '../../core/Scene';
import type { Entity, World } from '../../ecs/World';
import type { EquipmentSlot, ItemInstance } from '../../save/types';
import { button, el } from '../../ui/dom';
import { drawPortrait } from '../../ui/portrait';
import { prepareCharacterArt } from '../characters';
import { Character, Container, Encumbrance, Equipment, Health, Inventory, Stats } from '../components';
import { conditionFactor } from '../equipment';
import { playUseSound } from '../GameAudio';
import { equipFromInventory, slotFor, unequipToInventory, unloadWeapon, useFromInventory } from '../inventoryActions';
import { addItem, countOf, inventoryWeight, removeInstance } from '../items';
import { refreshEncumbrance } from '../systems/EncumbranceSystem';

/** What the inventory needs from the gameplay scene. */
export interface InventoryHost {
  readonly world: World;
  readonly playerId: Entity;
  /** Places an item on the ground at the player's feet (and saves it there). */
  dropItem(item: ItemInstance): void;
  /** Saves a container's contents after they changed. */
  containerChanged(container: Entity): void;
  message(text: string): void;
}

type Where = { from: 'bag' } | { from: 'slot'; slot: EquipmentSlot } | { from: 'container' };
type Filter = 'all' | 'weapon' | 'armor' | 'ammo' | 'consumable';

const SLOTS: { slot: EquipmentSlot; label: string }[] = [
  { slot: 'head', label: 'Head' },
  { slot: 'torso', label: 'Top + gloves' },
  { slot: 'legs', label: 'Pants + boots' },
  { slot: 'primary', label: 'Primary' },
  { slot: 'sidearm', label: 'Sidearm' },
];
const KIND_ORDER: Record<string, number> = { weapon: 0, armor: 1, ammo: 2, consumable: 3 };
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['weapon', 'Weapons'],
  ['armor', 'Armor'],
  ['ammo', 'Ammo'],
  ['consumable', 'Supplies'],
];

/**
 * Inventory and looting screen (pauses the world). Left: paper doll and
 * equipment slots. Middle: backpack. Right: the container being looted (if
 * any) and details for the selected item, compared with what's equipped.
 *
 * Mouse: drag between areas (drag outside the window to drop on the ground),
 * double-click for the main action, shift-click to move straight to the
 * container or backpack.
 */
export class InventoryScene implements Scene {
  readonly id = 'inventory';
  readonly blocksUpdate = true;
  private root = el('div', 'inv-overlay');
  private win = el('div', 'inv-window');
  private filter: Filter = 'all';
  private selected: { item: ItemInstance; where: Where } | null = null;
  private hovered: { item: ItemInstance; where: Where } | null = null;
  private containerDirty = false;
  private closing = false;
  private busy = false;

  constructor(
    private game: Game,
    private host: InventoryHost,
    private container: Entity | null = null,
  ) {}

  private get content() {
    return this.game.content;
  }
  private get w() {
    return this.host.world;
  }
  private get p() {
    return this.host.playerId;
  }

  async enter(): Promise<void> {
    const g = this.game;
    g.input.enabled = false;
    await g.icons.prepareAll();
    this.root.append(this.win);
    // Dropping onto the dim backdrop (outside the window) puts the item on the ground.
    this.root.addEventListener('dragover', (e) => e.preventDefault());
    this.root.addEventListener('drop', (e) => {
      if (e.target !== this.root) return;
      e.preventDefault();
      const src = this.readDrag(e);
      if (src) void this.act(() => this.drop(src.item, src.where));
    });
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    g.root.append(this.root);
    this.redraw();
    g.audio.playCue('ui_open');
  }

  exit(): void {
    this.root.remove();
    this.game.audio.playCue('ui_close');
    this.game.input.enabled = true;
    if (this.container !== null && this.containerDirty) this.host.containerChanged(this.container);
  }

  update(): void {
    const input = this.game.input;
    if (input.justPressed('inventory') || input.justPressed('pause') || input.justPressed('interact')) this.close();
  }

  render(): void {}

  private close(): void {
    if (this.closing) return;
    this.closing = true;
    void this.game.scenes.pop();
  }

  // ---- data ---------------------------------------------------------------

  private bag(): ItemInstance[] {
    return this.w.req(this.p, Inventory);
  }

  private eq(): Partial<Record<EquipmentSlot, ItemInstance>> {
    return this.w.req(this.p, Equipment);
  }

  private crate(): ItemInstance[] | null {
    return this.container === null ? null : (this.w.get(this.container, Container)?.items ?? null);
  }

  private info(item: ItemInstance): ItemInfo | undefined {
    return findItem(this.content, item.defId);
  }

  private sorted(items: ItemInstance[]): ItemInstance[] {
    return items
      .filter((it) => this.filter === 'all' || this.info(it)?.kind === this.filter)
      .slice()
      .sort((a, b) => {
        const ia = this.info(a);
        const ib = this.info(b);
        return (KIND_ORDER[ia?.kind ?? ''] ?? 9) - (KIND_ORDER[ib?.kind ?? ''] ?? 9) || (ia?.def.name ?? '').localeCompare(ib?.def.name ?? '');
      });
  }

  // ---- actions ------------------------------------------------------------

  /** Runs an action, then refreshes weight, view and messages. */
  private async act(fn: () => Promise<string | null> | string | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const err = await fn();
      if (err) this.host.message(err);
      refreshEncumbrance(this.w, this.content, this.p);
      this.selected = null;
      this.redraw();
    } finally {
      this.busy = false;
    }
  }

  /** The obvious action for an item where it is (double-click). */
  private primary(item: ItemInstance, where: Where): Promise<void> {
    if (where.from === 'container') return this.act(() => this.take(item));
    if (where.from === 'slot') return this.act(() => this.unequip(where.slot));
    if (this.container !== null) return this.act(() => this.store(item));
    const kind = this.info(item)?.kind;
    if (kind === 'consumable') return this.act(() => this.use(item));
    if (kind === 'armor' || kind === 'weapon') return this.act(() => this.equip(item));
    return Promise.resolve();
  }

  private async equip(item: ItemInstance): Promise<string | null> {
    const err = await equipFromInventory(this.w, this.content, this.game.sheets, this.p, item);
    if (!err) this.game.audio.playCue('equip');
    return err;
  }

  private unequip(slot: EquipmentSlot): null {
    unequipToInventory(this.w, this.content, this.game.sheets, this.p, slot);
    this.game.audio.playCue('equip');
    return null;
  }

  private use(item: ItemInstance): string | null {
    const err = useFromInventory(this.w, this.content, this.p, item);
    if (!err) playUseSound(this.game.audio, this.content, item.defId);
    return err;
  }

  private take(item: ItemInstance): null {
    const crate = this.crate();
    if (!crate || !removeInstance(crate, item.uid)) return null;
    addItem(this.content, this.bag(), item);
    this.containerDirty = true;
    this.game.audio.playCue('pickup');
    return null;
  }

  private store(item: ItemInstance): null {
    const crate = this.crate();
    if (!crate || !removeInstance(this.bag(), item.uid)) return null;
    addItem(this.content, crate, item);
    this.containerDirty = true;
    this.game.audio.playCue('pickup');
    return null;
  }

  private takeAll(): null {
    const crate = this.crate();
    if (!crate) return null;
    for (const it of crate.splice(0)) addItem(this.content, this.bag(), it);
    this.containerDirty = true;
    this.game.audio.playCue('pickup');
    return null;
  }

  private drop(item: ItemInstance, where: Where): null {
    if (where.from === 'slot') this.unequip(where.slot);
    if (where.from === 'container') {
      this.take(item);
    }
    if (removeInstance(this.bag(), item.uid)) this.host.dropItem(item);
    return null;
  }

  /** Handles a drag from `src` onto an area. */
  private dropOn(target: 'bag' | 'container' | { slot: EquipmentSlot }, src: { item: ItemInstance; where: Where }): Promise<void> {
    const { item, where } = src;
    return this.act(async () => {
      if (target === 'bag') {
        if (where.from === 'slot') return this.unequip(where.slot);
        if (where.from === 'container') return this.take(item);
        return null;
      }
      if (target === 'container') {
        if (where.from === 'slot') {
          this.unequip(where.slot);
          return this.store(item);
        }
        if (where.from === 'bag') return this.store(item);
        return null;
      }
      // Onto an equipment slot.
      if (slotFor(this.content, item.defId) !== target.slot) return `That doesn't go in the ${target.slot} slot.`;
      if (where.from === 'container') this.take(item);
      if (where.from === 'slot') return null;
      return this.equip(item);
    });
  }

  // ---- view ---------------------------------------------------------------

  private redraw(): void {
    const char = this.charPanel();
    const bag = this.bagPanel();
    const side = el('section', 'inv-side');
    if (this.container !== null) side.append(this.containerPanel());
    side.append(this.detailsPanel());
    this.win.replaceChildren(char, bag, side);
  }

  private charPanel(): HTMLElement {
    const g = this.game;
    const ch = this.w.req(this.p, Character);
    const eq = this.eq();
    const panel = el('section', 'inv-char');
    const name = g.saves.isLoaded ? g.saves.data.player.name : 'Stalker';
    const portraitBox = el('div', 'inv-portrait');
    void prepareCharacterArt(g.content, g.sheets, ch.raceId, eq).then(() => {
      portraitBox.replaceChildren(drawPortrait(g.content, g.sheets, ch.raceId, ch.colors, eq));
    });
    const slots = el('div', 'inv-slots');
    for (const { slot, label } of SLOTS) {
      const item = eq[slot];
      const box = el('div', `inv-slot${item ? ' filled' : ''}`, undefined, el('span', 'inv-slot-label', label));
      if (item) {
        box.append(this.cell(item, { from: 'slot', slot }));
      } else {
        box.append(el('div', 'inv-slot-empty', '—'));
      }
      this.dropZone(box, { slot });
      slots.append(box);
    }
    const stats = this.w.req(this.p, Stats);
    const h = this.w.req(this.p, Health);
    const resist = g.content
      .all('stat')
      .filter((s) => s.id.endsWith('_resist') && stats.get(s.id) > 0)
      .map((s) => el('div', 'inv-stat', undefined, el('span', '', s.name.replace(' Resistance', '')), el('span', 'num', `${Math.round(stats.get(s.id) * 100)}%`)));
    panel.append(
      el('h3', '', name),
      portraitBox,
      slots,
      el(
        'div',
        'inv-stats',
        undefined,
        el('div', 'inv-stat', undefined, el('span', '', 'Health'), el('span', 'num', `${Math.ceil(h.hp)} / ${stats.get('max_health')}`)),
        el('div', 'inv-stat', undefined, el('span', '', 'Speed'), el('span', 'num', `${Math.round(stats.get('move_speed'))}`)),
        ...resist,
      ),
    );
    return panel;
  }

  private bagPanel(): HTMLElement {
    const enc = this.w.get(this.p, Encumbrance);
    const weight = enc?.weight ?? inventoryWeight(this.content, this.bag());
    const limit = enc?.limit ?? this.w.req(this.p, Stats).get('carry_weight');
    const frac = Math.min(1.5, weight / Math.max(1, limit));
    const fill = el('div', `inv-weight-fill${weight > limit ? ' over' : ''}`);
    fill.style.width = `${Math.min(100, (frac / 1.5) * 100)}%`;
    const marker = el('div', 'inv-weight-limit');
    marker.style.left = `${(1 / 1.5) * 100}%`;
    const tabs = el(
      'div',
      'inv-tabs',
      undefined,
      ...FILTERS.map(([f, label]) =>
        button(
          label,
          () => {
            this.filter = f;
            this.redraw();
          },
          `btn tab${this.filter === f ? ' on' : ''}`,
        ),
      ),
    );
    const grid = el('div', 'inv-grid');
    for (const item of this.sorted(this.bag())) grid.append(this.cell(item, { from: 'bag' }));
    if (!grid.children.length) grid.append(el('p', 'muted', 'Nothing here.'));
    this.dropZone(grid, 'bag');
    const panel = el(
      'section',
      'inv-bag',
      undefined,
      el('div', 'inv-head', undefined, el('h3', '', 'Backpack'), el('span', `inv-weight-text${weight > limit ? ' over' : ''}`, `${weight.toFixed(1)} / ${limit.toFixed(0)} kg`)),
      el('div', 'inv-weight', undefined, fill, marker),
      tabs,
      grid,
      el('p', 'inv-hint muted', 'Double-click: equip / use · Shift-click: move · Drag outside to drop · Tab / Esc: close'),
    );
    return panel;
  }

  private containerPanel(): HTMLElement {
    const c = this.w.req(this.container!, Container);
    const grid = el('div', 'inv-grid');
    for (const item of this.sorted(c.items ?? [])) grid.append(this.cell(item, { from: 'container' }));
    if (!grid.children.length) grid.append(el('p', 'muted', 'Empty.'));
    this.dropZone(grid, 'container');
    const takeAll = button('Take all', () => void this.act(() => this.takeAll()), 'btn primary');
    takeAll.disabled = !(c.items?.length ?? 0);
    return el('div', 'inv-container', undefined, el('div', 'inv-head', undefined, el('h3', '', c.label), takeAll), grid);
  }

  private cell(item: ItemInstance, where: Where): HTMLElement {
    const info = this.info(item);
    const cell = el('div', 'inv-cell');
    if (this.selected?.item === item) cell.classList.add('selected');
    const img = this.icon(item.defId, 46);
    img.alt = info?.def.name ?? item.defId;
    img.draggable = false;
    cell.append(img);
    if (countOf(item) > 1) cell.append(el('span', 'inv-count', String(countOf(item))));
    if (info?.kind === 'weapon' || info?.kind === 'armor') {
      const bar = el('div', 'inv-cond');
      bar.style.width = `${Math.round(item.condition * 100)}%`;
      bar.classList.toggle('worn', item.condition < 0.35);
      cell.append(bar);
    }
    if (info?.kind === 'armor' && fitsPlayer(this.content, this.w, this.p, info) === false) cell.classList.add('unfit');
    cell.title = info?.def.name ?? item.defId;
    cell.draggable = true;
    cell.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', JSON.stringify({ uid: item.uid, where }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    cell.addEventListener('mouseenter', () => {
      this.hovered = { item, where };
      this.refreshDetails();
    });
    cell.addEventListener('mouseleave', () => {
      this.hovered = null;
      this.refreshDetails();
    });
    cell.addEventListener('click', (e) => {
      if (e.shiftKey && this.container !== null && where.from !== 'slot') {
        void (where.from === 'bag' ? this.act(() => this.store(item)) : this.act(() => this.take(item)));
        return;
      }
      this.selected = { item, where };
      this.redraw();
    });
    cell.addEventListener('dblclick', () => void this.primary(item, where));
    return cell;
  }

  /** Item icon scaled by the largest whole number that fits `box` px (keeps pixels crisp). */
  private icon(defId: string, box: number): HTMLImageElement {
    const px = this.game.icons.get(defId);
    const scale = Math.max(1, Math.min(4, Math.floor(box / Math.max(px.width, px.height))));
    const img = el('img', 'pixel-icon');
    img.src = this.game.icons.url(defId);
    img.width = px.width * scale;
    img.height = px.height * scale;
    return img;
  }

  private dropZone(zone: HTMLElement, target: 'bag' | 'container' | { slot: EquipmentSlot }): void {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drop-hover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-hover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('drop-hover');
      const src = this.readDrag(e);
      if (src) void this.dropOn(target, src);
    });
  }

  private readDrag(e: DragEvent): { item: ItemInstance; where: Where } | null {
    try {
      const { uid, where } = JSON.parse(e.dataTransfer?.getData('text/plain') ?? '') as { uid: string; where: Where };
      const pool = where.from === 'bag' ? this.bag() : where.from === 'container' ? (this.crate() ?? []) : Object.values(this.eq());
      const item = pool.find((it) => it?.uid === uid);
      return item ? { item, where } : null;
    } catch {
      return null;
    }
  }

  private detailsBox: HTMLElement | null = null;

  private refreshDetails(): void {
    if (!this.detailsBox) return;
    this.detailsBox.replaceWith(this.detailsPanel());
  }

  private detailsPanel(): HTMLElement {
    const box = el('div', 'inv-details');
    this.detailsBox = box;
    const focus = this.hovered ?? this.selected;
    if (!focus) {
      box.append(el('p', 'muted', 'Hover or select an item to see its details.'));
      return box;
    }
    const { item, where } = focus;
    const info = this.info(item);
    if (!info) {
      box.append(el('p', 'muted', `Unknown item "${item.defId}" (removed from the game?).`));
      return box;
    }
    const img = this.icon(item.defId, 60);
    img.classList.add('inv-detail-icon');
    box.append(el('div', 'inv-detail-head', undefined, img, el('div', '', undefined, el('h3', '', info.def.name), el('div', 'muted', kindLabel(info)))));
    if (info.def.description) box.append(el('p', 'inv-desc', info.def.description));
    box.append(this.statsTable(item, info, where));

    // Actions for the selected item (not just hovered).
    if (this.selected?.item === item) {
      const actions = el('div', 'row inv-actions');
      if (where.from === 'container') actions.append(button('Take', () => void this.act(() => this.take(item)), 'btn primary'));
      if (where.from === 'slot') actions.append(button('Unequip', () => void this.act(() => this.unequip(where.slot))));
      if (where.from === 'bag') {
        if (info.kind === 'armor' || info.kind === 'weapon') actions.append(button('Equip', () => void this.act(() => this.equip(item)), 'btn primary'));
        if (info.kind === 'consumable') actions.append(button('Use', () => void this.act(() => this.use(item)), 'btn primary'));
        if (this.container !== null) actions.append(button('Store', () => void this.act(() => this.store(item))));
      }
      if (info.kind === 'weapon' && (item.loaded ?? 0) > 0 && where.from !== 'container') {
        actions.append(button('Unload', () => void this.act(() => (unloadWeapon(this.w, this.content, this.p, item), null))));
      }
      if (where.from !== 'container') actions.append(button('Drop', () => void this.act(() => this.drop(item, where)), 'btn danger'));
      box.append(actions);
    }
    return box;
  }

  private statsTable(item: ItemInstance, info: ItemInfo, where: Where): HTMLElement {
    const rows: [string, string, number?][] = [];
    const eq = this.eq();
    if (info.kind === 'weapon') {
      const d = info.def;
      const other = where.from !== 'slot' ? eq[d.slot] : undefined;
      const od = other && this.content.tryGet('weapon', other.defId);
      const cmp = (a: number, b: number | undefined) => (od && b !== undefined ? a - b : undefined);
      rows.push(['Slot', d.slot === 'primary' ? 'Primary' : 'Sidearm']);
      rows.push(['Damage', d.pellets > 1 ? `${d.damage} × ${d.pellets}` : `${d.damage}`, cmp(d.damage * d.pellets, od && od.damage * od.pellets)]);
      rows.push(['Fire rate', `${d.fireRate} rpm (${d.fireMode})`, cmp(d.fireRate, od?.fireRate)]);
      rows.push(['Magazine', `${d.magazine}`, cmp(d.magazine, od?.magazine)]);
      rows.push(['Spread', `${d.spread}°`, od ? -(d.spread - od.spread) : undefined]);
      rows.push(['Range', `${Math.round(d.range / 32)} tiles`, cmp(d.range, od?.range)]);
      rows.push(['Armor piercing', `${Math.round(d.armorPiercing * 100)}%`, cmp(d.armorPiercing, od?.armorPiercing)]);
      rows.push(['Reload', `${d.reloadTime}s`, od ? -(d.reloadTime - od.reloadTime) : undefined]);
      const ammo = item.loadedAmmo && this.content.tryGet('ammo', item.loadedAmmo);
      rows.push(['Loaded', `${item.loaded ?? 0}${ammo ? ` × ${ammo.caliber}` : ''}`]);
      rows.push(['Takes', d.ammo.map((a) => this.content.tryGet('ammo', a)?.caliber ?? a).join(', ')]);
      rows.push(['Condition', `${Math.round(item.condition * 100)}%`]);
    } else if (info.kind === 'armor') {
      const d = info.def;
      const race = this.content.all('race').find((r) => r.armorTag === d.fitsRace);
      rows.push(['Fits', race?.name ?? d.fitsRace]);
      const other = where.from !== 'slot' ? eq[d.slot] : undefined;
      const od = other && this.content.tryGet('armor', other.defId);
      const value = (def: typeof d, it: ItemInstance, stat: string) =>
        def.modifiers
          .filter((m) => m.stat === stat)
          .reduce((s, m) => s + (this.content.tryGet('stat', m.stat)?.scalesWithCondition && m.op === 'flat' ? m.value * conditionFactor(it.condition) : m.value), 0);
      const stats = new Set([...d.modifiers.map((m) => m.stat), ...(od?.modifiers.map((m) => m.stat) ?? [])]);
      for (const stat of stats) {
        const sd = this.content.tryGet('stat', stat);
        const mine = value(d, item, stat);
        const theirs = od && other ? value(od, other, stat) : undefined;
        const pct = sd?.format === 'percent' || d.modifiers.find((m) => m.stat === stat)?.op === 'percent';
        rows.push([sd?.name ?? stat, pct ? `${mine >= 0 ? '+' : ''}${Math.round(mine * 100)}%` : `${mine >= 0 ? '+' : ''}${Math.round(mine * 10) / 10}`, theirs !== undefined ? mine - theirs : undefined]);
      }
      rows.push(['Condition', `${Math.round(item.condition * 100)}%`]);
    } else if (info.kind === 'ammo') {
      const d = info.def;
      rows.push(['Caliber', d.caliber]);
      if (d.damageMult !== 1) rows.push(['Damage', `×${d.damageMult}`]);
      if (d.apBonus) rows.push(['Armor piercing', `${d.apBonus > 0 ? '+' : ''}${Math.round(d.apBonus * 100)}%`]);
      rows.push(['Rounds', `${countOf(item)}`]);
    } else {
      const fx = info.def.effects;
      if (fx.heal) rows.push(['Heals', `${fx.heal}`]);
      if (fx.healOverTime) rows.push(['Heals over time', `${fx.healOverTime.amount} over ${fx.healOverTime.seconds}s`]);
      if (fx.stopBleed) rows.push(['Stops bleeding', `${fx.stopBleed}/s`]);
      if (fx.stamina) rows.push(['Stamina', `+${fx.stamina}`]);
      rows.push(['Count', `${countOf(item)}`]);
    }
    const weight = info.def.weight * countOf(item);
    rows.push(['Weight', `${weight < 1 ? weight.toFixed(2) : weight.toFixed(1)} kg`]);
    rows.push(['Value', `${Math.round(info.def.value * countOf(item))} cr`]);
    return el(
      'div',
      'inv-table',
      undefined,
      ...rows.flatMap(([k, v, delta]) => {
        const val = el('span', 'num', v);
        if (delta !== undefined && Math.abs(delta) > 1e-6) {
          val.append(el('span', delta > 0 ? 'better' : 'worse', ` ${delta > 0 ? '▲' : '▼'}`));
        }
        return [el('span', '', k), val];
      }),
    );
  }
}

function kindLabel(info: ItemInfo): string {
  switch (info.kind) {
    case 'weapon':
      return `Weapon · ${info.def.slot}`;
    case 'armor':
      return `Armor · ${info.def.slot === 'torso' ? 'top + gloves' : info.def.slot === 'legs' ? 'pants + boots' : 'head'}`;
    case 'ammo':
      return 'Ammunition';
    case 'consumable':
      return info.def.category === 'medical' ? 'Medical' : 'Food';
  }
}

function fitsPlayer(content: Game['content'], world: World, p: Entity, info: ItemInfo): boolean | null {
  if (info.kind !== 'armor') return null;
  return content.get('race', world.req(p, Character).raceId).armorTag === info.def.fitsRace;
}
