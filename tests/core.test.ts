import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/EventBus';
import { FixedStepper } from '../src/core/GameLoop';
import { toDirection } from '../src/core/math';
import { deriveSeed, fbm2D, hashString, Rng } from '../src/core/rng';
import { SceneManager, type Scene } from '../src/core/Scene';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const seqA = Array.from({ length: 20 }, () => a.nextUint32());
    const seqB = Array.from({ length: 20 }, () => b.nextUint32());
    expect(seqA).toEqual(seqB);
    expect(new Rng(1235).nextUint32()).not.toBe(seqA[0]);
  });

  it('keeps int() inside inclusive bounds and hits both ends', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(3, 6);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('never picks zero-weight entries', () => {
    const r = new Rng(9);
    for (let i = 0; i < 500; i++) {
      expect(r.weighted([{ item: 'a', weight: 0 }, { item: 'b', weight: 1 }])).toBe('b');
    }
  });

  it('derives stable, distinct child seeds', () => {
    expect(deriveSeed(42, 'chunk', 1, 2)).toBe(deriveSeed(42, 'chunk', 1, 2));
    expect(deriveSeed(42, 'chunk', 1, 2)).not.toBe(deriveSeed(42, 'chunk', 2, 1));
    expect(deriveSeed(42, 'chunk', 1, 2)).not.toBe(deriveSeed(42, 'loot', 1, 2));
    expect(hashString('abc')).toBe(hashString('abc'));
  });

  it('produces noise in [0,1]', () => {
    for (let i = 0; i < 200; i++) {
      const n = fbm2D(5, i * 0.37, i * 0.11);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });
});

describe('FixedStepper', () => {
  it('runs whole steps and returns the leftover as alpha', () => {
    const s = new FixedStepper(1 / 60);
    const update = vi.fn();
    const alpha = s.advance(2.5 / 60, update);
    expect(update).toHaveBeenCalledTimes(2);
    expect(alpha).toBeCloseTo(0.5);
  });

  it('caps catch-up work after a long stall', () => {
    const s = new FixedStepper(1 / 60, 5);
    const update = vi.fn();
    s.advance(1, update);
    expect(update).toHaveBeenCalledTimes(5);
    update.mockClear();
    s.advance(0, update);
    expect(update).toHaveBeenCalledTimes(0);
  });
});

describe('EventBus', () => {
  it('delivers, unsubscribes and supports once', () => {
    const bus = new EventBus<{ hit: number }>();
    const fn = vi.fn();
    const off = bus.on('hit', fn);
    const onceFn = vi.fn();
    bus.once('hit', onceFn);
    bus.emit('hit', 1);
    bus.emit('hit', 2);
    off();
    bus.emit('hit', 3);
    expect(fn.mock.calls).toEqual([[1], [2]]);
    expect(onceFn).toHaveBeenCalledTimes(1);
  });
});

describe('SceneManager', () => {
  const scene = (id: string, log: string[], blocksUpdate = true): Scene => ({
    id,
    blocksUpdate,
    enter: () => void log.push(`enter ${id}`),
    exit: () => void log.push(`exit ${id}`),
    update: () => void log.push(`update ${id}`),
    render: () => {},
    pause: () => void log.push(`pause ${id}`),
    resume: () => void log.push(`resume ${id}`),
  });

  it('stacks scenes and only updates the top one when it blocks', async () => {
    const log: string[] = [];
    const sm = new SceneManager();
    await sm.change(scene('world', log));
    await sm.push(scene('pause', log));
    sm.update(1 / 60);
    await sm.pop();
    sm.update(1 / 60);
    expect(log).toEqual(['enter world', 'pause world', 'enter pause', 'update pause', 'exit pause', 'resume world', 'update world']);
  });

  it('lets non-blocking overlays update the scene beneath', async () => {
    const log: string[] = [];
    const sm = new SceneManager();
    await sm.change(scene('world', log));
    await sm.push(scene('hud', log, false));
    log.length = 0;
    sm.update(1 / 60);
    expect(log).toEqual(['update hud', 'update world']);
  });
});

describe('math', () => {
  it('quantizes vectors to 4 facings', () => {
    expect(toDirection({ x: 1, y: 0.2 })).toBe('right');
    expect(toDirection({ x: -1, y: 0.5 })).toBe('left');
    expect(toDirection({ x: 0.1, y: -1 })).toBe('up');
    expect(toDirection({ x: 0, y: 1 })).toBe('down');
    expect(toDirection({ x: 0, y: 0 }, 'left')).toBe('left');
  });
});
