import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbBackend, MemoryBackend, type SaveBackend } from '../src/save/backends';
import { migrateChunk, migrateSave, SaveVersionError, type Migration } from '../src/save/migrations';
import { SaveManager } from '../src/save/SaveManager';
import type { PlayerSave } from '../src/save/types';
import { WorldDeltas } from '../src/save/WorldDeltas';

const player: PlayerSave = { name: 'Strelok', raceId: 'human', colors: { primary: '#5b3a29' }, worldId: 'w1', x: 10, y: 20, facing: 'down', equipment: {}, inventory: [], activeWeapon: null };
const newGame = (m: SaveManager, slotId = 's1') =>
  m.newGame({ slotId, name: 'Test', player: { ...player }, gameVersion: '0.1.0', contentPacks: [{ id: 'base', version: '0.1.0' }] });

let dbCounter = 0;
const backends: [string, () => Promise<SaveBackend>][] = [
  ['memory', async () => new MemoryBackend()],
  ['indexeddb', () => IndexedDbBackend.open(indexedDB, `test-db-${dbCounter++}`)],
];

describe.each(backends)('SaveManager on %s', (_name, make) => {
  it('round-trips a slot with world seed and chunk deltas', async () => {
    const backend = await make();
    const a = new SaveManager(backend);
    newGame(a);
    a.ensureWorld('planet_a', 'test_range', 12345, 1);
    const deltas = await a.enterWorld('planet_a');
    deltas.setTile('3,4', 17, 'metal_wall');
    deltas.markRemoved('3,4', 'crate_0');
    await a.save(5);

    const b = new SaveManager(backend);
    const loaded = await b.load('s1');
    expect(loaded?.worlds.planet_a?.seed).toBe(12345);
    expect(loaded?.meta.playTimeSec).toBe(5);
    expect(loaded?.player.x).toBe(10);
    const d2 = await b.enterWorld('planet_a');
    expect(d2.get('3,4')).toEqual({ tiles: { 17: 'metal_wall' }, removed: ['crate_0'], entities: [] });
  });

  it('keeps the original seed when a world is re-entered', async () => {
    const m = new SaveManager(await make());
    newGame(m);
    m.ensureWorld('w', 'gen', 1, 1);
    expect(m.ensureWorld('w', 'gen', 999, 1).seed).toBe(1);
  });

  it('deletes a chunk record once all its changes are undone', async () => {
    const backend = await make();
    const m = new SaveManager(backend);
    newGame(m);
    m.ensureWorld('w', 'gen', 1, 1);
    const d = await m.enterWorld('w');
    d.setTile('0,0', 5, 'metal_wall');
    await m.save();
    expect(await backend.loadWorldChunks('s1', 'w')).toHaveLength(1);
    d.setTile('0,0', 5, null);
    await m.save();
    expect(await backend.loadWorldChunks('s1', 'w')).toHaveLength(0);
  });

  it('only writes chunks that changed since the last save', async () => {
    const backend = await make();
    let written = 0;
    const commit = backend.commit.bind(backend);
    backend.commit = (data, chunks, del) => ((written += chunks.length), commit(data, chunks, del));
    const m = new SaveManager(backend);
    newGame(m);
    m.ensureWorld('w', 'gen', 1, 1);
    const d = await m.enterWorld('w');
    d.setTile('0,0', 1, 'a');
    d.setTile('1,0', 1, 'a');
    await m.save();
    await m.save();
    d.setTile('1,0', 2, 'b');
    await m.save();
    expect(written).toBe(3);
  });

  it('exports and imports a slot as JSON', async () => {
    const backend = await make();
    const m = new SaveManager(backend);
    newGame(m);
    m.ensureWorld('w', 'gen', 77, 1);
    (await m.enterWorld('w')).setTile('2,2', 0, 'x');
    await m.save();
    const json = await m.exportSlot('s1');
    const slot = await m.importSlot(json, 'copy');
    const n = new SaveManager(backend);
    expect((await n.load(slot))?.worlds.w?.seed).toBe(77);
    expect((await n.enterWorld('w')).get('2,2')?.tiles).toEqual({ 0: 'x' });
    expect((await n.listSlots()).map((s) => s.slotId).sort()).toEqual(['copy', 's1']);
  });

  it('deletes a slot and its chunks', async () => {
    const backend = await make();
    const m = new SaveManager(backend);
    newGame(m);
    m.ensureWorld('w', 'gen', 1, 1);
    (await m.enterWorld('w')).setTile('0,0', 0, 'x');
    await m.save();
    await m.deleteSlot('s1');
    expect(await backend.loadSlot('s1')).toBeUndefined();
    expect(await backend.loadWorldChunks('s1', 'w')).toEqual([]);
  });
});

describe('save migrations', () => {
  const migrations: Migration[] = [
    { from: 1, save: (d) => ({ ...d, player: { ...d.player, credits: 0 } }) },
    { from: 2, chunk: (c) => ({ ...c, removed: [...c.removed, 'migrated'] }) },
  ];

  it('upgrades step by step to the current version', () => {
    const out = migrateSave<{ version: number; player: { credits: number } }>({ version: 1, player: {} } as never, migrations, 3);
    expect(out.version).toBe(3);
    expect(out.player.credits).toBe(0);
    const chunk = migrateChunk({ tiles: {}, removed: [], entities: [] }, 1, migrations, 3);
    expect(chunk.removed).toEqual(['migrated']);
  });

  it('refuses saves from a newer game or with a missing step', () => {
    expect(() => migrateSave({ version: 9 }, migrations, 3)).toThrow(SaveVersionError);
    expect(() => migrateSave({ version: 1 }, [], 2)).toThrow(/No migration from save v1/);
  });

  it('does not mutate the input', () => {
    const raw = { version: 1, player: {} };
    migrateSave(raw, migrations, 2);
    expect(raw).toEqual({ version: 1, player: {} });
  });
});

describe('WorldDeltas', () => {
  it('restores dirty state if a save fails', () => {
    const d = new WorldDeltas('w');
    d.setTile('0,0', 1, 'x');
    const taken = d.takeDirty();
    expect(d.hasUnsaved).toBe(false);
    d.restoreDirty(taken.map((t) => t.key));
    expect(d.hasUnsaved).toBe(true);
  });
});
