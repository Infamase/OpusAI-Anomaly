/** Small DOM helpers shared by menus and overlays. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...children);
  return e;
}

export function button(label: string, onClick: () => void, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export interface ModalButton<T> {
  label: string;
  value: T;
  cls?: string;
}

/**
 * In-game modal dialog. Used instead of window.confirm(), which looks out of
 * place and behaves differently in an iPad home-screen app.
 */
export function modal<T>(root: HTMLElement, title: string, message: string, buttons: ModalButton<T>[]): Promise<T> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal-box', undefined, el('h2', '', title), el('p', '', message));
    const row = el('div', 'modal-buttons');
    for (const b of buttons) {
      row.append(
        button(
          b.label,
          () => {
            overlay.remove();
            resolve(b.value);
          },
          `btn ${b.cls ?? ''}`,
        ),
      );
    }
    box.append(row);
    overlay.append(box);
    root.append(overlay);
    (row.querySelector<HTMLButtonElement>('button.primary') ?? row.querySelector('button'))?.focus();
  });
}

/** Brief message at the bottom of the screen. */
export function toast(root: HTMLElement, message: string, ms = 2600): void {
  const t = el('div', 'toast', message);
  root.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

/** Opens the platform file picker and resolves with the chosen file's text (or null if cancelled). */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = el('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.append(input);
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

/**
 * Hands a file to the user: the share sheet where available (iPad: AirDrop,
 * Save to Files...), otherwise a normal download.
 */
export async function shareOrDownload(filename: string, text: string, mime = 'application/json'): Promise<void> {
  const file = new File([text], filename, { type: mime });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      // Fall through to a download if sharing failed for another reason.
    }
  }
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export function formatPlayTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** File-name-safe version of a character name. */
export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'save';
}
