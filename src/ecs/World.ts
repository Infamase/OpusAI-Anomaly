/**
 * Minimal Entity-Component-System.
 *
 * - An Entity is just a number.
 * - A component is plain data, keyed by a ComponentType created with defineComponent().
 * - Systems query for entities that have a set of components and operate on them.
 *
 * The player, NPC Stalkers, monsters, projectiles and loot are all entities built
 * from the same components, which is what keeps new content cheap to add.
 */
export type Entity = number;

export interface ComponentType<T> {
  readonly name: string;
  /** Phantom field that carries the data type; never set at runtime. */
  readonly __type?: T;
}

export function defineComponent<T>(name: string): ComponentType<T> {
  return { name };
}

export interface System {
  readonly name: string;
  update(world: World, dt: number): void;
}

type AnyStore = Map<Entity, unknown>;

export class World {
  private nextId = 1;
  private alive = new Set<Entity>();
  private stores = new Map<ComponentType<unknown>, AnyStore>();
  private pendingDestroy = new Set<Entity>();
  private systems: System[] = [];

  create(): Entity {
    const e = this.nextId++;
    this.alive.add(e);
    return e;
  }

  /** Destruction is deferred to the end of the update so systems can iterate safely. */
  destroy(e: Entity): void {
    if (this.alive.has(e)) this.pendingDestroy.add(e);
  }

  isAlive(e: Entity): boolean {
    return this.alive.has(e) && !this.pendingDestroy.has(e);
  }

  get entityCount(): number {
    return this.alive.size;
  }

  add<T>(e: Entity, type: ComponentType<T>, value: T): T {
    if (!this.alive.has(e)) throw new Error(`add(${type.name}) on dead entity ${e}`);
    this.store(type).set(e, value);
    return value;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.stores.get(type as ComponentType<unknown>)?.get(e) as T | undefined;
  }

  /** Like get(), but throws if missing — use when a query already guarantees presence. */
  req<T>(e: Entity, type: ComponentType<T>): T {
    const v = this.get(e, type);
    if (v === undefined) throw new Error(`Entity ${e} has no ${type.name}`);
    return v;
  }

  has(e: Entity, type: ComponentType<unknown>): boolean {
    return this.stores.get(type)?.has(e) ?? false;
  }

  remove(e: Entity, type: ComponentType<unknown>): void {
    this.stores.get(type)?.delete(e);
  }

  /** Entities that have every listed component. Iterates the smallest store. */
  *query(...types: ComponentType<unknown>[]): Generator<Entity> {
    if (types.length === 0) return;
    const stores = types.map((t) => this.stores.get(t));
    if (stores.some((s) => !s || s.size === 0)) return;
    const sorted = (stores as AnyStore[]).slice().sort((a, b) => a.size - b.size);
    const [smallest, ...rest] = sorted;
    for (const e of [...smallest!.keys()]) {
      if (this.pendingDestroy.has(e)) continue;
      if (rest.every((s) => s.has(e))) yield e;
    }
  }

  first(...types: ComponentType<unknown>[]): Entity | undefined {
    for (const e of this.query(...types)) return e;
    return undefined;
  }

  addSystem(system: System): this {
    this.systems.push(system);
    return this;
  }

  get systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  update(dt: number): void {
    for (const s of this.systems) s.update(this, dt);
    this.flushDestroyed();
  }

  /** Hook so render-side code can release sprites etc. for destroyed entities. */
  onDestroy: ((e: Entity) => void) | null = null;

  flushDestroyed(): void {
    for (const e of this.pendingDestroy) {
      this.onDestroy?.(e);
      for (const store of this.stores.values()) store.delete(e);
      this.alive.delete(e);
    }
    this.pendingDestroy.clear();
  }

  private store<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = this.stores.get(type as ComponentType<unknown>);
    if (!s) {
      s = new Map();
      this.stores.set(type as ComponentType<unknown>, s);
    }
    return s as Map<Entity, T>;
  }
}
