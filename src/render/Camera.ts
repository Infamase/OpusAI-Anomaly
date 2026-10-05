import type { Container } from 'pixi.js';
import { lerp, type Vec2 } from '../core/math';

/**
 * 2D camera with whole-number zoom for crisp pixels.
 *
 * Zoom is picked so roughly TARGET_VIEW_HEIGHT world pixels are visible — on a
 * 1080p monitor that's 3x, at 1440p 4x — so every screen sees about the same
 * amount of the world.
 */
const TARGET_VIEW_HEIGHT = 340;
const TARGET_VIEW_WIDTH = 600;

export class Camera {
  /** World-space point at the center of the screen. */
  x = 0;
  y = 0;
  zoom = 3;
  /** Extra zoom steps chosen by the player (+/-). */
  zoomBias = 0;
  viewportW = 1;
  viewportH = 1;

  private target: Vec2 | null = null;
  private lookAhead: Vec2 = { x: 0, y: 0 };

  setViewport(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
    const auto = Math.round(Math.min(h / TARGET_VIEW_HEIGHT, w / TARGET_VIEW_WIDTH));
    this.zoom = Math.max(1, auto + this.zoomBias);
  }

  /** Follows a world point; `lead` shifts the view toward where the player is aiming. */
  follow(target: Vec2, lead: Vec2 = { x: 0, y: 0 }): void {
    this.target = target;
    this.lookAhead = lead;
  }

  snapTo(p: Vec2): void {
    this.x = p.x;
    this.y = p.y;
  }

  /** Smoothly approaches the follow target. Frame-rate independent. */
  update(frameDt: number): void {
    if (!this.target) return;
    const tx = this.target.x + this.lookAhead.x;
    const ty = this.target.y + this.lookAhead.y;
    const t = 1 - Math.exp(-frameDt * 10);
    this.x = lerp(this.x, tx, t);
    this.y = lerp(this.y, ty, t);
  }

  /** Positions the world container. Offsets are rounded to whole device pixels. */
  apply(world: Container): void {
    world.scale.set(this.zoom);
    world.position.set(Math.round(this.viewportW / 2 - this.x * this.zoom), Math.round(this.viewportH / 2 - this.y * this.zoom));
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: this.x + (sx - this.viewportW / 2) / this.zoom,
      y: this.y + (sy - this.viewportH / 2) / this.zoom,
    };
  }

  worldToScreen(wx: number, wy: number): Vec2 {
    return {
      x: (wx - this.x) * this.zoom + this.viewportW / 2,
      y: (wy - this.y) * this.zoom + this.viewportH / 2,
    };
  }

  /** Visible world rectangle (for culling and chunk streaming). */
  get bounds(): { left: number; top: number; right: number; bottom: number } {
    const hw = this.viewportW / 2 / this.zoom;
    const hh = this.viewportH / 2 / this.zoom;
    return { left: this.x - hw, top: this.y - hh, right: this.x + hw, bottom: this.y + hh };
  }
}
