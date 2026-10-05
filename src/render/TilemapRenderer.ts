import { Container, Sprite, Texture } from 'pixi.js';
import { hashInts, valueNoise2D } from '../core/rng';
import type { TileMap } from '../game/world/TileMap';
import type { TileSet } from '../game/world/TileSet';
import { generateProp, PROP_VARIANTS } from './placeholder/props';
import { generateTile, TILE_SIZE, tileRamp, VARIANTS } from './placeholder/tiles';

const T = TILE_SIZE;
/** Neighbor offsets: N, E, S, W, NE, SE, SW, NW. */
const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/**
 * Edge mask for ground blending: which pixels of a tile the neighbor in
 * direction `dir` spills over, as a ragged band (or a rounded blob for corners).
 * The band is 5px deep at the tile corners so neighboring stamps line up.
 */
function edgeMask(dir: number, variant: number): Uint8Array {
  const m = new Uint8Array(T * T); // 0 none, 1 spill, 2 rim (darker edge of the spill)
  const depth = (i: number) => {
    const ends = Math.min(i, T - 1 - i) / 6; // pinned near the corners
    const n = valueNoise2D(variant * 31 + dir * 7, i / 4, variant) * 6 + valueNoise2D(variant * 13 + dir, i / 1.6, 3) * 2;
    return Math.round(5 + Math.min(1, ends) * (n - 3));
  };
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      let inside = false;
      let rim = false;
      if (dir < 4) {
        // Distance from the shared edge, and position along it.
        const [along, from] = dir === 0 ? [x, y] : dir === 2 ? [x, T - 1 - y] : dir === 3 ? [y, x] : [y, T - 1 - x];
        const d = depth(along);
        inside = from < d;
        rim = from === d - 1;
      } else {
        const cx = dir === 4 || dir === 5 ? T : 0;
        const cy = dir === 4 || dir === 7 ? 0 : T;
        const r = 5.5 + valueNoise2D(variant + dir * 5, x / 3, y / 3) * 1.5;
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        inside = d < r;
        rim = inside && d >= r - 1;
      }
      if (inside) m[y * T + x] = rim ? 2 : 1;
    }
  }
  return m;
}

/**
 * All tile images: ground textures (variant × front face), blend stamps for
 * tiles that spill over lower neighbors, wall shadow stamps, and prop sprites.
 */
export class TileAtlas {
  /** row = tile index, column = variant * 2 + (front face ? 1 : 0). */
  readonly canvas: HTMLCanvasElement;
  /** row = tile index, column = dir * VARIANTS + variant (only tiles with blend > 0). */
  readonly edges: HTMLCanvasElement;
  /** Shadow stamps cast by walls: N, W, NW corner. */
  readonly shadows: HTMLCanvasElement;
  readonly blend: Uint8Array;
  /** Prop art per tile index (null if the tile has no prop). */
  readonly props: ({ texture: Texture; anchor: [number, number] }[] | null)[];

  constructor(readonly tiles: TileSet) {
    const n = tiles.count;
    const [c, ctx] = canvas(T * VARIANTS * 2, T * n);
    const [e, ectx] = canvas(T * VARIANTS * 8, T * n);
    this.canvas = c;
    this.edges = e;
    this.blend = new Uint8Array(n);
    this.props = [];
    const masks = DIRS.map((_, d) => Array.from({ length: VARIANTS }, (__, v) => edgeMask(d, v)));
    tiles.defs.forEach((def, row) => {
      this.blend[row] = def.blend;
      const ramp = tileRamp(def);
      for (let v = 0; v < VARIANTS; v++) {
        for (const front of [false, true]) {
          if (front && (!def.solid || def.prop)) continue;
          const pc = generateTile(def, v, front);
          ctx.putImageData(new ImageData(pc.data, T, T), (v * 2 + (front ? 1 : 0)) * T, row * T);
          if (front || !def.blend) continue;
          for (let d = 0; d < 8; d++) {
            const mask = masks[d]![v]!;
            const out = new ImageData(T, T);
            for (let i = 0; i < T * T; i++) {
              if (!mask[i]) continue;
              const rim = ramp[1]!;
              out.data[i * 4] = mask[i] === 2 ? rim[0] : pc.data[i * 4]!;
              out.data[i * 4 + 1] = mask[i] === 2 ? rim[1] : pc.data[i * 4 + 1]!;
              out.data[i * 4 + 2] = mask[i] === 2 ? rim[2] : pc.data[i * 4 + 2]!;
              out.data[i * 4 + 3] = 255;
            }
            ectx.putImageData(out, (d * VARIANTS + v) * T, row * T);
          }
        }
      }
      this.props[row] = def.prop
        ? Array.from({ length: PROP_VARIANTS }, (_, v) => {
            const art = generateProp(def.prop!, v);
            return { texture: Texture.from(art.pixels.toCanvas(), true), anchor: art.anchor };
          })
        : null;
    });

    // Wall shadows fall down and to the right (light comes from the top-left), in two hard steps.
    const [s, sctx] = canvas(T * 3, T);
    const img = sctx.createImageData(T * 3, T);
    const put = (x: number, y: number, a: number) => {
      const i = (y * T * 3 + x) * 4;
      img.data[i + 3] = Math.max(img.data[i + 3]!, a);
    };
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        if (y < 4) put(x, y, 96);
        else if (y < 9) put(x, y, 52);
        if (x < 3) put(T + x, y, 80);
        else if (x < 6) put(T + x, y, 40);
        const d = Math.max(x, y);
        if (d < 4) put(2 * T + x, y, 96);
        else if (d < 8 && x < 6) put(2 * T + x, y, 48);
      }
    }
    sctx.putImageData(img, 0, 0);
    this.shadows = s;
  }
}

