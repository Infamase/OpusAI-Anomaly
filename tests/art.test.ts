import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { PROP_STYLES } from '../src/content/types/tile';
import { getGenerator } from '../src/game/world/generators';
import '../src/game/world/testRangeGenerator';
import { TileMap } from '../src/game/world/TileMap';
import { TileSet } from '../src/game/world/TileSet';
import { hexToRgb, KEY_COLORS, rgbToHex } from '../src/render/palette';
import { BodyPart, drawBodyFrame, poseFor } from '../src/render/placeholder/characters';
import { generateProp, PROP_VARIANTS } from '../src/render/placeholder/props';
import { cap, ell, Rig, v, type Ramp } from '../src/render/placeholder/rig';
import { generateTile, TILE_SIZE, VARIANTS } from '../src/render/placeholder/tiles';
import { generateWeaponArt, WEAPON_STYLES } from '../src/render/placeholder/weapons';
import { WorldDeltas } from '../src/save/WorldDeltas';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

const RAMP = ['#101010', '#404040', '#808080', '#b0b0b0', '#f0f0f0'].map(hexToRgb) as unknown as Ramp;

describe('rig rasterizer', () => {
  it('lights from the top-left and outlines in the darkest tone of the color it borders', () => {
    const rig = new Rig(32, 32);
    rig.add({ region: 1, ramp: RAMP }, [ell(v(16, 16), 9, 9)]);
    const pc = rig.finish();
    // Brighter at the top-left than the bottom-right of the ball.
    const lum = (x: number, y: number) => pc.get(x, y)[0];
    expect(lum(12, 12)).toBeGreaterThan(lum(20, 20));
    // Silhouette outline sits just outside the shape, in the outline tone.
    expect(rgbToHex(pc.get(16, 6))).toBe('#101010');
    expect(pc.alpha(16, 3)).toBe(0);
    expect(pc.regionAt(16, 16)).toBe(1);
  });

  it('draws a contour where a part overlaps one behind it', () => {
    const rig = new Rig(32, 32);
    const OTHER = ['#200000', '#600000', '#900000', '#c00000', '#ff4040'].map(hexToRgb) as unknown as Ramp;
    rig.add({ region: 4, ramp: RAMP }, [ell(v(16, 16), 10, 10)]);
    rig.add({ region: 5, ramp: OTHER }, [cap(v(16, 8), v(16, 24), 2.5)]);
    rig.finish();
    // Some pixels of the front part became its outline tone at the overlap.
    let contour = 0;
    for (let i = 0; i < rig.contour!.length; i++) if (rig.contour![i]) contour++;
    expect(contour).toBeGreaterThan(4);
  });
});

describe('generated character art', () => {
  it('keeps feet on the anchor row and the figure realistically tall', () => {
    for (const race of ['human', 'lizardman', 'sergal'] as const) {
      const pc = drawBodyFrame(race, 'down', poseFor('idle', 0));
      let top = 64;
      let bottom = 0;
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          if (!pc.alpha(x, y) || pc.regionAt(x, y) === BodyPart.TAIL) continue;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      expect(bottom, race).toBeGreaterThanOrEqual(59);
      expect(bottom, race).toBeLessThanOrEqual(61);
      expect(bottom - top, race).toBeGreaterThan(48);
    }
  });

  it('uses the 5-tone key ramp for fur and scales', () => {
    const keys = new Set(KEY_COLORS.primary);
    const pc = drawBodyFrame('sergal', 'right', poseFor('walk', 2));
    const used = new Set<string>();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (pc.alpha(x, y) && keys.has(rgbToHex(pc.get(x, y)))) used.add(rgbToHex(pc.get(x, y)));
    expect(used.size).toBeGreaterThanOrEqual(4);
  });

  it('draws every weapon with its grip and muzzle inside the art', () => {
    for (const style of WEAPON_STYLES) {
      const art = generateWeaponArt(style);
      expect(art.pixels.alpha(art.grip[0], art.grip[1]), `${style} grip`).toBeGreaterThan(0);
      expect(art.muzzle[0]).toBeGreaterThan(art.grip[0]);
      expect(art.muzzle[0]).toBeLessThanOrEqual(art.pixels.width);
    }
  });
});

describe('environment art', () => {
  it('generates every tile style, fully opaque, in all variants', () => {
    for (const def of content.all('tile')) {
      for (let variant = 0; variant < VARIANTS; variant++) {
        for (const front of def.solid && !def.prop ? [false, true] : [false]) {
          const pc = generateTile(def, variant, front);
          for (let i = 3; i < pc.data.length; i += 4) expect(pc.data[i], `${def.id} v${variant}`).toBe(255);
          expect(pc.width).toBe(TILE_SIZE);
        }
      }
    }
  });

  it('generates props standing on their anchor', () => {
    for (const style of PROP_STYLES) {
      for (let variant = 0; variant < PROP_VARIANTS; variant++) {
        const { pixels, anchor } = generateProp(style, variant);
        // Something is drawn at (or just above) the anchor: the trunk / base.
        let near = false;
        for (let dy = -3; dy <= 1; dy++) for (let dx = -3; dx <= 3; dx++) near ||= pixels.alpha(anchor[0] + dx, anchor[1] + dy) > 0;
        expect(near, `${style} v${variant}`).toBe(true);
      }
    }
  });

  it('scatters decorations away from the outpost and only on their ground', () => {
    const tiles = new TileSet(content.all('tile'));
    const def = content.get('worldGen', 'test_range');
    const gen = getGenerator(def.generator);
    const map = new TileMap({ tiles, generator: gen, params: gen.parseParams(def.params, tiles), seed: 42, widthChunks: 8, heightChunks: 8, deltas: new WorldDeltas('w') });
    const counts = new Map<string, number>();
    const cx = map.widthTiles / 2;
    const cy = map.heightTiles / 2;
    for (let y = 0; y < map.heightTiles; y++) {
      for (let x = 0; x < map.widthTiles; x++) {
        const id = tiles.id(map.getTile(x, y));
        if (!tiles.defs[map.getTile(x, y)]!.prop) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        // The outpost (16x12) plus a 7-tile clearing stays free of props.
        expect(Math.abs(x + 0.5 - cx) > 15 || Math.abs(y + 0.5 - cy) > 13, `${id} at ${x},${y}`).toBe(true);
      }
    }
    expect(counts.get('pine_tree') ?? 0).toBeGreaterThan(20);
    expect(counts.get('dead_tree') ?? 0).toBeGreaterThan(0);
  });
});
