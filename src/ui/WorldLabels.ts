import type { Entity } from '../ecs/World';
import { el } from './dom';

const BARK_SEC = 2.8;

interface Bark {
  node: HTMLElement;
  left: number;
}

/**
 * Text that floats over characters in the world (DOM, so it stays crisp at any
 * zoom): what NPCs shout, and the name tag of whoever the player points at.
 * The scene supplies each entity's head position in CSS pixels every frame.
 */
export class WorldLabels {
  readonly root = el('div', 'world-labels');
  private barks = new Map<Entity, Bark>();
  private tag = el('div', 'world-tag');
  private tagName = el('div', 'world-tag-name');
  private tagSub = el('div', 'world-tag-sub');
  private tagged: Entity | null = null;
  private tagKey = '';

  constructor(parent: HTMLElement) {
    this.tag.append(this.tagName, this.tagSub);
    this.tag.style.display = 'none';
    this.root.append(this.tag);
    parent.append(this.root);
  }

  /** A short spoken line over `e` (replaces what it was saying). */
  say(e: Entity, text: string, color: string): void {
    this.barks.get(e)?.node.remove();
    const node = el('div', 'world-bark', text);
    node.style.borderColor = color;
    this.root.append(node);
    this.barks.set(e, { node, left: BARK_SEC });
  }

  /** Name tag over the character under the cursor (null hides it). */
  target(e: Entity | null, name = '', sub = '', color = '#ccc'): void {
    this.tagged = e;
    const key = `${name}|${sub}|${color}`;
    if (key !== this.tagKey) {
      this.tagKey = key;
      this.tagName.textContent = name;
      this.tagName.style.color = color;
      this.tagSub.textContent = sub;
    }
    this.tag.style.display = e === null ? 'none' : '';
  }

  /** Positions everything; `project` returns a character's head and feet on screen (CSS px), or null if gone. */
  update(dt: number, project: (e: Entity) => { x: number; head: number; feet: number } | null): void {
    for (const [e, b] of this.barks) {
      b.left -= dt;
      const p = project(e);
      if (b.left <= 0 || !p) {
        b.node.remove();
        this.barks.delete(e);
        continue;
      }
      b.node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.head)}px) translate(-50%, -100%)`;
      b.node.style.opacity = b.left < 0.4 ? String(b.left / 0.4) : '1';
    }
    if (this.tagged !== null) {
      const p = project(this.tagged);
      if (!p) this.target(null);
      else {
        // Below the feet so it doesn't fight with barks above the head.
        this.tag.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.feet)}px) translate(-50%, 0)`;
      }
    }
  }

  forget(e: Entity): void {
    this.barks.get(e)?.node.remove();
    this.barks.delete(e);
    if (this.tagged === e) this.target(null);
  }

  destroy(): void {
    this.root.remove();
    this.barks.clear();
  }
}
