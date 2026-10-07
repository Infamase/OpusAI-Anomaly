import { DANGEROUS_DOSE, SAFE_DOSE } from '../game/radiation';
import { el } from './dom';
import { Minimap } from './Minimap';

export interface HudWeapon {
  name: string;
  slot: 'primary' | 'sidearm';
  loaded: number;
  magazine: number;
  reserve: number;
  caliber: string;
  fireMode: string;
  condition: number;
  /** 0..1 while reloading, null otherwise. */
  reload: number | null;
}

/** What the carried detector says: nearest artifact distance in tiles (null = nothing in range), and which way (if it can tell). */
export interface DetectorReading {
  name: string;
  distance: number | null;
  angle: number | null;
}

export interface HudState {
  hp: number;
  maxHp: number;
  bleed: number;
  /** Radiation dose. */
  rads: number;
  /** A heal-over-time effect is running. */
  healing: boolean;
  stamina: number;
  maxStamina: number;
  exhausted: boolean;
  /** Carried weight; level 1 = overloaded, 2 = barely moving. */
  load: { weight: number; limit: number; level: 0 | 1 | 2 };
  /** Medical items the quick-heal key can use. */
  meds: number;
  weapon: HudWeapon | null;
  /** The other weapon slot, if anything is in it. */
  holstered: { slot: 'primary' | 'sidearm'; name: string; loaded: number } | null;
  armor: { slot: string; name: string; condition: number }[];
  /** What the throw (F) and place (V) keys would use, and how many. */
  explosives?: { throwable: { name: string; count: number } | null; placeable: { name: string; count: number } | null };
}

/** A live grenade near the player: screen angle (0 = right) and how urgent (0..1, 1 = about to go, right here). */
export interface GrenadeWarning {
  angle: number;
  urgency: number;
}

/** Rounds drawn as individual pips up to this magazine size; bigger magazines get a bar. */
const MAX_PIPS = 40;
const LOW_AMMO = 0.3;
const DAMAGE_ARC_TIME = 1.3;

/**
 * In-game HUD (DOM over the canvas): vitals and status effects bottom-left,
 * weapon bottom-right, minimap top-right, damage direction around the
 * player, prompts and notices. Only touches the DOM when a value changes.
 */
export class Hud {
  readonly root = el('div', 'hud');
  readonly minimap = new Minimap();
  private vignette = el('div', 'hud-vignette');
  private arcs = el('div', 'hud-arcs');
  private hpFill = el('div', 'hud-fill hp');
  private hpTrail = el('div', 'hud-fill trail');
  private hpText = el('span', 'hud-num');
  private stFill = el('div', 'hud-fill st');
  private status = el('div', 'hud-status');
  private meds = el('div', 'hud-meds');
  private armorBox = el('div', 'hud-armor');
  private weaponBox = el('div', 'hud-weapon');
  private wName = el('div', 'hud-wname');
  private wAmmo = el('div', 'hud-ammo');
  private wPips = el('div', 'hud-pips');
  private wInfo = el('div', 'hud-winfo');
  private wHint = el('div', 'hud-whint');
  private wReload = el('div', 'hud-fill reload');
  private wOther = el('div', 'hud-wother');
  private wBombs = el('div', 'hud-bombs');
  private grenades = el('div', 'hud-grenades');
  private promptEl = el('div', 'hud-prompt');
  private messages = el('div', 'hud-messages');
  private where = el('div', 'hud-where');
  private detectorBox = el('div', 'hud-detector');
  private last = new Map<string, string>();
  private hurt = 0;
  private trail = 1;
  private trailHold = 0;

  constructor(parent: HTMLElement) {
    const vitals = el(
      'div',
      'hud-panel hud-vitals',
      undefined,
      this.status,
      el('div', 'hud-row', undefined, el('span', 'hud-label', 'HP'), el('div', 'hud-bar', undefined, this.hpTrail, this.hpFill), this.hpText),
      el('div', 'hud-row', undefined, el('span', 'hud-label', 'ST'), el('div', 'hud-bar thin', undefined, this.stFill)),
      el('div', 'hud-row hud-foot', undefined, this.armorBox, this.meds),
    );
    this.weaponBox.append(this.wOther, this.wName, el('div', 'hud-ammo-row', undefined, this.wPips, this.wAmmo), this.wInfo, el('div', 'hud-bar thin', undefined, this.wReload), this.wHint, this.wBombs);
    this.weaponBox.className = 'hud-panel hud-weapon';
    this.minimap.root.append(this.where, this.detectorBox);
    this.arcs.append(this.grenades);
    this.root.append(this.vignette, this.arcs, this.minimap.root, vitals, this.weaponBox, this.promptEl, this.messages);
    parent.append(this.root);
  }