interface ChunkView {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: Texture;
  sprite: Sprite;
  props: Sprite[];
}

/**
 * Draws visible chunks. Each chunk is pre-composited into one 512x512 texture
 * (ground, blended edges, wall shadows), so the GPU draws a handful of quads
 * per frame instead of thousands of tiles — cheap on integrated GPUs. Props
 * (trees, boulders) are separate sprites in the depth-sorted entity layer so
 * characters can walk behind them. Only chunks near the camera have views.
 */
export class TilemapRenderer {
  private views = new Map<string, ChunkView>();
  private pendingRedraw = new Set<string>();
  /** Fired when a chunk becomes visible / is dropped, so world objects can stream with it. */
  onChunkShown: ((cx: number, cy: number) => void) | null = null;
  onChunkHidden: ((cx: number, cy: number) => void) | null = null;

  constructor(
    private layer: Container,
    private map: TileMap,
    private atlas: TileAtlas,
    /** Depth-sorted layer for props (characters' layer). */
    private propLayer: Container | null = null,
  ) {
    map.onTileChange = (tx, ty) => {
      // Edges, shadows and wall faces depend on neighbors: redraw the 3x3 block.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.redrawTile(tx + dx, ty + dy);
      this.refreshProps(tx, ty);
    };
  }

  get viewCount(): number {
    return this.views.size;
  }

