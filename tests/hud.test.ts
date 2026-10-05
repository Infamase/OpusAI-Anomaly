import { beforeAll, describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import { minimapColor } from '../src/ui/Minimap';

let content: ContentRegistry;
beforeAll(() => {
  content = new ContentRegistry();
  defineCoreContentTypes(content);
  expect(loadContent(content, bundledContentFiles).errors).toEqual([]);
});

describe('minimap', () => {
  it('draws walls brighter than the ground around them, and trees darker', () => {
    const lum = (id: string) => minimapColor(content.get('tile', id)).reduce((a, b) => a + b, 0);
    expect(lum('metal_wall')).toBeGreaterThan(lum('metal_floor'));
    expect(lum('rock_wall')).toBeGreaterThan(lum('dirt'));
    expect(lum('pine_tree')).toBeLessThan(lum('grass'));
  });
});
