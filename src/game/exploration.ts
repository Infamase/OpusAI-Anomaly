/**
 * Which chunks of a world the player has seen, for the map's fog of war.
 * One bit per chunk, kept base64-encoded in the save's flags (a 32×32-chunk
 * planet costs 172 characters).
 */
export class Exploration {
  private bits: Uint8Array;
  private readonly key: string;

  constructor(
    private flags: Record<string, unknown>,
    worldId: string,
    readonly widthChunks: number,
    readonly heightChunks: number,
  ) {
    this.key = `explored:${worldId}`;
    this.bits = new Uint8Array(Math.ceil((widthChunks * heightChunks) / 8));
    const saved = flags[this.key];
    if (typeof saved === 'string') {
      try {
        const raw = atob(saved);
        for (let i = 0; i < Math.min(raw.length, this.bits.length); i++) this.bits[i] = raw.charCodeAt(i);
      } catch {
        /* corrupt: start unexplored */
      }
    }
  }

  isExplored(cx: number, cy: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.widthChunks || cy >= this.heightChunks) return false;
    const i = cy * this.widthChunks + cx;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  get exploredCount(): number {
    let n = 0;
    for (const b of this.bits) for (let k = 0; k < 8; k++) n += (b >> k) & 1;
    return n;
  }

  /** Marks every chunk within `radius` px of a point as seen. Returns the newly seen ones. */
  reveal(x: number, y: number, radius: number, chunkPx: number): { cx: number; cy: number }[] {
    const out: { cx: number; cy: number }[] = [];
    const c0x = Math.max(0, Math.floor((x - radius) / chunkPx));
    const c1x = Math.min(this.widthChunks - 1, Math.floor((x + radius) / chunkPx));
    const c0y = Math.max(0, Math.floor((y - radius) / chunkPx));
    const c1y = Math.min(this.heightChunks - 1, Math.floor((y + radius) / chunkPx));
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (this.isExplored(cx, cy)) continue;
        // Nearest point of the chunk to the player within the radius?
        const nx = Math.max(cx * chunkPx, Math.min(x, (cx + 1) * chunkPx));
        const ny = Math.max(cy * chunkPx, Math.min(y, (cy + 1) * chunkPx));
        if (Math.hypot(nx - x, ny - y) > radius) continue;
        const i = cy * this.widthChunks + cx;
        this.bits[i >> 3]! |= 1 << (i & 7);
        out.push({ cx, cy });
      }
    }
    if (out.length) this.flags[this.key] = btoa(String.fromCharCode(...this.bits));
    return out;
  }
}
