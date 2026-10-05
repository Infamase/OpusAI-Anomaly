/**
 * The one stat system every source of bonuses plugs into: races, armor,
 * cybernetics, artifacts, ship parts, status effects.
 *
 * final = clamp( (base + Σflat) × (1 + Σpercent) × Πmult )
 *
 * - flat:    +10 max health
 * - percent: +0.15 = +15% move speed (percent bonuses add together)
 * - mult:    ×0.5 (multipliers stack multiplicatively — use for heavy penalties)
 *
 * Every modifier records its `source` so unequipping an item removes exactly
 * the bonuses it granted.
 */
export type ModifierOp = 'flat' | 'percent' | 'mult';

export interface StatModifier {
  stat: string;
  op: ModifierOp;
  value: number;
  /** Who granted this, e.g. "race", "item:helmet_0042", "artifact:jellyfish". */
  source: string;
}

export interface StatDef {
  id: string;
  name: string;
  description?: string;
  default: number;
  min?: number;
  max?: number;
  /** Display hint: "int", "percent", "float". */
  format?: 'int' | 'percent' | 'float';
}

export class StatBlock {
  private base = new Map<string, number>();
  private modifiers: StatModifier[] = [];
  private cache = new Map<string, number>();
  private version = 0;

  constructor(private defs: ReadonlyMap<string, StatDef>) {}

  /** Bumps on every change; consumers can compare to know when to refresh UI. */
  get revision(): number {
    return this.version;
  }

  setBase(stat: string, value: number): void {
    this.assertKnown(stat);
    this.base.set(stat, value);
    this.invalidate();
  }

  getBase(stat: string): number {
    return this.base.get(stat) ?? this.def(stat).default;
  }

  addModifier(mod: StatModifier): void {
    this.assertKnown(mod.stat);
    this.modifiers.push(mod);
    this.invalidate();
  }

  addModifiers(mods: Iterable<StatModifier>): void {
    for (const m of mods) {
      this.assertKnown(m.stat);
      this.modifiers.push(m);
    }
    this.invalidate();
  }

  /** Removes every modifier granted by `source`. Returns how many were removed. */
  removeSource(source: string): number {
    const before = this.modifiers.length;
    this.modifiers = this.modifiers.filter((m) => m.source !== source);
    const removed = before - this.modifiers.length;
    if (removed) this.invalidate();
    return removed;
  }

  modifiersFor(stat: string): readonly StatModifier[] {
    return this.modifiers.filter((m) => m.stat === stat);
  }

  get(stat: string): number {
    const cached = this.cache.get(stat);
    if (cached !== undefined) return cached;
    const def = this.def(stat);
    let flat = 0;
    let percent = 0;
    let mult = 1;
    for (const m of this.modifiers) {
      if (m.stat !== stat) continue;
      if (m.op === 'flat') flat += m.value;
      else if (m.op === 'percent') percent += m.value;
      else mult *= m.value;
    }
    let value = (this.getBase(stat) + flat) * Math.max(0, 1 + percent) * mult;
    if (def.min !== undefined) value = Math.max(def.min, value);
    if (def.max !== undefined) value = Math.min(def.max, value);
    this.cache.set(stat, value);
    return value;
  }

  /** Snapshot of every defined stat's final value (for UI / debugging). */
  all(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.defs.keys()) out[id] = this.get(id);
    return out;
  }

  private def(stat: string): StatDef {
    const d = this.defs.get(stat);
    if (!d) throw new Error(`Unknown stat "${stat}"`);
    return d;
  }

  private assertKnown(stat: string): void {
    this.def(stat);
  }

  private invalidate(): void {
    this.cache.clear();
    this.version++;
  }
}
