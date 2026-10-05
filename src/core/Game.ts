import { AudioEngine } from '../audio/AudioEngine';
import { ContentRegistry } from '../content/Registry';
import { bundledContentFiles } from '../content/bundled';
import { loadContent, type LoadReport } from '../content/loader';
import { defineCoreContentTypes } from '../content/types';
import type { InputDevice } from '../input/actions';
import { GamepadSource } from '../input/GamepadSource';
import { InputManager } from '../input/InputManager';
import { KeyboardMouseSource } from '../input/KeyboardMouseSource';
import { Camera } from '../render/Camera';
import { GameRenderer } from '../render/Renderer';
import { SpriteSheetCache } from '../render/SpriteSheets';
import { WeaponArtCache } from '../render/WeaponArt';
import { ItemIcons } from '../render/ItemIcons';
import { openBestBackend } from '../save/backends';
import { SaveManager } from '../save/SaveManager';
import { EventBus } from './EventBus';
import { GameLoop } from './GameLoop';
import { SceneManager } from './Scene';
import { loadSettings, saveSettings, type Settings } from './Settings';

export const GAME_VERSION = '0.4.0';

export interface GameEvents {
  'input:device': InputDevice;
  'debug:toggle': boolean;
  'save:done': { ok: boolean; error?: string };
  'app:hidden': void;
  'app:visible': void;
  'resize': { width: number; height: number };
}

/**
 * Owns every engine service and hands them to scenes. Scenes get the whole
 * Game object as their context; nothing is a global singleton, which keeps
 * systems testable and lets us run several worlds later (e.g. ship + planet).
 */
export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly scenes = new SceneManager();
  readonly camera = new Camera();
  readonly sheets = new SpriteSheetCache();
  readonly weaponArt = new WeaponArtCache();
  readonly content = new ContentRegistry();
  readonly icons = new ItemIcons(this.content, this.sheets);
  readonly settings: Settings;
  readonly audio: AudioEngine;
  renderer!: GameRenderer;
  input!: InputManager;
  saves!: SaveManager;
  contentReport!: LoadReport;
  saveWarning: string | undefined;
  debugVisible = false;
  /** True while a gameplay scene is active: game keys are captured (menus get normal keyboard behaviour). */
  gameplayInput = false;
  /** Returns to the title screen. Assigned at startup (avoids scene import cycles). */
  goToMainMenu: () => Promise<void> = async () => {};
  private keyboard!: KeyboardMouseSource;

  /** Smoothed frames per second, for the debug overlay. */
  fps = 60;
  private loop: GameLoop;

  constructor(readonly root: HTMLElement) {
    this.settings = loadSettings();
    this.audio = new AudioEngine(this.content, this.settings.volume);
    this.audio.setVolumes(this.settings.volume, this.settings.muted);
    this.debugVisible = this.settings.showDebug;
    this.loop = new GameLoop({
      update: (dt) => this.update(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
  }

  /** Boots every module in dependency order. Throws with a readable message on fatal problems. */
  async boot(onProgress: (msg: string) => void = () => {}): Promise<void> {
    onProgress('Loading content…');
    defineCoreContentTypes(this.content);
    this.contentReport = loadContent(this.content, bundledContentFiles);
    if (this.contentReport.errors.length) {
      throw new Error(`Content errors:\n${this.contentReport.errors.join('\n')}`);
    }
    this.audio.init();
    // Every enabled menu button clicks.
    this.root.addEventListener(
      'click',
      (e) => {
        if (e.target instanceof Element && e.target.closest('button:not(:disabled)')) this.audio.playCue('ui_click');
      },
      true,
    );

    onProgress('Starting renderer…');
    this.renderer = await GameRenderer.create(this.root, this.settings.renderer);
    this.renderer.onDeviceLost = (count) => {
      // One loss can be a legitimate GPU reset (Pixi recovers). Repeated losses mean
      // WebGPU is unreliable on this device: remember that, save, and restart on WebGL.
      if (count < 2) return;
      this.settings.renderer = 'webgl';
      saveSettings(this.settings);
      this.events.emit('app:hidden', undefined);
      setTimeout(() => location.reload(), 500);
    };
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    window.visualViewport?.addEventListener('resize', () => this.onResize());

    onProgress('Opening saves…');
    const { backend, warning } = await openBestBackend();
    this.saves = new SaveManager(backend);
    this.saveWarning = warning;
    // Ask the browser not to evict our saves under storage pressure.
    void navigator.storage?.persist?.().catch(() => false);

    this.input = new InputManager(
      [(this.keyboard = new KeyboardMouseSource(this.renderer.canvas)), new GamepadSource()],
      'keyboardMouse',
    );
    this.setGameplayInput(false);
    this.input.onDeviceChange = (d) => {
      this.events.emit('input:device', d);
    };

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.input.reset();
        this.audio.suspend();
        this.events.emit('app:hidden', undefined);
      } else {
        this.audio.resume();
        this.events.emit('app:visible', undefined);
      }
    });
    // Closing the tab may skip visibilitychange; pagehide is the reliable last chance to save.
    window.addEventListener('pagehide', () => this.events.emit('app:hidden', undefined));
  }

  /** Gameplay scenes turn this on in enter() and off in exit(). */
  setGameplayInput(on: boolean): void {
    this.gameplayInput = on;
    this.keyboard.capture = on;
    this.input.reset();
  }

  start(): void {
    this.loop.start();
  }

  setDebugVisible(on: boolean): void {
    this.debugVisible = on;
    this.settings.showDebug = on;
    saveSettings(this.settings);
    this.events.emit('debug:toggle', on);
  }

  setZoomBias(bias: number): void {
    this.settings.zoomBias = Math.max(-3, Math.min(4, bias));
    saveSettings(this.settings);
    this.onResize();
  }

  private update(dt: number): void {
    this.input.update();
    if (this.input.justPressed('debugToggle')) this.setDebugVisible(!this.debugVisible);
    this.scenes.update(dt);
  }

  private render(alpha: number, frameDt: number): void {
    if (frameDt > 0) this.fps += (1 / frameDt - this.fps) * 0.05;
    this.scenes.render(alpha, frameDt);
    this.renderer.render();
  }

  private onResize(): void {
    this.renderer.fit();
    this.camera.zoomBias = this.settings.zoomBias;
    this.camera.setViewport(this.renderer.width, this.renderer.height);
    this.events.emit('resize', { width: this.renderer.width, height: this.renderer.height });
  }
}
