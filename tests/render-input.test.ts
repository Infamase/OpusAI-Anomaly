import { describe, expect, it } from 'vitest';
import { bundledContentFiles } from '../src/content/bundled';
import { loadContent } from '../src/content/loader';
import { ContentRegistry } from '../src/content/Registry';
import { defineCoreContentTypes } from '../src/content/types';
import type { InputSource, SourceState } from '../src/input/actions';
import { applyDeadzone } from '../src/input/GamepadSource';
import { InputManager } from '../src/input/InputManager';
import { buildRamp, buildSwapMap, hexToRgb, KEY_COLORS, recolorPixels, rgbToHex } from '../src/render/palette';
import { generateCharacterSheet, PLACEHOLDER_RACES } from '../src/render/placeholder/characters';

describe('palette swapping', () => {
  it('builds a dark-to-light ramp around the base color', () => {
    const ramp = buildRamp('#4f8a3c');
    expect(rgbToHex(ramp[2]!)).toBe('#4f8a3c');
    const lum = ramp.map(([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11);
    expect(lum).toEqual([...lum].sort((a, b) => a - b));
  });

  it('replaces only key colors', () => {
    const key = hexToRgb(KEY_COLORS.primary[2]!);
    const px = new Uint8ClampedArray([...key, 255, 10, 20, 30, 255, ...key, 0]);
    const changed = recolorPixels(px, buildSwapMap({ primary: '#3366cc' }));
    expect(changed).toBe(1); // the transparent key pixel is skipped
    expect(rgbToHex([px[0]!, px[1]!, px[2]!])).toBe('#3366cc');
    expect([px[4], px[5], px[6]]).toEqual([10, 20, 30]);
  });
});

describe('placeholder character sheets', () => {
  const reg = new ContentRegistry();
  defineCoreContentTypes(reg);
  loadContent(reg, bundledContentFiles);
  const layout = reg.get('spriteLayout', 'humanoid48');

  it.each(PLACEHOLDER_RACES)('%s fills every frame and uses recolorable key colors', (race) => {
    const sheet = generateCharacterSheet(race, layout);
    const keys = new Set(KEY_COLORS.primary);
    let keyPixels = 0;
    for (let i = 0; i < sheet.data.length; i += 4) {
      if (sheet.data[i + 3] && keys.has(rgbToHex([sheet.data[i]!, sheet.data[i + 1]!, sheet.data[i + 2]!]))) keyPixels++;
    }
    expect(keyPixels).toBeGreaterThan(100);
    layout.animations.forEach((anim, a) =>
      layout.directions.forEach((_dir, d) => {
        for (let f = 0; f < anim.frames; f++) {
          let opaque = 0;
          for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (sheet.alpha(f * 48 + x, (a * 4 + d) * 48 + y)) opaque++;
          expect(opaque, `${race} ${anim.id} dir${d} f${f}`).toBeGreaterThan(150);
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
    constructor(readonly device: 'keyboardMouse' | 'gamepad' | 'touch') {}
    poll() {
      return { ...this.state, buttons: new Set(this.state.buttons) };
    }
    reset() {}
    dispose() {}
  }

  it('merges sources, tracks edges and the active device', () => {
    const kb = new FakeSource('keyboardMouse');
    const touch = new FakeSource('touch');
    const input = new InputManager([kb, touch]);
    const changes: string[] = [];
    input.onDeviceChange = (d) => changes.push(d);

    touch.lastActivity = 10;
    touch.state.move = { x: 0.5, y: 0 };
    touch.state.aim = { kind: 'direction', dir: { x: 1, y: 0 } };
    kb.state.buttons.add('reload');
    input.update();
    expect(input.device).toBe('touch');
    expect(input.move.x).toBe(0.5);
    expect(input.aim.kind).toBe('direction');
    expect(input.justPressed('reload')).toBe(true);
    input.update();
    expect(input.justPressed('reload')).toBe(false);
    expect(input.isDown('reload')).toBe(true);
    kb.state.buttons.clear();
    input.update();
    expect(input.justReleased('reload')).toBe(true);
    expect(changes).toEqual(['touch']);
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
