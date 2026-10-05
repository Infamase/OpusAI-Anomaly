import { Graphics } from 'pixi.js';

/**
 * Screen-space crosshair. The gap between the four ticks shows the current cone
 * of fire at the cursor's distance, so you can see bloom and movement penalties.
 * A hit marker flashes on hits (red on kills).
 */
export class Crosshair {
  readonly g = new Graphics();
  private hitLeft = 0;
  private killed = false;

  hit(killed: boolean): void {
    this.hitLeft = 0.18;
    this.killed = killed;
  }

  /** `gap` in device pixels; `scale` = device pixels per art pixel (keeps line weight chunky). */
  render(dt: number, x: number | null, y: number, gap: number, scale: number, reloading: boolean): void {
    const g = this.g;
    g.clear();
    if (x === null) return;
    const w = Math.max(1, Math.round(scale * 0.75));
    const len = 4 * scale;
    const c = reloading ? 0x8a8a8a : 0xe8e2c8;
    const gp = Math.max(2 * scale, gap);
    const line = (x0: number, y0: number, x1: number, y1: number, color: number) =>
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: w + 2, color: 0x000000, alpha: 0.6 }).moveTo(x0, y0).lineTo(x1, y1).stroke({ width: w, color });
    line(x - gp - len, y, x - gp, y, c);
    line(x + gp, y, x + gp + len, y, c);
    line(x, y - gp - len, x, y - gp, c);
    line(x, y + gp, x, y + gp + len, c);
    g.rect(x - w / 2, y - w / 2, w, w).fill({ color: c });
    if (this.hitLeft > 0) {
      this.hitLeft -= dt;
      const hc = this.killed ? 0xff3a2a : 0xffffff;
      const d = 3 * scale;
      const e = 7 * scale;
      line(x - e, y - e, x - d, y - d, hc);
      line(x + e, y - e, x + d, y - d, hc);
      line(x - e, y + e, x - d, y + d, hc);
      line(x + e, y + e, x + d, y + d, hc);
    }
  }
}
