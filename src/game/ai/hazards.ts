import { TILE_PX } from '../world/TileMap';

/**
 * Tiles covered by known hazards (anomalies), so NPCs can route around them.
 * Anomalies add themselves when their chunk loads and leave when it unloads.
 */
export class HazardMap {
  private byEntity = new Map<number, number[]>();
  private counts = new Map<number, number>();

  add(owner: number, x: number, y: number, radius: number): void {
    this.remove(owner);
    const keys: number[] = [];
    const reach = radius + TILE_PX * 0.4;
    const r = Math.ceil(reach / TILE_PX);
    const cx = Math.floor(x / TILE_PX);
    const cy = Math.floor(y / TILE_PX);
    for (let ty = cy - r; ty <= cy + r; ty++) {
      for (let tx = cx - r; tx <= cx + r; tx++) {
        if (Math.hypot((tx + 0.5) * TILE_PX - x, (ty + 0.5) * TILE_PX - y) > reach) continue;
        const k = key(tx, ty);
        keys.push(k);
        this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
      }
    }
    this.byEntity.set(owner, keys);
  }

  remove(owner: number): void {
    const keys = this.byEntity.get(owner);
    if (!keys) return;
    for (const k of keys) {
      const n = (this.counts.get(k) ?? 1) - 1;
      if (n <= 0) this.counts.delete(k);
      else this.counts.set(k, n);
    }
    this.byEntity.delete(owner);
  }

  has(tx: number, ty: number): boolean {
    return this.counts.has(key(tx, ty));
  }

  clear(): void {
    this.byEntity.clear();
    this.counts.clear();
  }
}

const key = (tx: number, ty: number) => ty * 65536 + tx;