  /** Where the player is, under the minimap ("Pine Forest", "Rookie Village"). */
  location(text: string): void {
    this.set('where', text, (v) => (this.where.textContent = v));
  }

  /** The detector widget under the minimap (null hides it). */
  detector(r: DetectorReading | null): void {
    const sig = r?.distance == null ? 0 : Math.max(1, Math.min(5, Math.ceil(5 - r.distance / 4.5)));
    const key = r ? `${r.name}|${sig}|${r.distance == null ? '' : Math.round(r.distance)}|${r.angle == null ? '' : Math.round(r.angle * 8)}` : '';
    this.set('detector', key, () => {
      if (!r) {
        this.detectorBox.replaceChildren();
        return;
      }
      const bars = el('span', 'hud-det-bars');
      for (let i = 1; i <= 5; i++) bars.append(el('i', i <= sig ? 'on' : ''));
      // Model name only ("Echo"), the widget is narrow.
      const name = el('span', 'hud-det-name', r.name.replace(/\s*detector\s*/i, '') || r.name);
      name.title = r.name;
      const parts: (HTMLElement | string)[] = [name, bars];
      if (r.distance != null) parts.push(el('span', 'hud-det-dist', `${Math.round(r.distance)} m`));
      else parts.push(el('span', 'hud-det-dist none', 'no signal'));
      if (r.angle != null) {
        const arrow = el('span', 'hud-det-arrow', '➤');
        arrow.style.transform = `rotate(${r.angle}rad)`;
        parts.push(arrow);
      }
      this.detectorBox.replaceChildren(...parts);
    });
  }

  /** Interaction hint, e.g. "E  Pick up Bandage" (null hides it). The key before the double space becomes a keycap. */
  prompt(text: string | null): void {
    this.set('prompt', text ?? '', (v) => {
      const m = /^(\S+) {2}(.*)$/.exec(v);
      this.promptEl.replaceChildren(...(m ? [el('kbd', 'hud-key', m[1]), m[2]!] : [v]));
      this.promptEl.style.display = v ? '' : 'none';
    });
  }

  /** Short notice above the vitals that fades out ("Picked up...", "Killed ..."). */
  message(text: string, color?: string): void {
    const m = el('div', 'hud-message', text);
    if (color) m.style.color = color;
    this.messages.append(m);
    while (this.messages.children.length > 5) this.messages.firstElementChild?.remove();
    setTimeout(() => m.classList.add('fade'), 2600);
    setTimeout(() => m.remove(), 3300);
  }

  /**
   * Red flash proportional to damage taken, plus an arc around the player
   * pointing toward where it came from (`from`: screen angle, 0 = right).
   */
  damage(amount: number, from?: number): void {
    this.hurt = Math.min(1, this.hurt + 0.25 + amount / 40);
    if (from === undefined) return;
    const arc = el('div', 'hud-arc');
    arc.style.transform = `translate(-50%, -50%) rotate(${from + Math.PI / 2}rad)`;
    arc.style.opacity = String(Math.min(1, 0.55 + amount / 30));
    arc.style.animationDuration = `${DAMAGE_ARC_TIME}s`;
    this.arcs.append(arc);
    while (this.arcs.children.length > 6) this.arcs.firstElementChild?.remove();
    setTimeout(() => arc.remove(), DAMAGE_ARC_TIME * 1000);
  }

