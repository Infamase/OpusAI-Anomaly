import { describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent, type RawContentFile } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { layoutRow, layoutSheetSize } from '../src/content/types/spriteLayout';

const fresh = () => {
  const r = new ContentRegistry();
  defineCoreContentTypes(r);
  return r;
};

describe('base content pack', () => {
  it('loads with no errors', () => {
    const reg = fresh();
    const report = loadContent(reg, bundledContentFiles);
    expect(report.errors).toEqual([]);
    expect(report.packs.map((p) => p.id)).toEqual(['base']);
    expect(reg.ids('race').sort()).toEqual(['human', 'lizardman', 'sergal']);
    expect(reg.has('tile', 'void')).toBe(true);
  });

  it('uses the 48px, 4-direction humanoid layout', () => {
    const reg = fresh();
    loadContent(reg, bundledContentFiles);
    const layout = reg.get('spriteLayout', 'humanoid48');
    expect(layout.frameSize).toBe(48);
    expect(layout.directions).toEqual(['down', 'left', 'right', 'up']);
    expect(layoutRow(layout, 'walk', 'up')).toBe(7);
    expect(layoutSheetSize(layout)).toEqual({ width: 6 * 48, height: 8 * 48 });
  });
});

describe('content loader', () => {
  const base: RawContentFile = { path: '/content/base/pack.json', data: { id: 'base', name: 'Base', version: '1' } };
  const stat = (id: string, def = 1) => ({ type: 'stat', id, name: id, default: def });

  it('reports schema errors with file path and field', () => {
    const reg = fresh();
    const report = loadContent(reg, [base, { path: '/content/base/stats/bad.json', data: { type: 'stat', id: 'Bad Id', name: 'x', default: 'nope' } }]);
    expect(report.errors.join('\n')).toMatch(/bad\.json.*\.id/);
    expect(report.errors.join('\n')).toMatch(/\.default: expected number/);
  });

  it('flags unknown fields (typos) and unknown types', () => {
    const reg = fresh();
    const report = loadContent(reg, [
      base,
      { path: '/content/base/a.json', data: { ...stat('a'), defualt: 3 } },
      { path: '/content/base/b.json', data: { type: 'spaceship', id: 'x' } },
    ]);
    expect(report.errors.some((e) => e.includes('unknown field "defualt"'))).toBe(true);
    expect(report.errors.some((e) => e.includes('unknown content type "spaceship"'))).toBe(true);
  });

  it('lets a dependent pack override base content', () => {
    const reg = fresh();
    const report = loadContent(reg, [
      { path: '/content/zz_mod/pack.json', data: { id: 'zz_mod', name: 'Mod', version: '1', dependencies: ['base'] } },
      { path: '/content/zz_mod/stats.json', data: stat('speed', 99) },
      base,
      { path: '/content/base/stats.json', data: stat('speed', 1) },
    ]);
    expect(report.errors).toEqual([]);
    expect(reg.get('stat', 'speed').default).toBe(99);
    expect(report.overrides).toHaveLength(1);
  });

  it('rejects duplicate ids within one pack and dependency cycles', () => {
    const reg = fresh();
    const report = loadContent(reg, [
      base,
      { path: '/content/base/a.json', data: [stat('dup'), stat('dup')] },
      { path: '/content/x/pack.json', data: { id: 'x', name: 'X', version: '1', dependencies: ['y'] } },
      { path: '/content/y/pack.json', data: { id: 'y', name: 'Y', version: '1', dependencies: ['x'] } },
    ]);
    expect(report.errors.some((e) => e.includes('duplicate stat "dup"'))).toBe(true);
    expect(report.errors.some((e) => e.includes('cycle'))).toBe(true);
  });

  it('cross-checks references between defs', () => {
    const reg = fresh();
    const report = loadContent(reg, [
      base,
      {
        path: '/content/base/race.json',
        data: {
          type: 'race',
          id: 'ghost',
          name: 'Ghost',
          spriteLayout: 'missing_layout',
          sheet: 'placeholder:human',
          colorChannels: [],
          baseStats: { nonexistent_stat: 1 },
          armorTag: 'ghost',
          hitbox: { w: 10, h: 8 },
        },
      },
    ]);
    expect(report.errors.some((e) => e.includes('unknown spriteLayout "missing_layout"'))).toBe(true);
    expect(report.errors.some((e) => e.includes('unknown stat "nonexistent_stat"'))).toBe(true);
  });
});
