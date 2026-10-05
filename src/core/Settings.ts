import type { BackendPreference } from '../render/Renderer';

/**
 * Per-device preferences (not part of the save game). Stored in localStorage,
 * which may be unavailable (private browsing), so every access is guarded.
 */
export interface Settings {
  renderer: BackendPreference;
  zoomBias: number;
  showDebug: boolean;
}

const KEY = 'sfa-settings';
const DEFAULTS: Settings = { renderer: 'webgpu', zoomBias: 0, showDebug: false };

export function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  const s: Settings = { ...DEFAULTS, ...stored };
  // URL overrides for testing, e.g. ?renderer=webgl&debug=1
  const params = new URLSearchParams(location.search);
  const r = params.get('renderer');
  if (r === 'webgl' || r === 'webgpu') s.renderer = r;
  if (params.get('debug') === '1') s.showDebug = true;
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