  /** Grenade icons around the player pointing at live grenades nearby (empty list hides them). */
  grenadeWarnings(list: GrenadeWarning[]): void {
    const shown = list.slice(0, 3);
    while (this.grenades.children.length < shown.length) {
      const icon = el('div', 'hud-grenade');
      icon.innerHTML = GRENADE_ICON;
      this.grenades.append(icon);
    }
    while (this.grenades.children.length > shown.length) this.grenades.lastElementChild?.remove();
    shown.forEach((w, i) => {
      const n = this.grenades.children[i] as HTMLElement;
      const r = 70;
      n.style.transform = `translate(${Math.cos(w.angle) * r}px, ${Math.sin(w.angle) * r}px) translate(-50%, -50%) scale(${(0.9 + w.urgency * 0.5).toFixed(2)})`;
      n.style.animationDuration = `${(0.7 - w.urgency * 0.5).toFixed(2)}s`;
    });
  }

  /** `anchor`: the player's chest on screen, in CSS pixels (damage arcs center on it). */
  update(s: HudState, dt: number, anchor?: { x: number; y: number }): void {
    if (anchor) this.set('anchor', `${Math.round(anchor.x)},${Math.round(anchor.y)}`, () => (this.arcs.style.transform = `translate(${anchor.x}px, ${anchor.y}px)`));

    // Health, with a pale trail showing what was just lost.
    const hpFrac = Math.max(0, s.hp / Math.max(1, s.maxHp));
    if (hpFrac >= this.trail) {
      this.trail = hpFrac;
      this.trailHold = 0.5;
    } else if (this.trailHold > 0) this.trailHold -= dt;
    else this.trail = Math.max(hpFrac, this.trail - dt * 0.6);
    this.set('hpw', pct(hpFrac), (v) => (this.hpFill.style.width = v));
    this.set('hptr', pct(this.trail), (v) => (this.hpTrail.style.width = v));
    this.set('hpt', `${Math.ceil(s.hp)}`, (v) => (this.hpText.textContent = v));
    this.set('hplow', String(hpFrac < 0.3), (v) => this.hpFill.classList.toggle('low', v === 'true'));
    const stFrac = Math.max(0, s.stamina / Math.max(1, s.maxStamina));
    this.set('stw', pct(stFrac), (v) => (this.stFill.style.width = v));
    this.set('stx', String(s.exhausted), (v) => this.stFill.classList.toggle('exhausted', v === 'true'));

    // Status effects.
    const chips: [string, string][] = [];
    if (s.bleed > 0.05) chips.push(['bleed', `Bleeding ${s.bleed.toFixed(1)}/s`]);
    if (s.rads >= 5) chips.push([s.rads >= DANGEROUS_DOSE ? 'rad danger' : s.rads > SAFE_DOSE ? 'rad' : 'rad low', `Radiation ${Math.round(s.rads)}`]);
    if (s.healing) chips.push(['heal', 'Healing']);
    if (s.exhausted) chips.push(['tired', 'Exhausted']);
    if (s.load.level > 0) chips.push(['load', `${s.load.level === 2 ? 'Immobile' : 'Overloaded'} ${s.load.weight.toFixed(1)}/${s.load.limit.toFixed(0)} kg`]);
    this.set('status', chips.map((c) => c.join(':')).join('|'), () =>
      this.status.replaceChildren(...chips.map(([cls, text]) => el('span', `hud-effect ${cls}`, text))),
    );
    this.set('meds', String(s.meds), (v) =>
      this.meds.replaceChildren(el('kbd', 'hud-key small', 'H'), el('span', s.meds ? '' : 'none', s.meds ? `Meds ×${v}` : 'No meds')),
    );
    this.set(
      'armor',
      s.armor.map((a) => `${a.slot}:${Math.round(a.condition * 100)}`).join(','),
      () =>
        this.armorBox.replaceChildren(
          ...s.armor.map((a) => {
            const p = Math.round(a.condition * 100);
            const chip = el('span', `hud-chip${p < 35 ? ' worn' : ''}`, `${a.slot} ${p}%`);
            chip.title = a.name;
            return chip;
          }),
        ),
    );

    this.updateWeapon(s);
    const ex = s.explosives;
    this.set('bombs', ex ? `${ex.throwable?.name}|${ex.throwable?.count}|${ex.placeable?.name}|${ex.placeable?.count}` : '', () => {
      const parts: (HTMLElement | string)[] = [];
      if (ex?.throwable) parts.push(el('span', '', undefined, el('kbd', 'hud-key small', 'F'), `${ex.throwable.name} ×${ex.throwable.count}`));
      if (ex?.placeable) parts.push(el('span', '', undefined, el('kbd', 'hud-key small', 'V'), `${ex.placeable.name} ×${ex.placeable.count}`));
      this.wBombs.replaceChildren(...parts);
    });

    // Damage flash fades; low health keeps a pulse.
    this.hurt = Math.max(0, this.hurt - dt * 1.8);
    const low = hpFrac < 0.25 && s.hp > 0 ? 0.25 + 0.15 * Math.sin(performance.now() / 180) : 0;
    this.vignette.style.opacity = Math.max(this.hurt, low).toFixed(2);
  }

