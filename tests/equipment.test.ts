import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent, type RawContentFile } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { World } from '../src/ecs/World';
import { buildCharacterStats } from '../src/game/characters';
import { Character, Equipment, Stats } from '../src/game/components';
import { armorFor, createItem, equipArmor, fitProblem, startingEquipment, unequipArmor } from '../src/game/equipment';
import { ARMOR_OUTLINES, ARMOR_STYLES, drawArmorFrame, type ArmorSlot } from '../src/render/placeholder/armor';
import { BodyPart, drawBodyFrame, PLACEHOLDER_RACES, poseFor } from '../src/render/placeholder/characters';
import { hexToRgb, KEY_COLORS, rgbToHex } from '../src/render/palette';
import type { SpriteSheetCache } from '../src/render/SpriteSheets';
import { MemoryBackend } from '../src/save/backends';
import { MIGRATIONS, migrateSave } from '../src/save/migrations';
import { SaveManager } from '../src/save/SaveManager';
import type { SaveData } from '../src/save/types';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  const report = loadContent(content, bundledContentFiles);
  expect(report.errors).toEqual([]);
});

describe('armor content', () => {
  it('gives every playable race both armor sets in every slot', () => {
    for (const race of content.all('race')) {
      for (const slot of ['head', 'torso', 'legs'] as ArmorSlot[]) {
        expect(armorFor(content, race.id, slot).length, `${race.id} ${slot}`).toBeGreaterThanOrEqual(2);
      }
      expect(Object.keys(startingEquipment(content, race.id)).sort()).toEqual(['head', 'legs', 'primary', 'sidearm', 'torso']);
    }
  });

  it('rejects armor that fits nobody, has the wrong style for its slot, or a misfitting starting kit', () => {
    const reg = new ContentRegistry();
    defineCoreContentTypes(reg);
    const files: RawContentFile[] = bundledContentFiles.filter((f) => !f.path.includes('/armor/'));
    files.push({
      path: '/content/base/armor/bad.json',
      data: [
        { type: 'armor', id: 'orphan', name: 'Orphan', slot: 'head', fitsRace: 'dragon', placeholder: { style: 'hood' }, weight: 1, value: 1 },
        { type: 'armor', id: 'wrong_style', name: 'Wrong', slot: 'legs', fitsRace: 'human', placeholder: { style: 'helmet' }, weight: 1, value: 1 },
        { type: 'armor', id: 'no_art', name: 'No art', slot: 'legs', fitsRace: 'human', weight: 1, value: 1 },
      ],
    });
    const errors = loadContent(reg, files).errors.join('\n');
    expect(errors).toMatch(/fitsRace "dragon" matches no race/);
    expect(errors).toMatch(/style "helmet" is not a legs style/);
    expect(errors).toMatch(/needs either "sheet" or "placeholder"/);
    // Races still reference their (now missing) stalker kits.
    expect(errors).toMatch(/startingEquipment references unknown armor or weapon "human_stalker_hood"/);
  });
});

