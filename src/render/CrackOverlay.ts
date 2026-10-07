import { Container, Graphics } from 'pixi.js';
import { hashInts } from '../core/rng';

const T = 32;

/**
 * Cracks drawn over worn breakable tiles (walls, fences, barricades): more and
 * longer cracks as a tile wears down, so you can see a wall is about to give.
 * Redrawn only when the wear changes.
 */
export class CrackOverlay {
  readonly layer = new Container({ label: 'cracks' });
  private g = new Graphics();
  private version = -1;

  constructor() {
    this.layer.addChild(this.g);
  }

  update(version: number, worn: Iterable<{ tx: number; ty: number; wear: number }>): void {
    if (version === this.version) return;
    this.version = version;
    const g = this.g;
    g.clear();
    for (const { tx, ty, wear } of worn) {
      const n = 1 + Math.floor(wear * 5);
      for (let c = 0; c < n; c++) {
        // A jagged line from a point on the tile, wandering a distance that grows with wear.
        let x = tx * T + 4 + (hashInts(tx, ty, c, 1) % 24);
        let y = ty * T + 4 + (hashInts(tx, ty, c, 2) % 24);
        let a = ((hashInts(tx, ty, c, 3) % 628) / 100) as number;
        const steps = 2 + Math.round(wear * 5);
        g.moveTo(x, y);
        for (let s = 0; s < steps; s++) {
          a += ((hashInts(tx, ty, c * 13 + s, 4) % 140) - 70) / 100;
          x = Math.max(tx * T, Math.min(tx * T + T, x + Math.cos(a) * 4));
          y = Math.max(ty * T, Math.min(ty * T + T, y + Math.sin(a) * 4));
          g.lineTo(x, y);
        }
        g.stroke({ width: 1, color: 0x14110e, alpha: 0.55 + wear * 0.4 });
      }
      // Dust darkening the tile as it wears.
      g.rect(tx * T, ty * T, T, T).fill({ color: 0x000000, alpha: wear * 0.18 });
    }
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
