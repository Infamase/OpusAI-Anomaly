import { hexToRgb, type RGB } from '../render/palette';
import type { TileDef } from '../content/types';
import { TILE_PX, type TileMap } from '../game/world/TileMap';
import { el } from './dom';

export type BlipKind = 'hostile' | 'neutral' | 'friendly' | 'crate' | 'body' | 'item' | 'artifact';
export interface Blip {
  x: number;
  y: number;
  kind: BlipKind;
}

/** Tiles shown either side of the player. */
export const MINIMAP_RADIUS = 20;
const SCALE = 4;
const SIZE = (MINIMAP_RADIUS * 2 + 1) * SCALE;
const BLIP_COLOR: Record<BlipKind, string> = {
  hostile: '#ff5a46',
  neutral: '#e6c75a',
  friendly: '#7fdc6a',
  crate: '#c8a46a',
  body: '#9a9a92',
  item: '#f3eedc',
  artifact: '#8ae8ff',
};

/** How a tile reads on the map: dark ground, bright walls, darker clumps for trees. */
export function minimapColor(def: TileDef): RGB {
  const [r, g, b] = hexToRgb(def.placeholder.color);
  const k = def.prop ? (def.solid ? 0.32 : 0.42) : def.solid ? 1 : 0.5;
  const lift = def.solid && !def.prop ? 46 : 0;
  return [Math.min(255, r * k + lift), Math.min(255, g * k + lift), Math.min(255, b * k + lift)];
}

/**
 * North-up local map in the HUD: terrain and walls around the player, with
 * people (colored by attitude), containers and loose items as blips.
 */
export class Minimap {
  readonly root = el('div', 'hud-minimap');
  private canvas = el('canvas', 'hud-minimap-canvas');
  private ctx: CanvasRenderingContext2D | null;
  private tiles = document.createElement('canvas');
  private tilesCtx: CanvasRenderingContext2D | null;
  private img: ImageData | null;
  private colors: RGB[] = [];

  constructor() {
    this.canvas.width = this.canvas.height = SIZE;
    this.tiles.width = this.tiles.height = MINIMAP_RADIUS * 2 + 3;
    this.ctx = this.canvas.getContext('2d');
    this.tilesCtx = this.tiles.getContext('2d');
    this.img = this.tilesCtx?.createImageData(this.tiles.width, this.tiles.height) ?? null;
    this.root.append(this.canvas, el('span', 'hud-minimap-n', 'N'));
  }

  draw(map: TileMap, px: number, py: number, aim: number | null, blips: Blip[]): void {
    const ctx = this.ctx;
    const tctx = this.tilesCtx;
    const img = this.img;
    if (!ctx || !tctx || !img) return;
    if (this.colors.length !== map.tiles.defs.length) this.colors = map.tiles.defs.map(minimapColor);

    // One pixel per tile (plus a border for smooth scrolling), then scaled up crisp.
    const n = this.tiles.width;
    const ptx = px / TILE_PX;
    const pty = py / TILE_PX;
    const x0 = Math.floor(ptx) - MINIMAP_RADIUS - 1;
    const y0 = Math.floor(pty) - MINIMAP_RADIUS - 1;
    const d = img.data;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const tx = x0 + i;
        const ty = y0 + j;
        const o = (j * n + i) * 4;
        const inside = tx >= 0 && ty >= 0 && tx < map.widthTiles && ty < map.heightTiles;
        const c = inside ? this.colors[map.getTile(tx, ty)] : undefined;
        d[o] = c ? c[0] : 8;
        d[o + 1] = c ? c[1] : 9;
        d[o + 2] = c ? c[2] : 12;
        d[o + 3] = 255;
      }
    }
    tctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const center = SIZE / 2;
    // Where tile (x0, y0)'s corner lands so the player's exact position is the center.
    const ox = center - (ptx - x0) * SCALE;
    const oy = center - (pty - y0) * SCALE;
    ctx.fillStyle = '#08090c';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(this.tiles, Math.round(ox), Math.round(oy), n * SCALE, n * SCALE);

    for (const b of blips) {
      const bx = Math.round(center + ((b.x - px) / TILE_PX) * SCALE);
      const by = Math.round(center + ((b.y - py) / TILE_PX) * SCALE);
      if (bx < 2 || by < 2 || bx > SIZE - 3 || by > SIZE - 3) continue;
      ctx.fillStyle = BLIP_COLOR[b.kind];
      if (b.kind === 'crate') {
        ctx.strokeStyle = BLIP_COLOR.crate;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx - 2.5, by - 2.5, 5, 5);
      } else if (b.kind === 'body') {
        ctx.fillRect(bx - 2, by - 2, 1, 1);
        ctx.fillRect(bx + 1, by - 2, 1, 1);
        ctx.fillRect(bx - 1, by - 1, 2, 2);
        ctx.fillRect(bx - 2, by + 1, 1, 1);
        ctx.fillRect(bx + 1, by + 1, 1, 1);
      } else if (b.kind === 'item') {
        ctx.fillRect(bx - 1, by - 1, 2, 2);
      } else if (b.kind === 'artifact') {
        ctx.fillRect(bx - 1, by - 2, 2, 4);
        ctx.fillRect(bx - 2, by - 1, 4, 2);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(bx - 3, by - 3, 6, 6);
        ctx.fillStyle = BLIP_COLOR[b.kind];
        ctx.fillRect(bx - 2, by - 2, 4, 4);
      }
    }

    // The player: an arrowhead pointing where they aim.
    const a = aim ?? -Math.PI / 2;
    const pt = (r: number, t: number): [number, number] => [center + Math.cos(a + t) * r, center + Math.sin(a + t) * r];
    ctx.beginPath();
    ctx.moveTo(...pt(7, 0));
    ctx.lineTo(...pt(5, 2.4));
    ctx.lineTo(...pt(1.5, Math.PI));
    ctx.lineTo(...pt(5, -2.4));
    ctx.closePath();
    ctx.fillStyle = '#f3d36a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fill();
  }

  destroy(): void {
    this.root.remove();
  }
}
