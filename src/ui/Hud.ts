import { el } from './dom';

export interface HudState {
  hp: number;
  maxHp: number;
  bleed: number;
  stamina: number;
  maxStamina: number;
  exhausted: boolean;
  weapon: null | {
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
  };
  armor: { slot: string; name: string; condition: number }[];
}

/** In-game HUD (DOM over the canvas). Only touches the DOM when a value changes. */
export class Hud {
  readonly root = el('div', 'hud');
  private vignette = el('div', 'hud-vignette');
  private hpFill = el('div', 'hud-fill hp');
  private hpText = el('span', 'hud-num');
  private bleed = el('span', 'hud-bleed');
  private stFill = el('div', 'hud-fill st');
  private weaponBox = el('div', 'hud-weapon');
  private wName = el('div', 'hud-wname');
  private wAmmo = el('div', 'hud-ammo');
  private wInfo = el('div', 'hud-winfo');
  private wReload = el('div', 'hud-fill reload');
  private armorBox = el('div', 'hud-armor');
  private last = new Map<string, string>();
  private hurt = 0;

  constructor(parent: HTMLElement) {
    const vitals = el(
      'div',
      'hud-vitals',
      undefined,
      el('div', 'hud-row', undefined, el('span', 'hud-label', 'HP'), el('div', 'hud-bar', undefined, this.hpFill), this.hpText, this.bleed),
      el('div', 'hud-row', undefined, el('span', 'hud-label', 'ST'), el('div', 'hud-bar thin', undefined, this.stFill)),
      this.armorBox,
    );
    this.weaponBox.append(this.wName, this.wAmmo, this.wInfo, el('div', 'hud-bar thin', undefined, this.wReload));
    this.root.append(this.vignette, vitals, this.weaponBox);
    parent.append(this.root);
  }

  /** Red flash proportional to damage taken. */
  damage(amount: number): void {
    this.hurt = Math.min(1, this.hurt + 0.25 + amount / 40);
  }

  update(s: HudState, dt: number): void {
    const hpFrac = Math.max(0, s.hp / Math.max(1, s.maxHp));
    this.set('hpw', `${(hpFrac * 100).toFixed(1)}%`, () => (this.hpFill.style.width = `${(hpFrac * 100).toFixed(1)}%`));
    this.set('hpt', `${Math.ceil(s.hp)}`, (v) => (this.hpText.textContent = v));
    this.set('bleed', s.bleed > 0.05 ? `● bleeding ${s.bleed.toFixed(1)}/s` : '', (v) => (this.bleed.textContent = v));
    const stFrac = Math.max(0, s.stamina / Math.max(1, s.maxStamina));
    this.set('stw', `${(stFrac * 100).toFixed(1)}`, () => (this.stFill.style.width = `${(stFrac * 100).toFixed(1)}%`));
    this.set('stx', String(s.exhausted), (v) => this.stFill.classList.toggle('exhausted', v === 'true'));

    const w = s.weapon;
    this.set('wvis', w ? '1' : '0', (v) => (this.weaponBox.style.display = v === '1' ? '' : 'none'));
    if (w) {
      this.set('wname', `${w.slot === 'primary' ? '[1]' : '[2]'} ${w.name}`, (v) => (this.wName.textContent = v));
      this.set('wammo', `${w.loaded} / ${w.reserve}`, (v) => (this.wAmmo.textContent = v));
      this.set('wempty', String(w.loaded === 0), (v) => this.wAmmo.classList.toggle('empty', v === 'true'));
      this.set('winfo', `${w.caliber} · ${w.fireMode} · ${Math.round(w.condition * 100)}%`, (v) => (this.wInfo.textContent = v));
      const r = w.reload === null ? 0 : w.reload;
      this.set('wrel', r.toFixed(2), () => (this.wReload.style.width = `${(r * 100).toFixed(0)}%`));
    }
    this.set(
      'armor',
      s.armor.map((a) => `${a.slot}:${Math.round(a.condition * 100)}`).join(','),
      () =>
        this.armorBox.replaceChildren(
          ...s.armor.map((a) => {
            const pct = Math.round(a.condition * 100);
            const chip = el('span', `hud-chip${pct < 35 ? ' worn' : ''}`, `${a.slot} ${pct}%`);
            chip.title = a.name;
            return chip;
          }),
        ),
    );

    // Damage flash fades; low health keeps a pulse.
    this.hurt = Math.max(0, this.hurt - dt * 1.8);
    const low = hpFrac < 0.25 && s.hp > 0 ? 0.25 + 0.15 * Math.sin(performance.now() / 180) : 0;
    this.vignette.style.opacity = Math.max(this.hurt, low).toFixed(2);
  }

  destroy(): void {
    this.root.remove();
  }

  private set(key: string, value: string, apply: (v: string) => void): void {
    if (this.last.get(key) === value) return;
    this.last.set(key, value);
    apply(value);
  }
}
