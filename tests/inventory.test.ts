import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { World, type Entity } from '../src/ecs/World';
import { addCombatComponents, buildCharacterStats } from '../src/game/characters';
import { Character, Collider, Encumbrance, Equipment, Health, Inventory, Stamina, Stats, Transform, Velocity, Aim } from '../src/game/components';
import { pickQuickHeal, useConsumable } from '../src/game/consumables';
import { createItem } from '../src/game/equipment';
import { equipFromInventory, unequipToInventory, unloadWeapon } from '../src/game/inventoryActions';
import { addItem, countItem, createLoadedWeapon } from '../src/game/items';
import { rollLoot } from '../src/game/loot';
import { refreshEncumbrance } from '../src/game/systems/EncumbranceSystem';
import { VitalsSystem } from '../src/game/systems/VitalsSystem';
import { EventBus } from '../src/core/EventBus';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import type { SpriteSheetCache } from '../src/render/SpriteSheets';
import { MemoryBackend } from '../src/save/backends';
import { SaveManager } from '../src/save/SaveManager';
import type { ItemInstance } from '../src/save/types';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

/** Sprite work is skipped: no View on test entities, and armor art loading is a no-op. */
const sheets = { prepare: async () => {} } as unknown as SpriteSheetCache;

function player(raceId = 'human'): { w: World; e: Entity } {
  const w = new World();
  const e = w.create();
  w.add(e, Transform, { x: 0, y: 0, prevX: 0, prevY: 0 });
  w.add(e, Velocity, { x: 0, y: 0 });
  w.add(e, Collider, { w: 12, h: 8 });
  w.add(e, Aim, { dir: null });
  w.add(e, Character, { raceId, colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
  w.add(e, Equipment, {});
  w.add(e, Stats, buildCharacterStats(content, content.get('race', raceId), {}));
  addCombatComponents(w, e, { faction: 'player' });
  return { w, e };
}

describe('loot', () => {
  it('is deterministic per seed and only contains real items', () => {
    const a = rollLoot(content, 'supply_crate', new Rng(7)).map((i) => [i.defId, i.count ?? 1]);
    const b = rollLoot(content, 'supply_crate', new Rng(7)).map((i) => [i.defId, i.count ?? 1]);
    expect(a).toEqual(b);
    let total = 0;
    for (let s = 0; s < 50; s++) total += rollLoot(content, 'military_crate', new Rng(s)).length;
    expect(total).toBeGreaterThan(20);
  });
});

describe('consumables', () => {
  it('heals instantly and over time, stops bleeding, restores stamina, and uses one from the stack', () => {
    const { w, e } = player();
    const h = w.req(e, Health);
    h.hp = 40;
    h.bleed = 2.5;
    w.req(e, Stamina).current = 10;
    const inv = w.req(e, Inventory);
    addItem(content, inv, createItem('medkit', 2));
    const kit = inv[0]!;
    expect(useConsumable(w, content, e, kit)).toMatch(/First Aid Kit/);
    expect(h.hp).toBe(50);
    expect(h.bleed).toBeCloseTo(1);
    expect(countItem(inv, 'medkit')).toBe(1);
    const vitals = new VitalsSystem(new EventBus());
    for (let i = 0; i < 5 * 60; i++) vitals.update(w, 1 / 60);
    expect(h.hp).toBeGreaterThan(85); // +40 over 4s minus a little bleeding
    addItem(content, inv, createItem('energy_drink'));
    useConsumable(w, content, e, inv.find((i) => i.defId === 'energy_drink')!);
    expect(w.req(e, Stamina).current).toBeGreaterThan(80);
  });

  it('quick-heal prefers a bandage for bleeding and a medkit for real damage', () => {
    const inv: ItemInstance[] = [];
    addItem(content, inv, createItem('bandage', 2));
    addItem(content, inv, createItem('medkit'));
    expect(pickQuickHeal(content, inv, 0.9, 1.5)?.defId).toBe('bandage');
    expect(pickQuickHeal(content, inv, 0.3, 1.5)?.defId).toBe('medkit');
    expect(pickQuickHeal(content, inv, 1, 0)).toBeNull();
  });
});

describe('encumbrance', () => {
  it('slows you when over the carry limit, and nearly stops you far over it', () => {
    const { w, e } = player();
    const stats = w.req(e, Stats);
    const inv = w.req(e, Inventory);
    refreshEncumbrance(w, content, e);
    expect(w.req(e, Encumbrance).level).toBe(0);
    for (let i = 0; i < 5; i++) inv.push(createItem('human_military_vest')); // 45 kg vs 40 limit
    refreshEncumbrance(w, content, e);
    expect(w.req(e, Encumbrance).level).toBe(1);
    expect(stats.get('move_speed')).toBeCloseTo(80 * 0.7);
    for (let i = 0; i < 3; i++) inv.push(createItem('human_military_vest'));
    refreshEncumbrance(w, content, e);
    expect(w.req(e, Encumbrance).level).toBe(2);
    inv.length = 0;
    refreshEncumbrance(w, content, e);
    expect(stats.get('move_speed')).toBe(80);
  });
});

describe('inventory actions', () => {
  it('equips from the backpack and puts the replaced piece back (nothing lost)', async () => {
    const { w, e } = player();
    const inv = w.req(e, Inventory);
    const hood = createItem('human_stalker_hood');
    const helmet = createItem('human_military_helmet');
    inv.push(hood, helmet);
    expect(await equipFromInventory(w, content, sheets, e, hood)).toBeNull();
    expect(await equipFromInventory(w, content, sheets, e, helmet)).toBeNull();
    expect(w.req(e, Equipment).head).toBe(helmet);
    expect(inv).toEqual([hood]);
    expect(w.req(e, Stats).get('ballistic_resist')).toBeCloseTo(0.1);
    unequipToInventory(w, content, sheets, e, 'head');
    expect(w.req(e, Equipment).head).toBeUndefined();
    expect(inv.length).toBe(2);
    expect(w.req(e, Stats).get('ballistic_resist')).toBe(0);
  });

  it('refuses armor for another race and leaves it in the backpack', async () => {
    const { w, e } = player('human');
    const inv = w.req(e, Inventory);
    const vest = createItem('sergal_military_vest');
    inv.push(vest);
    expect(await equipFromInventory(w, content, sheets, e, vest)).toMatch(/Sergal bodies/);
    expect(inv).toEqual([vest]);
  });

  it('equips weapons into their slot and unloads magazines into the backpack', async () => {
    const { w, e } = player();
    const inv = w.req(e, Inventory);
    const rifle = createLoadedWeapon(content, 'akr5_rifle');
    inv.push(rifle);
    expect(await equipFromInventory(w, content, sheets, e, rifle)).toBeNull();
    expect(w.req(e, Equipment).primary).toBe(rifle);
    expect(unloadWeapon(w, content, e, rifle)).toBe(30);
    expect(countItem(inv, 'ammo_545x39')).toBe(30);
    expect(rifle.loaded).toBe(0);
  });
});

describe('world objects and saved changes', () => {
  function map(seed: number) {
    const tiles = new TileSet(content.all('tile'));
    const def = content.get('worldGen', 'test_range');
    const gen = getGenerator(def.generator);
    return new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
  }

  it('places crates deterministically on walkable ground, including the outpost cases', () => {
    const m = map(99);
    const all = [];
    for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) all.push(...m.objects(cx, cy));
    expect(all.length).toBeGreaterThan(10);
    expect(all.filter((o) => o.kind === 'crate' && o.variant === 'military').length).toBe(2);
    for (const o of all) expect(m.isSolid(Math.floor(o.x / 32), Math.floor(o.y / 32))).toBe(false);
    const again = map(99);
    expect(again.objects(3, 3)).toEqual(m.objects(3, 3));
    expect(new Set(all.map((o) => o.id)).size).toBe(all.length);
  });

  it('saves dropped items and looted containers in chunk records', async () => {
    const backend = new MemoryBackend();
    const m = new SaveManager(backend);
    m.newGame({
      slotId: 's',
      name: 'S',
      gameVersion: '0.3.0',
      contentPacks: [],
      player: { name: 'S', raceId: 'human', colors: {}, worldId: 'w', x: 0, y: 0, facing: 'down', equipment: {}, inventory: [], activeWeapon: null },
    });
    m.ensureWorld('w', 'test_range', 1, 1);
    const d = await m.enterWorld('w');
    const bandage = createItem('bandage', 3);
    d.putEntity('2,2', { id: bandage.uid, kind: 'item', x: 70, y: 80, data: bandage });
    d.putEntity('2,2', { id: 'crate:2,2:0', kind: 'container', x: 1, y: 2, data: [] });
    await m.save();
    const fresh = new SaveManager(backend);
    await fresh.load('s');
    const d2 = await fresh.enterWorld('w');
    expect([...d2.entitiesOfKind('item')].map((r) => (r.record.data as ItemInstance).count)).toEqual([3]);
    expect(d2.entity('2,2', 'crate:2,2:0')?.data).toEqual([]);
    d2.removeEntity('2,2', bandage.uid);
    expect([...d2.entitiesOfKind('item')]).toEqual([]);
  });
});
