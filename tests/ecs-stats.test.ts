import { describe, expect, it } from 'vitest';
import { defineComponent, World } from '../src/ecs/World';
import { StatBlock, type StatDef } from '../src/stats/Stats';

const Pos = defineComponent<{ x: number }>('Pos');
const Tag = defineComponent<true>('Tag');

describe('World (ECS)', () => {
  it('queries entities with all requested components', () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    w.add(a, Pos, { x: 1 });
    w.add(b, Pos, { x: 2 });
    w.add(b, Tag, true);
    expect([...w.query(Pos)]).toEqual([a, b]);
    expect([...w.query(Pos, Tag)]).toEqual([b]);
    expect(w.get(a, Tag)).toBeUndefined();
  });

  it('defers destruction until the end of the update', () => {
    const w = new World();
    const e = w.create();
    w.add(e, Pos, { x: 0 });
    const destroyed: number[] = [];
    w.onDestroy = (x) => destroyed.push(x);
    w.addSystem({
      name: 'killer',
      update: (world) => {
        for (const x of world.query(Pos)) world.destroy(x);
        expect(world.get(e, Pos)).toBeDefined(); // still readable this tick
      },
    });
    w.update(1 / 60);
    expect(destroyed).toEqual([e]);
    expect(w.isAlive(e)).toBe(false);
    expect([...w.query(Pos)]).toEqual([]);
  });

  it('runs systems in registration order', () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem({ name: 'a', update: () => void order.push('a') }).addSystem({ name: 'b', update: () => void order.push('b') });
    w.update(0);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('StatBlock', () => {
  const defs = new Map<string, StatDef>([
    ['move_speed', { id: 'move_speed', name: 'Move', default: 80, min: 0 }],
    ['max_health', { id: 'max_health', name: 'HP', default: 100, min: 1 }],
  ]);

  it('applies flat, then summed percent, then multipliers', () => {
    const s = new StatBlock(defs);
    s.addModifier({ stat: 'move_speed', op: 'flat', value: 20, source: 'boots' });
    s.addModifier({ stat: 'move_speed', op: 'percent', value: 0.1, source: 'artifact:a' });
    s.addModifier({ stat: 'move_speed', op: 'percent', value: 0.15, source: 'cyber' });
    s.addModifier({ stat: 'move_speed', op: 'mult', value: 0.5, source: 'overloaded' });
    // (80 + 20) * (1 + 0.25) * 0.5
    expect(s.get('move_speed')).toBeCloseTo(62.5);
  });

  it('removes exactly the modifiers granted by a source', () => {
    const s = new StatBlock(defs);
    s.setBase('max_health', 90);
    s.addModifiers([
      { stat: 'max_health', op: 'flat', value: 25, source: 'item:vest_1' },
      { stat: 'move_speed', op: 'percent', value: -0.1, source: 'item:vest_1' },
      { stat: 'max_health', op: 'flat', value: 5, source: 'race' },
    ]);
    expect(s.get('max_health')).toBe(120);
    expect(s.removeSource('item:vest_1')).toBe(2);
    expect(s.get('max_health')).toBe(95);
    expect(s.get('move_speed')).toBe(80);
  });

  it('clamps to min and rejects unknown stats', () => {
    const s = new StatBlock(defs);
    s.addModifier({ stat: 'max_health', op: 'mult', value: 0, source: 'curse' });
    expect(s.get('max_health')).toBe(1);
    expect(() => s.get('luck')).toThrow(/Unknown stat/);
    expect(() => s.addModifier({ stat: 'luck', op: 'flat', value: 1, source: 'x' })).toThrow();
  });

  it('bumps revision on change for UI refresh', () => {
    const s = new StatBlock(defs);
    const r0 = s.revision;
    s.setBase('move_speed', 90);
    expect(s.revision).toBeGreaterThan(r0);
  });
});
