import { Container, Sprite, Texture } from 'pixi.js';
import { hashInts } from '../core/rng';
import type { TileMap } from '../game/world/TileMap';
import type { TileSet } from '../game/world/TileSet';
import { generateTile, TILE_SIZE, VARIANTS } from './placeholder/tiles';

/**
 * All tile images in one canvas: row = tile index, column = variant * 2 + (front face ? 1 : 0).
 */
export class TileAtlas {
  readonly canvas: HTMLCanvasElement;

  constructor(tiles: TileSet) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = TILE_SIZE * VARIANTS * 2;
    this.canvas.height = TILE_SIZE * tiles.count;
    const ctx = this.canvas.getContext('2d')!;
    tiles.defs.forEach((def, row) => {
      for (let v = 0; v < VARIANTS; v++) {
        for (const front of [false, true]) {
          if (front && !def.solid) continue;
          const pc = generateTile(def, v, front);
          ctx.putImageData(new ImageData(pc.data, TILE_SIZE, TILE_SIZE), (v * 2 + (front ? 1 : 0)) * TILE_SIZE, row * TILE_SIZE);
        }
      }
    });
  }
}

interface ChunkView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
  sprite: Sprite;
}

/**
 * Draws visible chunks. Each chunk is pre-composited into one 512x512 texture,
 * so the GPU draws a handful of quads per frame instead of thousands of tiles —
 * important for older iPads. Only chunks near the camera have views.
 */
export class TilemapRenderer {
  private views = new Map<string, ChunkView>();
  private pendingRedraw = new Set<string>();

  constructor(
    private layer: Container,
    private map: TileMap,
    private atlas: TileAtlas,
  ) {
    map.onTileChange = (tx, ty) => {
      // A tile's look depends on the tile below it (wall front faces), so redraw the one above too.
      this.redrawTile(tx, ty);
      this.redrawTile(tx, ty - 1);
    };
  }

  get viewCount(): number {
    return this.views.size;
  }

  /** Creates views for chunks in view (plus a margin) and drops far ones. */
  update(bounds: { left: number; top: number; right: number; bottom: number }): void {
    const chunkPx = this.map.chunkSize * TILE_SIZE;
    const minCx = Math.floor(bounds.left / chunkPx) - 1;
    const minCy = Math.floor(bounds.top / chunkPx) - 1;
    const maxCx = Math.floor(bounds.right / chunkPx) + 1;
    const maxCy = Math.floor(bounds.bottom / chunkPx) + 1;

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (cx < 0 || cy < 0 || cx >= this.map.widthChunks || cy >= this.map.heightChunks) continue;
        const key = `${cx},${cy}`;
        if (!this.views.has(key)) this.createView(cx, cy, key);
      }
    }
    // Hysteresis: keep one extra ring so walking back and forth doesn't thrash.
    for (const [key, view] of this.views) {
      const [cx, cy] = key.split(',').map(Number) as [number, number];
      if (cx < minCx - 1 || cy < minCy - 1 || cx > maxCx + 1 || cy > maxCy + 1) {
        view.sprite.destroy();
        view.texture.destroy(true);
        this.views.delete(key);
      }
    }
    for (const key of this.pendingRedraw) this.views.get(key)?.texture.source.update();
    this.pendingRedraw.clear();

    // Let the map free tile data well outside the view.
    const S = this.map.chunkSize;
    this.map.trim((minCx - 3) * S, (minCy - 3) * S, (maxCx + 4) * S, (maxCy + 4) * S);
  }

  destroy(): void {
    for (const v of this.views.values()) {
      v.sprite.destroy();
      v.texture.destroy(true);
    }
    this.views.clear();
    this.map.onTileChange = null;
  }

  private createView(cx: number, cy: number, key: string): void {
    const S = this.map.chunkSize;
    const canvas = document.createElement('canvas');
    canvas.width = S * TILE_SIZE;
    canvas.height = S * TILE_SIZE;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const view: ChunkView = { canvas, ctx, texture: Texture.EMPTY, sprite: new Sprite() };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) this.drawTile(view, cx * S + x, cy * S + y, x, y);
    view.texture = Texture.from(canvas, true);
    view.sprite.texture = view.texture;
    view.sprite.position.set(cx * S * TILE_SIZE, cy * S * TILE_SIZE);
    this.layer.addChild(view.sprite);
    this.views.set(key, view);
  }

  private redrawTile(tx: number, ty: number): void {
    if (!this.map.inBounds(tx, ty)) return;
    const S = this.map.chunkSize;
    const cx = Math.floor(tx / S);
    const cy = Math.floor(ty / S);
    const key = `${cx},${cy}`;
    const view = this.views.get(key);
    if (!view) return;
    this.drawTile(view, tx, ty, tx - cx * S, ty - cy * S);
    this.pendingRedraw.add(key);
  }

  private drawTile(view: ChunkView, tx: number, ty: number, lx: number, ly: number): void {
    const tile = this.map.getTile(tx, ty);
    const solid = this.map.tiles.solid[tile] === 1;
    const front = solid && ty + 1 < this.map.heightTiles && !this.map.isSolid(tx, ty + 1);
    const variant = hashInts(tx, ty) % VARIANTS;
    const T = TILE_SIZE;
    view.ctx.clearRect(lx * T, ly * T, T, T);
    view.ctx.drawImage(this.atlas.canvas, (variant * 2 + (front ? 1 : 0)) * T, tile * T, T, T, lx * T, ly * T, T, T);
  }
}
