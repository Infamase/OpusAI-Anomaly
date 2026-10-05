import { normalize } from '../core/math';
import type { ButtonAction, InputSource, SourceState } from './actions';
import { DEFAULT_KEYBOARD, type KeyboardBindings } from './bindings';

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));

export class KeyboardMouseSource implements InputSource {
  readonly device = 'keyboardMouse' as const;
  lastActivity = 0;

  private held = new Set<string>();
  private tapped = new Set<string>();
  private mouseHeld = new Set<number>();
  private mouseTapped = new Set<number>();
  private mouse: { x: number; y: number } | null = null;
  private keyToAction = new Map<string, ButtonAction>();
  /**
   * While true (in gameplay), bound keys are swallowed so Tab/Space/arrows don't
   * move focus or scroll. Menus turn it off so normal keyboard navigation works.
   */
  capture = true;
  private cleanup: (() => void)[] = [];

  constructor(
    private target: HTMLElement,
    private bindings: KeyboardBindings = DEFAULT_KEYBOARD,
  ) {
    for (const [action, codes] of Object.entries(bindings.buttons) as [ButtonAction, string[]][]) {
      for (const code of codes) this.keyToAction.set(code, action);
    }
    const bound = new Set([...bindings.up, ...bindings.down, ...bindings.left, ...bindings.right, ...this.keyToAction.keys()]);

    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (this.capture && bound.has(e.code)) e.preventDefault(); // stop Tab focus-hopping, arrow scrolling, etc.
      if (!e.repeat) this.tapped.add(e.code);
      this.held.add(e.code);
      this.touch();
    });
    this.listen(window, 'keyup', (e: KeyboardEvent) => this.held.delete(e.code));
    this.listen(target, 'pointermove', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = this.localPoint(e);
      this.touch();
    });
    this.listen(target, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      this.mouse = this.localPoint(e);
      this.mouseHeld.add(e.button);
      this.mouseTapped.add(e.button);
      this.touch();
    });
    this.listen(window, 'pointerup', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.mouseHeld.delete(e.button);
    });
    this.listen(target, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(window, 'blur', () => this.reset());
  }

  poll(): SourceState {
    const b = this.bindings;
    const any = (codes: string[]) => codes.some((c) => this.held.has(c) || this.tapped.has(c));
    const x = (any(b.right) ? 1 : 0) - (any(b.left) ? 1 : 0);
    const y = (any(b.down) ? 1 : 0) - (any(b.up) ? 1 : 0);

    const buttons = new Set<ButtonAction>();
    for (const code of [...this.held, ...this.tapped]) {
      const a = this.keyToAction.get(code);
      if (a) buttons.add(a);
    }
    for (const btn of [...this.mouseHeld, ...this.mouseTapped]) {
      const a = b.mouse[btn];
      if (a) buttons.add(a);
    }
    this.tapped.clear();
    this.mouseTapped.clear();

    return {
      move: normalize({ x, y }),
      aim: this.mouse ? { kind: 'point', screen: { ...this.mouse } } : { kind: 'none' },
      buttons,
    };
  }

  reset(): void {
    this.held.clear();
    this.tapped.clear();
    this.mouseHeld.clear();
    this.mouseTapped.clear();
  }

  dispose(): void {
    for (const c of this.cleanup) c();
    this.cleanup = [];
  }

  private touch(): void {
    this.lastActivity = performance.now();
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const r = this.target.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private listen<E extends Event>(el: EventTarget, type: string, fn: (e: E) => void): void {
    el.addEventListener(type, fn as EventListener, { passive: false });
    this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
  }
}