describe('placeholder armor art', () => {
  const secondary = new Set(KEY_COLORS.secondary);
  const dirs = ['down', 'up', 'right'] as const;

  it.each(PLACEHOLDER_RACES)('%s: every piece is drawn, dyeable, and hugs the body', (race) => {
    for (const [slot, styles] of Object.entries(ARMOR_STYLES) as [ArmorSlot, readonly string[]][]) {
      for (const style of styles) {
        for (const dir of dirs) {
          const body = drawBodyFrame(race, dir, poseFor('walk', 2));
          const armor = drawArmorFrame(race, slot, style as never, dir, 'walk', 2);
          let painted = 0;
          let dye = 0;
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              if (!armor.alpha(x, y)) continue;
              painted++;
              if (secondary.has(rgbToHex(armor.get(x, y)))) dye++;
              // Gear (plus its outline and a pixel of bulk) stays within 3px of the body.
              let near = false;
              for (let dy = -3; dy <= 3 && !near; dy++) for (let dx = -3; dx <= 3 && !near; dx++) near = body.alpha(x + dx, y + dy) > 0;
              expect(near, `${race} ${slot}/${style} ${dir} stray pixel at ${x},${y}`).toBe(true);
            }
          }
          expect(painted, `${race} ${slot}/${style} ${dir}`).toBeGreaterThan(20);
          // Mostly dye-colored, scaled to how much of the body part is visible (a sergal's tail hides its legs from behind).
          const parts = { head: [BodyPart.HEAD, BodyPart.EYE], torso: [BodyPart.TORSO, BodyPart.ARM], legs: [BodyPart.LEG] }[slot] as number[];
          let visible = 0;
          for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (body.alpha(x, y) && parts.includes(body.regionAt(x, y))) visible++;
          expect(dye, `${race} ${slot}/${style} ${dir} dyeable`).toBeGreaterThan(Math.min(5, visible / 4));
        }
      }
    }
  });

  it.each(['lizardman', 'sergal'] as const)('%s: gear never covers the tail where it hangs in front (back view)', (race) => {
    const body = drawBodyFrame(race, 'up', poseFor('idle', 0));
    for (const slot of ['torso', 'legs'] as ArmorSlot[]) {
      for (const style of ARMOR_STYLES[slot]) {
        const armor = drawArmorFrame(race, slot, style, 'up', 'idle', 0);
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) {
            if (body.regionAt(x, y) !== BodyPart.TAIL || !armor.alpha(x, y)) continue;
            // Only the armor's 1px outline may touch the tail edge.
            expect(ARMOR_OUTLINES.has(rgbToHex(armor.get(x, y))), `${race} ${style} covers tail at ${x},${y}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('equipment', () => {
  // No sprites in unit tests: entities have no View, so layer updates are skipped.
  const sheets = {} as SpriteSheetCache;

  function wearer(raceId: string) {
    const world = new World();
    const e = world.create();
    const race = content.get('race', raceId);
    world.add(e, Character, { raceId, colors: {}, facing: 'down', anim: 'idle', animTime: 0, sprinting: false });
    world.add(e, Equipment, {});
    world.add(e, Stats, buildCharacterStats(content, race, {}));
    return { world, e };
  }

  it('applies and removes exactly an item’s modifiers, swapping slot contents', () => {
    const { world, e } = wearer('human');
    const stats = () => world.req(e, Stats);
    const jacket = createItem('human_stalker_jacket');
    expect(equipArmor(world, content, sheets, e, jacket)).toEqual({ ok: true, replaced: undefined });
    expect(stats().get('ballistic_resist')).toBeCloseTo(0.1);
    expect(stats().get('carry_weight')).toBe(45);
    const vest = createItem('human_military_vest');
    const res = equipArmor(world, content, sheets, e, vest);
    expect(res).toEqual({ ok: true, replaced: jacket });
    expect(stats().get('ballistic_resist')).toBeCloseTo(0.3);
    expect(stats().get('carry_weight')).toBe(40);
    expect(stats().get('move_speed')).toBeCloseTo(80 * 0.94);
    expect(unequipArmor(world, content, sheets, e, 'torso')).toBe(vest);
    expect(stats().get('ballistic_resist')).toBe(0);
    expect(stats().get('move_speed')).toBe(80);
  });

  it('refuses armor made for another race', () => {
    const { world, e } = wearer('sergal');
    const res = equipArmor(world, content, sheets, e, createItem('lizardman_military_helmet'));
    expect(res.ok).toBe(false);
    expect(fitProblem(content, 'sergal', content.get('armor', 'lizardman_military_helmet'))).toMatch(/Lizardman bodies, not Sergal/);
    expect(world.req(e, Equipment).head).toBeUndefined();
  });

  it('gives unique item ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createItem('x').uid));
    expect(ids.size).toBe(200);
  });
});

describe('save format upgrades and slot management', () => {
  const v1 = (slotId: string): SaveData =>
    ({
      version: 1,
      meta: { slotId, name: 'Old', createdAt: 1, updatedAt: 1, playTimeSec: 0, gameVersion: '0.1.0', contentPacks: [] },
      player: { name: 'Old', raceId: 'human', colors: {}, worldId: 'w', x: 0, y: 0, facing: 'down' },
      worlds: {},
      flags: {},
    }) as unknown as SaveData;

  it('upgrades Phase 0 saves through v2 (equipment) and v3 (inventory, weapons)', () => {
    const out = migrateSave<SaveData>(v1('a'), MIGRATIONS);
    expect(out.version).toBe(3);
    expect(out.player.equipment).toEqual({});
    expect(out.player.inventory).toEqual([]);
    expect(out.player.activeWeapon).toBeNull();
  });

  it('lists summaries (newest first) including old-format slots', async () => {
    const backend = new MemoryBackend();
    await backend.commit(v1('old'), [], []);
    const m = new SaveManager(backend);
    m.newGame({
      slotId: 'new',
      name: 'New',
      gameVersion: '0.2.0',
      contentPacks: [],
      player: { name: 'New', raceId: 'sergal', colors: {}, worldId: 'w', x: 0, y: 0, facing: 'down', equipment: startingEquipment(content, 'sergal'), inventory: [], activeWeapon: null },
    });
    await m.save();
    const list = await m.listSummaries();
    expect(list.map((s) => s.meta.slotId)).toEqual(['new', 'old']);
    expect(list[1]!.player.equipment).toEqual({});
    expect(await m.slotExists('old')).toBe(true);
    expect(await m.slotExists('nope')).toBe(false);
  });

  it('explains bad import files', () => {
    const m = new SaveManager(new MemoryBackend());
    expect(() => m.previewImport('not json')).toThrow(/not valid JSON/);
    expect(() => m.previewImport('{"hello":1}')).toThrow(/not a Stalker: Future Anomaly save/);
  });

  it('imports as a separate slot when keeping both copies', async () => {
    const m = new SaveManager(new MemoryBackend());
    m.newGame({
      slotId: 'a',
      name: 'A',
      gameVersion: '0.2.0',
      contentPacks: [],
      player: { name: 'A', raceId: 'human', colors: {}, worldId: 'w', x: 0, y: 0, facing: 'down', equipment: {}, inventory: [], activeWeapon: null },
    });
    m.ensureWorld('w', 'g', 5, 1);
    (await m.enterWorld('w')).setTile('0,0', 1, 'x');
    await m.save();
    const json = await m.exportSlot('a');
    expect(m.previewImport(json).data.meta.name).toBe('A');
    const copy = SaveManager.newSlotId();
    await m.importSlot(json, copy);
    expect((await m.listSummaries()).length).toBe(2);
    expect((await m.backend.loadWorldChunks(copy, 'w')).length).toBe(1);
  });

  it('resets one world (new seed next visit) without touching the character', async () => {
    const backend = new MemoryBackend();
    const m = new SaveManager(backend);
    m.newGame({
      slotId: 'a',
      name: 'A',
      gameVersion: '0.2.0',
      contentPacks: [],
      player: { name: 'A', raceId: 'human', colors: {}, worldId: 'w', x: 0, y: 0, facing: 'down', equipment: {}, inventory: [], activeWeapon: null },
    });
    m.ensureWorld('w', 'g', 5, 1);
    (await m.enterWorld('w')).setTile('0,0', 1, 'x');
    await m.save();
    await m.resetWorld('w');
    expect(m.data.worlds.w).toBeUndefined();
    expect(await backend.loadWorldChunks('a', 'w')).toEqual([]);
    expect(m.data.player.name).toBe('A');
  });
});
