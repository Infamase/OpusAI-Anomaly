import { clampLength, type Vec2 } from '../core/math';
import type { ButtonAction, InputSource, SourceState } from './actions';

/**
 * iPad / touchscreen controls: twin floating joysticks plus action buttons.
 *
 * - Left half of the screen: touch anywhere to spawn the move stick under your thumb.
 * - Right half: aim stick. Pushing it past the outer ring fires (twin-stick style).
 * - Buttons: reload, use, sprint (toggle), bag, pause.
 *
 * Built from DOM elements so it stays crisp at any resolution and respects the
 * iPad safe areas; it sits on top of the game canvas.
 */
interface StickState {
  pointerId: number | null;
  origin: Vec2;
  offset: Vec2;
  el: HTMLElement;
  knob: HTMLElement;
}

const STICK_RADIUS = 56; // CSS px
const AIM_DEADZONE = 0.25;
const FIRE_THRESHOLD = 0.85;

const BUTTONS: { action: ButtonAction; label: string; toggle?: boolean; cls: string }[] = [
  { action: 'reload', label: 'RLD', cls: 'btn-reload' },
  { action: 'interact', label: 'USE', cls: 'btn-interact' },
  { action: 'sprint', label: 'RUN', cls: 'btn-sprint', toggle: true },
  { action: 'inventory', label: 'BAG', cls: 'btn-inventory' },
  { action: 'pause', label: '❚❚', cls: 'btn-pause' },
  { action: 'debugToggle', label: 'DEV', cls: 'btn-debug' },
];

const isTouch = (e: PointerEvent) => e.pointerType === 'touch' || e.pointerType === 'pen';

export class TouchSource implements InputSource {
  readonly device = 'touch' as const;
  lastActivity = 0;
  readonly root: HTMLElement;

  private move: StickState;
  private aim: StickState;
  private held = new Set<ButtonAction>();
  private tapped = new Set<ButtonAction>();
  private toggled = new Set<ButtonAction>();
  private cleanup: (() => void)[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.innerHTML = `
      <div class="touch-zone zone-move"></div>
      <div class="touch-zone zone-aim"></div>
      <div class="stick stick-move"><div class="stick-ring"></div><div class="knob"></div></div>
      <div class="stick stick-aim"><div class="stick-ring fire-ring"></div><div class="knob"></div></div>
      ${BUTTONS.map((b) => `<button class="touch-btn ${b.cls}" data-action="${b.action}">${b.label}</button>`).join('')}
    `;
    parent.appendChild(this.root);

    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.move = { pointerId: null, origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, el: q('.stick-move'), knob: q('.stick-move .knob') };
    this.aim = { pointerId: null, origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, el: q('.stick-aim'), knob: q('.stick-aim .knob') };
    this.bindStick(q('.zone-move'), this.move, true);
    this.bindStick(q('.zone-aim'), this.aim, false);

    for (const def of BUTTONS) {
      const el = this.root.querySelector(`[data-action="${def.action}"]`) as HTMLElement;
      this.listen(el, 'pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.activity();
        this.tapped.add(def.action);
        if (def.toggle) {
          if (this.toggled.has(def.action)) this.toggled.delete(def.action);
          else this.toggled.add(def.action);
          el.classList.toggle('on', this.toggled.has(def.action));
        } else {
          this.held.add(def.action);
          el.classList.add('on');
        }
      });
      const release = () => {
        if (def.toggle) return;
        this.held.delete(def.action);
        el.classList.remove('on');
      };
      this.listen(el, 'pointerup', release);
      this.listen(el, 'pointercancel', release);
      this.listen(el, 'pointerleave', release);
    }

    // Block iOS gestures (pinch-zoom, double-tap zoom, rubber-banding) over the game.
    this.listen(this.root, 'touchstart', (e: TouchEvent) => e.preventDefault());
    this.listen(document, 'gesturestart', (e: Event) => e.preventDefault());
  }

  set visible(on: boolean) {
    this.root.classList.toggle('visible', on);
  }

  poll(): SourceState {
    const move = this.stickValue(this.move);
    const aim = this.stickValue(this.aim);
    const buttons = new Set<ButtonAction>([...this.held, ...this.tapped, ...this.toggled]);
    this.tapped.clear();

    const aimLen = Math.hypot(aim.x, aim.y);
    if (aimLen >= FIRE_THRESHOLD) buttons.add('fire');
    this.aim.el.classList.toggle('firing', aimLen >= FIRE_THRESHOLD);

    return {
      move,
      aim: aimLen >= AIM_DEADZONE ? { kind: 'direction', dir: aim } : { kind: 'none' },
      buttons,
    };
  }

  reset(): void {
    for (const s of [this.move, this.aim]) this.endStick(s);
    this.held.clear();
    this.tapped.clear();
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.root.remove();
  }

  private stickValue(s: StickState): Vec2 {
    if (s.pointerId === null) return { x: 0, y: 0 };
    return clampLength({ x: s.offset.x / STICK_RADIUS, y: s.offset.y / STICK_RADIUS }, 1);
  }

  private bindStick(zone: HTMLElement, s: StickState, follow: boolean): void {
    this.listen(zone, 'pointerdown', (e: PointerEvent) => {
      if (!isTouch(e) || s.pointerId !== null) return;
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      s.pointerId = e.pointerId;
      s.origin = this.local(e);
      s.offset = { x: 0, y: 0 };
      s.el.classList.add('active');
      this.activity();
      this.drawStick(s);
    });
    this.listen(zone, 'pointermove', (e: PointerEvent) => {
      if (e.pointerId !== s.pointerId) return;
      const p = this.local(e);
      let dx = p.x - s.origin.x;
      let dy = p.y - s.origin.y;
      const len = Math.hypot(dx, dy);
      if (follow && len > STICK_RADIUS) {
        // Drag the base along so the thumb never "falls off" the move stick.
        s.origin.x += (dx / len) * (len - STICK_RADIUS);
        s.origin.y += (dy / len) * (len - STICK_RADIUS);
        dx = p.x - s.origin.x;
        dy = p.y - s.origin.y;
      }
      s.offset = { x: dx, y: dy };
      this.activity();
      this.drawStick(s);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === s.pointerId) this.endStick(s);
    };
    this.listen(zone, 'pointerup', end);
    this.listen(zone, 'pointercancel', end);
  }

  private endStick(s: StickState): void {
    s.pointerId = null;
    s.offset = { x: 0, y: 0 };
    s.el.classList.remove('active', 'firing');
  }

  private drawStick(s: StickState): void {
    s.el.style.transform = `translate(${s.origin.x - STICK_RADIUS}px, ${s.origin.y - STICK_RADIUS}px)`;
    const k = clampLength(s.offset, STICK_RADIUS);
    s.knob.style.transform = `translate(${k.x}px, ${k.y}px)`;
  }

  private local(e: PointerEvent): Vec2 {
    const r = this.root.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private activity(): void {
    this.lastActivity = performance.now();
  }

  private listen<E extends Event>(el: EventTarget, type: string, fn: (e: E) => void): void {
    el.addEventListener(type, fn as EventListener, { passive: false });
    this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
  }
}