  destroy(): void {
    this.root.remove();
  }

  private updateWeapon(s: HudState): void {
    const w = s.weapon;
    this.set('wvis', w ? '1' : '0', (v) => (this.weaponBox.style.display = v === '1' ? '' : 'none'));
    const o = s.holstered;
    this.set('wother', o ? `${o.slot === 'primary' ? 1 : 2}|${o.name}|${o.loaded}` : '', () =>
      this.wOther.replaceChildren(...(o ? [el('kbd', 'hud-key small', o.slot === 'primary' ? '1' : '2'), `${o.name} · ${o.loaded}`] : [])),
    );
    if (!w) return;
    this.set('wname', `${w.slot}|${w.name}`, () => this.wName.replaceChildren(el('kbd', 'hud-key small', w.slot === 'primary' ? '1' : '2'), w.name));
    this.set('wammo', `${w.loaded}|${w.reserve}`, () => this.wAmmo.replaceChildren(el('b', '', String(w.loaded)), el('span', 'hud-reserve', ` / ${w.reserve}`)));
    const frac = w.loaded / Math.max(1, w.magazine);
    const state = w.loaded === 0 ? 'empty' : frac <= LOW_AMMO ? 'low' : '';
    this.set('wstate', state, (v) => {
      this.wAmmo.classList.toggle('empty', v === 'empty');
      this.wAmmo.classList.toggle('low', v === 'low');
    });
    this.set('wpips', `${w.loaded}/${w.magazine}`, () => {
      if (w.magazine > MAX_PIPS) {
        const bar = el('div', 'hud-pipbar', undefined, el('div', `hud-pipfill ${state}`));
        (bar.firstChild as HTMLElement).style.width = pct(frac);
        this.wPips.replaceChildren(bar);
        return;
      }
      const pips: HTMLElement[] = [];
      for (let i = 0; i < w.magazine; i++) pips.push(el('i', i < w.loaded ? `on ${state}` : ''));
      this.wPips.replaceChildren(...pips);
    });
    this.set('winfo', `${w.caliber} · ${w.fireMode} · ${Math.round(w.condition * 100)}%`, (v) => (this.wInfo.textContent = v));
    this.set('wworn', String(w.condition < 0.35), (v) => this.wInfo.classList.toggle('worn', v === 'true'));
    const r = w.reload ?? 0;
    this.set('wrel', r.toFixed(2), () => (this.wReload.style.width = pct(r)));
    const hint = w.reload !== null ? 'Reloading…' : w.loaded === 0 ? (w.reserve > 0 ? 'R|Reload' : 'No ammo') : frac <= LOW_AMMO && w.reserve > 0 ? 'R|Low ammo' : '';
    this.set('whint', hint, (v) => {
      const [key, text] = v.includes('|') ? v.split('|') : [null, v];
      this.wHint.replaceChildren(...(key ? [el('kbd', 'hud-key small', key), text!] : [text!]));
      this.wHint.className = `hud-whint ${w.loaded === 0 && w.reserve === 0 && w.reload === null ? 'out' : ''}`;
    });
  }

  private set(key: string, value: string, apply: (v: string) => void): void {
    if (this.last.get(key) === value) return;
    this.last.set(key, value);
    apply(value);
  }
}

/** A little grenade for the warning markers. */
const GRENADE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16"><ellipse cx="7" cy="10" rx="4.6" ry="5" fill="#3a4630" stroke="#141810"/><rect x="5" y="2.5" width="4" height="3" fill="#a8a89c"/><path d="M9 3.5 L12.5 9" stroke="#a8a89c" stroke-width="1.6"/><circle cx="4" cy="3" r="1.4" fill="none" stroke="#c8c8bc"/></svg>';

const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`;
