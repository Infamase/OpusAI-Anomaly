import { describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import type { InputSource, SourceState } from '../src/input/actions';
import { applyDeadzone } from '../src/input/GamepadSource';
import { InputManager } from '../src/input/InputManager';
import { BASE_SHADE, buildRamp, buildSwapMap, hexToRgb, KEY_COLORS, recolorPixels, rgbToHex } from '../src/render/palette';
import { CELL, generatePuppetAtlas, PLACEHOLDER_RACES } from '../src/render/placeholder/characters';
import { PUPPET_DIRS, PUPPET_PARTS } from '../src/render/puppet';

describe('palette swapping', () => {
  it('builds a dark-to-light ramp around the base color', () => {
    const ramp = buildRamp('#4f8a3c');
    expect(ramp).toHaveLength(5);
    expect(rgbToHex(ramp[BASE_SHADE]!)).toBe('#4f8a3c');
    const lum = ramp.map(([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11);
    expect(lum).toEqual([...lum].sort((a, b) => a - b));
  });

  it('replaces only key colors', () => {
    const key = hexToRgb(KEY_COLORS.primary[BASE_SHADE]!);
    const px = new Uint8ClampedArray([...key, 255, 10, 20, 30, 255, ...key, 0]);
    const changed = recolorPixels(px, buildSwapMap({ primary: '#3366cc' }));
    expect(changed).toBe(1); // the transparent key pixel is skipped
    expect(rgbToHex([px[0]!, px[1]!, px[2]!])).toBe('#3366cc');
    expect([px[4], px[5], px[6]]).toEqual([10, 20, 30]);
  });
});

describe('placeholder character pieces', () => {
  it.each(PLACEHOLDER_RACES)('%s: every piece exists in every view and uses recolorable key colors', (race) => {
    const atlas = generatePuppetAtlas(race);
    expect([atlas.width, atlas.height]).toEqual([CELL * PUPPET_PARTS.length, CELL * PUPPET_DIRS.length]);
    const keys = new Set(KEY_COLORS.primary);
    let keyPixels = 0;
    for (let i = 0; i < atlas.data.length; i += 4) {
      if (atlas.data[i + 3] && keys.has(rgbToHex([atlas.data[i]!, atlas.data[i + 1]!, atlas.data[i + 2]!]))) keyPixels++;
    }
    expect(keyPixels).toBeGreaterThan(100);
    PUPPET_DIRS.forEach((dir, row) =>
      PUPPET_PARTS.forEach((part, col) => {
        let opaque = 0;
        for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) if (atlas.alpha(col * CELL + x, row * CELL + y)) opaque++;
        // Humans have no tail; only lizardmen have a second (tongue-out) head.
        const absent = (part === 'tail' && race === 'human') || (part === 'headAlt' && race !== 'lizardman');
        if (absent) expect(opaque, `${race} ${dir} ${part}`).toBe(0);
        else expect(opaque, `${race} ${dir} ${part}`).toBeGreaterThan(part === 'torso' ? 150 : part.startsWith('head') ? 80 : 25);
        // Nothing touches the cell edges (it would mean the piece was clipped).
        for (let i = 0; i < CELL; i++) {
          for (const [x, y] of [
            [i, 0],
            [i, CELL - 1],
            [0, i],
            [CELL - 1, i],
          ] as const) {
            expect(atlas.alpha(col * CELL + x, row * CELL + y), `${race} ${dir} ${part} clipped at ${x},${y}`).toBe(0);
          }
        }
      }),
    );
  });
});

describe('input', () => {
  it('applies a radial deadzone and rescales', () => {
    expect(applyDeadzone({ x: 0.1, y: 0.1 }, 0.2)).toEqual({ x: 0, y: 0 });
    const full = applyDeadzone({ x: 1, y: 0 }, 0.2);
    expect(full.x).toBeCloseTo(1);
  });

  class FakeSource implements InputSource {
    lastActivity = 0;
    state: SourceState = { move: { x: 0, y: 0 }, aim: { kind: 'none' }, buttons: new Set() };
    constructor(readonly device: 'keyboardMouse' | 'gamepad') {}
    poll() {
      return { ...this.state, buttons: new Set(this.state.buttons) };
    }
    reset() {}
    dispose() {}
  }

  it('merges sources, tracks edges and the active device', () => {
    const kb = new FakeSource('keyboardMouse');
    const pad = new FakeSource('gamepad');
    const input = new InputManager([kb, pad]);
    const changes: string[] = [];
    input.onDeviceChange = (d) => changes.push(d);

    pad.lastActivity = 10;
    pad.state.move = { x: 0.5, y: 0 };
    pad.state.aim = { kind: 'direction', dir: { x: 1, y: 0 } };
    kb.state.buttons.add('reload');
    input.update();
    expect(input.device).toBe('gamepad');
    expect(input.move.x).toBe(0.5);
    expect(input.aim.kind).toBe('direction');
    expect(input.justPressed('reload')).toBe(true);
    input.update();
    expect(input.justPressed('reload')).toBe(false);
    expect(input.isDown('reload')).toBe(true);
    kb.state.buttons.clear();
    input.update();
    expect(input.justReleased('reload')).toBe(true);
    expect(changes).toEqual(['gamepad']);
  });

  it('blocks gameplay input while disabled but keeps pause working', () => {
    const kb = new FakeSource('keyboardMouse');
    const input = new InputManager([kb]);
    input.enabled = false;
    kb.state.move = { x: 1, y: 0 };
    kb.state.buttons = new Set(['fire', 'pause']);
    input.update();
    expect(input.move).toEqual({ x: 0, y: 0 });
    expect(input.isDown('fire')).toBe(false);
    expect(input.justPressed('pause')).toBe(true);
  });
});