  /** Creates views for chunks in view (plus a margin) and drops far ones. */
  update(bounds: { left: number; top: number; right: number; bottom: number }): void {
    const chunkPx = this.map.chunkSize * T;
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
        this.destroyView(view);
        this.views.delete(key);
        this.onChunkHidden?.(cx, cy);
      }
    }
    for (const key of this.pendingRedraw) this.views.get(key)?.texture.source.update();
    this.pendingRedraw.clear();

    // Let the map free tile data well outside the view.
    const S = this.map.chunkSize;
    this.map.trim((minCx - 3) * S, (minCy - 3) * S, (maxCx + 4) * S, (maxCy + 4) * S);
  }

  destroy(): void {
    for (const v of this.views.values()) this.destroyView(v);
    this.views.clear();
    this.map.onTileChange = null;
  }

  private destroyView(view: ChunkView): void {
    view.sprite.destroy();
    view.texture.destroy(true);
    for (const p of view.props) p.destroy();
    view.props.length = 0;
  }

  private createView(cx: number, cy: number, key: string): void {
    const S = this.map.chunkSize;
    const [c, ctx] = canvas(S * T, S * T);
    const view: ChunkView = { canvas: c, ctx, texture: Texture.EMPTY, sprite: new Sprite(), props: [] };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) this.drawTile(view, cx * S + x, cy * S + y, x, y);
    view.texture = Texture.from(c, true);
    view.sprite.texture = view.texture;
    view.sprite.position.set(cx * S * T, cy * S * T);
    this.layer.addChild(view.sprite);
    this.views.set(key, view);
    this.spawnProps(view, cx, cy);
    this.onChunkShown?.(cx, cy);
  }

  private spawnProps(view: ChunkView, cx: number, cy: number): void {
    if (!this.propLayer) return;
    const S = this.map.chunkSize;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const tx = cx * S + x;
        const ty = cy * S + y;
        const art = this.atlas.props[this.map.getTile(tx, ty)];
        if (!art) continue;
        const pick = art[hashInts(tx, ty, 7) % art.length]!;
        const sprite = new Sprite(pick.texture);
        sprite.anchor.set((pick.anchor[0] + 0.5) / pick.texture.width, (pick.anchor[1] + 0.5) / pick.texture.height);
        const px = (tx + 0.5) * T + ((hashInts(tx, ty, 3) % 5) - 2);
        const py = (ty + 0.75) * T;
        sprite.position.set(px, py);
        sprite.zIndex = py;
        if (hashInts(tx, ty, 9) % 2) sprite.scale.x = -1;
        this.propLayer.addChild(sprite);
        view.props.push(sprite);
      }
    }
  }

  private refreshProps(tx: number, ty: number): void {
    const S = this.map.chunkSize;
    const cx = Math.floor(tx / S);
    const cy = Math.floor(ty / S);
    const view = this.views.get(`${cx},${cy}`);
    if (!view) return;
    for (const p of view.props) p.destroy();
    view.props.length = 0;
    this.spawnProps(view, cx, cy);
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
    const map = this.map;
    const atlas = this.atlas;
    const tiles = map.tiles;
    const tile = map.getTile(tx, ty);
    const def = tiles.defs[tile]!;
    const wallLike = (t: number) => tiles.solid[t] === 1 && !tiles.defs[t]!.prop;
    const wall = wallLike(tile);
    const front = wall && ty + 1 < map.heightTiles && !map.isSolid(tx, ty + 1);
    const variant = hashInts(tx, ty) % VARIANTS;
    const ctx = view.ctx;
    const x0 = lx * T;
    const y0 = ly * T;
    ctx.clearRect(x0, y0, T, T);
    ctx.drawImage(atlas.canvas, (variant * 2 + (front ? 1 : 0)) * T, tile * T, T, T, x0, y0, T, T);
    if (wall) return;

    // Ground blending: higher-priority neighbors spill over this tile's edges.
    const own = atlas.blend[tile]!;
    const around = DIRS.map(([dx, dy]) => (map.inBounds(tx + dx, ty + dy) ? map.getTile(tx + dx, ty + dy) : tile));
    const spills: { d: number; t: number }[] = [];
    around.forEach((t, d) => {
      if (wallLike(t) || atlas.blend[t]! <= own) return;
      // Corners only when neither side neighbor already spills the same ground over it.
      if (d >= 4) {
        const [a, b] = d === 4 ? [0, 1] : d === 5 ? [1, 2] : d === 6 ? [2, 3] : [3, 0];
        if (atlas.blend[around[a]!]! >= atlas.blend[t]! || atlas.blend[around[b]!]! >= atlas.blend[t]!) return;
      }
      spills.push({ d, t });
    });
    spills.sort((a, b) => atlas.blend[a.t]! - atlas.blend[b.t]!);
    for (const { d, t } of spills) {
      const [dx, dy] = DIRS[d]!;
      const nv = hashInts(tx + dx, ty + dy) % VARIANTS;
      ctx.drawImage(atlas.edges, (d * VARIANTS + nv) * T, t * T, T, T, x0, y0, T, T);
    }

    // Shadows cast by walls above / to the left.
    const n = wallLike(around[0]!);
    const w = wallLike(around[3]!);
    if (n) ctx.drawImage(atlas.shadows, 0, 0, T, T, x0, y0, T, T);
    if (w) ctx.drawImage(atlas.shadows, T, 0, T, T, x0, y0, T, T);
    if (!n && !w && wallLike(around[7]!)) ctx.drawImage(atlas.shadows, 2 * T, 0, T, T, x0, y0, T, T);

    // A soft contact shadow under props (drawn on the ground, offset away from the light).
    if (def.prop) {
      ctx.fillStyle = 'rgba(8, 10, 4, 0.32)';
      const big = def.prop === 'pine' || def.prop === 'dead_tree';
      const rx = big ? 12 : 9;
      const ry = big ? 5 : 4;
      ctx.beginPath();
      ctx.ellipse(x0 + T / 2 + 3, y0 + T * 0.75 + 1, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
