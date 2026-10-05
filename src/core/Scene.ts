/**
 * A scene is one self-contained game mode: main menu, planet surface, station
 * interior, player ship, galaxy map... Scenes are stacked so overlays (pause,
 * inventory) can sit on top of a running world without destroying it.
 */
export interface Scene {
  readonly id: string;
  /** If false, scenes below this one keep updating while it is on top. */
  readonly blocksUpdate?: boolean;
  enter(): void | Promise<void>;
  exit(): void | Promise<void>;
  update(dt: number): void;
  render(alpha: number, frameDt: number): void;
  /** Called when the scene above this one is popped. */
  resume?(): void;
  /** Called when another scene is pushed above this one. */
  pause?(): void;
}

export class SceneManager {
  private stack: Scene[] = [];
  private busy: Promise<void> = Promise.resolve();

  get current(): Scene | undefined {
    return this.stack[this.stack.length - 1];
  }

  get scenes(): readonly Scene[] {
    return this.stack;
  }

  /** Replaces the whole stack with `scene`. */
  change(scene: Scene): Promise<void> {
    return this.enqueue(async () => {
      while (this.stack.length) await this.stack.pop()!.exit();
      this.stack.push(scene);
      await scene.enter();
    });
  }

  push(scene: Scene): Promise<void> {
    return this.enqueue(async () => {
      this.current?.pause?.();
      this.stack.push(scene);
      await scene.enter();
    });
  }

  pop(): Promise<void> {
    return this.enqueue(async () => {
      const top = this.stack.pop();
      if (top) await top.exit();
      this.current?.resume?.();
    });
  }

  update(dt: number): void {
    // Update from the top down until a scene blocks the ones beneath it.
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const scene = this.stack[i]!;
      scene.update(dt);
      if (scene.blocksUpdate !== false) break;
    }
  }

  render(alpha: number, frameDt: number): void {
    for (const scene of this.stack) scene.render(alpha, frameDt);
  }

  /** Transitions run one at a time so async enter/exit never interleave. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.busy = this.busy.then(task, task);
    return this.busy;
  }
}
