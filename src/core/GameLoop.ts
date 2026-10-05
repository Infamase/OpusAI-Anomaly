/**
 * Fixed-timestep loop: simulation always advances in exact `step` increments
 * (60 Hz by default) regardless of display rate, so physics and AI behave the
 * same on a 60 Hz PC monitor and a 120 Hz ProMotion iPad. Rendering runs once
 * per animation frame with an interpolation factor for smooth motion.
 */
export interface LoopCallbacks {
  update(dt: number): void;
  render(alpha: number, frameDt: number): void;
}

export class FixedStepper {
  private accumulator = 0;

  constructor(
    readonly step = 1 / 60,
    /** Caps catch-up work after a stall so we never spiral (e.g. tab was backgrounded). */
    readonly maxStepsPerFrame = 5,
  ) {}

  /** Advances by `frameDt` seconds; returns the interpolation alpha in [0, 1). */
  advance(frameDt: number, update: (dt: number) => void): number {
    this.accumulator += Math.max(0, frameDt);
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxStepsPerFrame) {
      update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    if (steps === this.maxStepsPerFrame && this.accumulator >= this.step) {
      // Drop the backlog rather than trying to simulate it.
      this.accumulator = this.accumulator % this.step;
    }
    return this.accumulator / this.step;
  }

  reset(): void {
    this.accumulator = 0;
  }
}

export class GameLoop {
  private stepper: FixedStepper;
  private rafId = 0;
  private last = 0;
  private running = false;

  constructor(
    private callbacks: LoopCallbacks,
    step = 1 / 60,
  ) {
    this.stepper = new FixedStepper(step);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.stepper.reset();
    const frame = (now: number) => {
      if (!this.running) return;
      const frameDt = Math.min((now - this.last) / 1000, 0.25);
      this.last = now;
      const alpha = this.stepper.advance(frameDt, (dt) => this.callbacks.update(dt));
      this.callbacks.render(alpha, frameDt);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
