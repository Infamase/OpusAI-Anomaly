import type { AudioVolumes } from '../audio/AudioEngine';
import type { BackendPreference } from '../render/Renderer';

/**
 * Per-device preferences (not part of the save game). Stored in localStorage,
 * which may be unavailable (private browsing), so every access is guarded.
 */
export interface Settings {
  renderer: BackendPreference;
  zoomBias: number;
  showDebug: boolean;
  volume: AudioVolumes;
  muted: boolean;
  /** Lifts the darkness of night and unlit places (0 = as dark as it gets, 1 = much lighter). */
  brightness: number;
}

const KEY = 'sfa-settings';
const DEFAULTS: Settings = {
  renderer: 'webgpu',
  zoomBias: 0,
  showDebug: false,
  volume: { master: 0.8, sfx: 0.9, ambient: 0.7, ui: 0.7, voice: 0.9 },
  muted: false,
  brightness: 0.25,
};

export function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  const s: Settings = { ...DEFAULTS, ...stored, volume: { ...DEFAULTS.volume, ...stored.volume } };
  // URL overrides for testing, e.g. ?renderer=webgl&debug=1
  const params = new URLSearchParams(location.search);
  const r = params.get('renderer');
  if (r === 'webgl' || r === 'webgpu') s.renderer = r;
  if (params.get('debug') === '1') s.showDebug = true;
  if (params.get('mute') === '1') s.muted = true;
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
