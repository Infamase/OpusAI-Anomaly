import { CharacterView } from './CharacterView';
import { autoDetectRenderer, Container, TextureSource, type Renderer } from 'pixi.js';

export type BackendPreference = 'webgpu' | 'webgl';

/**
 * Thin wrapper around PixiJS. Game code talks to these layers and the Camera,
 * never to Pixi's renderer directly, which keeps the rendering backend swappable.
 *
 * Pixel-art rules enforced here:
 * - nearest-neighbour texture filtering (no blur)
 * - the canvas is sized in physical device pixels and the camera zooms by whole
 *   numbers, so every art pixel is an exact block of screen pixels.
 */
export class GameRenderer {
  readonly stage = new Container({ label: 'stage' });
  /** Everything in world space; the camera moves and scales this. */
  readonly world = new Container({ label: 'world' });
  readonly ground = new Container({ label: 'ground' });
  /** Characters, props, monsters — sorted by their feet's y so nearer things draw on top. */
  readonly entities = new Container({ label: 'entities', sortableChildren: true });
  /** Bullets, effects, damage numbers. */
  readonly overlay = new Container({ label: 'overlay' });
  /** Screen-space layer for in-canvas UI. */
  readonly screen = new Container({ label: 'screen' });

  width = 1;
  height = 1;
  /** Device pixels per CSS pixel actually used. */
  pixelRatio = 1;
  /** WebGPU device losses this session (Pixi restores the device after each). */
  deviceLosses = 0;
  /** Called after each WebGPU device loss with the running count. */
  onDeviceLost: ((count: number) => void) | null = null;

  private constructor(
    readonly pixi: Renderer,
    readonly canvas: HTMLCanvasElement,
    readonly backend: string,
  ) {
    this.world.addChild(this.ground, this.entities, this.overlay);
    this.stage.addChild(this.world, this.screen);
    // Characters are posed into small render textures; they need the renderer for that.
    CharacterView.gpu = pixi;
  }

  static async create(parent: HTMLElement, preference: BackendPreference = 'webgpu'): Promise<GameRenderer> {
    TextureSource.defaultOptions.scaleMode = 'nearest';
    const order: BackendPreference[] = preference === 'webgpu' && (await probeWebGpu()) ? ['webgpu', 'webgl'] : ['webgl'];
    let pixi: Renderer | null = null;
    let lastError: unknown;
    for (const backend of order) {
      try {
        pixi = await autoDetectRenderer({
          preference: backend,
          antialias: false,
          background: '#07070b',
          resolution: 1,
          autoDensity: false,
          roundPixels: true,
          powerPreference: 'high-performance',
        });
        break;
      } catch (e) {
        lastError = e;
        console.warn(`[renderer] ${backend} failed, trying next`, e);
      }
    }
    if (!pixi) throw new Error(`No supported renderer (WebGPU/WebGL2): ${String(lastError)}`);
    const canvas = pixi.canvas as HTMLCanvasElement;
    canvas.classList.add('game-canvas');
    parent.prepend(canvas);
    const r = new GameRenderer(pixi, canvas, pixi.name);
    r.fit();
    const device = gpuDevice(pixi);
    if (device) r.watchDevice(device);
    return r;
  }

  /** Counts device losses; Pixi swaps in a new device, so keep following the replacement. */
  private watchDevice(device: GPUDevice): void {
    void device.lost.then((info) => {
      if (info.reason === 'destroyed') return;
      this.deviceLosses++;
      console.warn(`[renderer] WebGPU device lost (${this.deviceLosses}): ${info.message}`);
      this.onDeviceLost?.(this.deviceLosses);
      const poll = setInterval(() => {
        const next = gpuDevice(this.pixi);
        if (next && next !== device) {
          clearInterval(poll);
          this.watchDevice(next);
        }
      }, 100);
      setTimeout(() => clearInterval(poll), 10_000);
    });
  }

  /** Matches the canvas to its container at full device resolution (capped for performance). */
  fit(maxPixelRatio = 3): void {
    const parent = this.canvas.parentElement!;
    const cssW = Math.max(1, parent.clientWidth);
    const cssH = Math.max(1, parent.clientHeight);
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    const w = Math.round(cssW * this.pixelRatio);
    const h = Math.round(cssH * this.pixelRatio);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.pixi.resize(w, h, 1);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
  }

  render(): void {
    CharacterView.flush();
    this.pixi.render({ container: this.stage });
  }

  destroy(): void {
    this.stage.destroy({ children: true });
    this.pixi.destroy();
  }
}

function gpuDevice(r: Renderer): GPUDevice | null {
  return (r as unknown as { gpu?: { device?: GPUDevice } }).gpu?.device ?? null;
}

/**
 * Some browser/driver combinations hand out a WebGPU device that dies as soon as
 * it presents to a canvas. Probe with raw WebGPU (present a few frames, make sure
 * the device survives) before letting Pixi commit to it. This runs before any
 * Pixi renderer exists because tearing one down and creating another in the same
 * page corrupts Pixi's texture bookkeeping.
 */
async function probeWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return false;
    const device = await adapter.requestDevice();
    let lost = false;
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') lost = true;
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) return false;
    ctx.configure({ device, format: gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
    for (let i = 0; i < 3 && !lost; i++) {
      const enc = device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] }).end();
      device.queue.submit([enc.finish()]);
      await new Promise((res) => requestAnimationFrame(res));
    }
    await new Promise((res) => setTimeout(res, 200));
    ctx.unconfigure();
    device.destroy();
    if (lost) console.warn('[renderer] WebGPU probe: device lost on present; using WebGL');
    return !lost;
  } catch (e) {
    console.warn('[renderer] WebGPU probe failed; using WebGL', e);
    return false;
  }
}
