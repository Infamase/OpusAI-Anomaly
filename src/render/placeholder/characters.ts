import type { Direction } from '../../core/math';
import type { SpriteLayoutDef } from '../../content/types';
import { layoutSheetSize } from '../../content/types/spriteLayout';
import { KEY_COLORS, hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';

/**
 * Generates stand-in 48x48 character sheets so the game is playable before real
 * art exists. Output follows docs/SPRITE_SPEC.md exactly (same layout, anchor
 * and key colors), so hand-drawn PNGs can replace these with no code changes.
 *
 * Recolorable regions are painted in the primary KEY colors; the palette swapper
 * turns them into the player's chosen hair / scale / fur color.
 */
export const PLACEHOLDER_RACES = ['human', 'lizardman', 'sergal'] as const;
export type PlaceholderRace = (typeof PLACEHOLDER_RACES)[number];

const K = KEY_COLORS.primary.map(hexToRgb) as [RGB, RGB, RGB, RGB]; // dark -> light
const KR: [RGB, RGB, RGB] = [K[1], K[2], K[3]];
const OUTLINE: RGB = [20, 16, 24];
const SUIT: [RGB, RGB, RGB] = [
  [44, 52, 38],
  [68, 80, 54],
  [92, 106, 72],
];
const BOOT: [RGB, RGB] = [
  [30, 26, 26],
  [52, 46, 44],
];
const BELT: RGB = [46, 36, 28];
const BUCKLE: RGB = [170, 150, 90];
const SKIN: [RGB, RGB, RGB] = [
  [168, 112, 86],
  [208, 152, 118],
  [234, 190, 154],
];
const DARK: RGB = [28, 22, 30];
const LIZARD_EYE: RGB = [236, 206, 64];
const SERGAL_EYE: RGB = [214, 44, 52];
const TONGUE: RGB = [206, 58, 84];

const AX = 24;
const AY = 44;

interface Pose {
  bob: number;
  liftL: number;
  liftR: number;
  stride: number;
  swing: number;
  sway: number;
  tongue: boolean;
}

function poseFor(anim: string, frame: number): Pose {
  if (anim === 'walk') {
    const f = frame % 6;
    return {
      bob: [0, 1, 0, 0, 1, 0][f]!,
      liftL: [1, 2, 1, 0, 0, 0][f]!,
      liftR: [0, 0, 0, 1, 2, 1][f]!,
      stride: [0, 2, 3, 0, -2, -3][f]!,
      swing: [0, 1, 1, 0, -1, -1][f]!,
      sway: [-1, -1, 0, 1, 1, 0][f]!,
      tongue: false,
    };
  }
  // idle (and fallback for animations this generator doesn't know yet)
  const f = frame % 4;
  return { bob: [0, 0, 1, 1][f]!, liftL: 0, liftR: 0, stride: 0, swing: 0, sway: [-1, 0, 1, 0][f]!, tongue: f === 2 };
}

/** Fill with mid tone; light top edge, dark right & bottom edges (light from top-left). */
function shaded(pc: PixelCanvas, x: number, y: number, w: number, h: number, ramp: readonly [RGB, RGB, RGB]): void {
  if (w <= 0 || h <= 0) return;
  pc.rect(x, y, w, h, ramp[1]);
  if (w > 2) pc.hline(x, y, w - 1, ramp[2]);
  if (h > 2) pc.vline(x + w - 1, y + 1, h - 1, ramp[0]);
  if (h > 3) pc.hline(x, y + h - 1, w, ramp[0]);
}

interface RaceStyle {
  torsoW: number;
  arm: [RGB, RGB, RGB];
  hand: RGB;
  /** Lower legs are bare (scales/fur) rather than suit + boots. */
  bareLegs: boolean;
  tail: null | { thick: number; len: number };
  head(pc: PixelCanvas, dir: Direction, top: number, p: Pose): void;
  chest?(pc: PixelCanvas, dir: Direction, x: number, y: number, w: number): void;
}

const STYLES: Record<PlaceholderRace, RaceStyle> = {
  human: {
    torsoW: 12,
    arm: SUIT,
    hand: SKIN[1],
    bareLegs: false,
    tail: null,
    head(pc, dir, top) {
      if (dir === 'up') {
        shaded(pc, AX - 6, top, 12, 10, KR);
        pc.hline(AX - 5, top, 10, K[3]);
        pc.rect(AX - 3, top + 10, 6, 2, SKIN[0]);
        return;
      }
      if (dir === 'down') {
        shaded(pc, AX - 6, top + 3, 12, 9, SKIN);
        pc.hline(AX - 5, top + 11, 10, SKIN[0]);
        shaded(pc, AX - 6, top, 12, 4, KR);
        pc.hline(AX - 5, top, 10, K[3]);
        pc.vline(AX - 6, top + 4, 4, K[1]);
        pc.vline(AX + 5, top + 4, 4, K[0]);
        pc.rect(AX - 5, top + 4, 4, 1, K[2]);
        pc.rect(AX - 3, top + 7, 1, 2, DARK);
        pc.rect(AX + 2, top + 7, 1, 2, DARK);
        pc.rect(AX - 1, top + 10, 2, 1, SKIN[0]);
        return;
      }
      // right (left is mirrored)
      shaded(pc, AX - 4, top + 3, 9, 9, SKIN);
      pc.set(AX + 5, top + 8, SKIN[1]);
      shaded(pc, AX - 5, top, 10, 4, KR);
      pc.rect(AX - 5, top + 4, 4, 5, K[1]);
      pc.hline(AX - 4, top, 8, K[3]);
      pc.rect(AX + 2, top + 7, 1, 2, DARK);
      pc.set(AX + 3, top + 10, SKIN[0]);
    },
  },

  lizardman: {
    torsoW: 12,
    arm: KR,
    hand: K[2],
    bareLegs: true,
    tail: { thick: 4, len: 13 },
    head(pc, dir, top, p) {
      const t = top + 1;
      if (dir === 'up') {
        shaded(pc, AX - 5, t, 10, 10, KR);
        for (let i = 0; i < 9; i += 2) pc.set(AX - 1, t + i, K[0]);
        pc.set(AX - 1, t - 1, K[1]);
        return;
      }
      if (dir === 'down') {
        shaded(pc, AX - 5, t, 10, 8, KR);
        shaded(pc, AX - 3, t + 8, 6, 3, KR);
        pc.set(AX - 2, t + 9, K[0]);
        pc.set(AX + 1, t + 9, K[0]);
        pc.set(AX - 5, t + 4, LIZARD_EYE);
        pc.set(AX - 5, t + 5, DARK);
        pc.set(AX + 4, t + 4, LIZARD_EYE);
        pc.set(AX + 4, t + 5, DARK);
        pc.set(AX - 1, t - 1, K[1]);
        pc.set(AX, t - 1, K[1]);
        pc.vline(AX - 1, t, 3, K[0]);
        if (p.tongue) {
          pc.vline(AX - 1, t + 10, 2, TONGUE);
          pc.set(AX - 2, t + 12, TONGUE);
          pc.set(AX, t + 12, TONGUE);
        }
        return;
      }
      shaded(pc, AX - 4, t, 8, 10, KR);
      shaded(pc, AX + 4, t + 4, 4, 5, KR);
      pc.vline(AX + 7, t + 5, 3, K[2]);
      pc.hline(AX + 3, t + 7, 5, K[0]);
      pc.set(AX + 1, t + 3, LIZARD_EYE);
      pc.set(AX + 2, t + 3, DARK);
      pc.set(AX + 7, t + 5, K[0]);
      for (let i = 0; i < 4; i += 2) pc.set(AX - 3 + i, t - 1, K[1]);
      if (p.tongue) {
        pc.hline(AX + 8, t + 7, 3, TONGUE);
        pc.set(AX + 11, t + 6, TONGUE);
        pc.set(AX + 11, t + 8, TONGUE);
      }
    },
  },

  sergal: {
    torsoW: 14,
    arm: KR,
    hand: K[2],
    bareLegs: true,
    tail: { thick: 7, len: 12 },
    chest(pc, dir, x, y, w) {
      if (dir === 'down') pc.rect(x + w / 2 - 2, y, 4, 3, K[3]);
      else if (dir === 'right') pc.rect(x + w - 3, y, 3, 3, K[3]);
    },
    head(pc, dir, top) {
      const ear = (x: number, dirX: 1 | -1) => {
        for (let r = 0; r < 6; r++) {
          const w = 3 - Math.floor(r / 2);
          for (let i = 0; i < w; i++) pc.set(x + i * dirX, top - 1 - r, r === 0 && i === 1 ? K[0] : K[2]);
        }
      };
      if (dir === 'down' || dir === 'up') {
        for (let r = 0; r < 12; r++) {
          const w = Math.max(2, 14 - 2 * Math.floor(r * 0.55));
          const x = AX - w / 2;
          pc.hline(x, top + r, w, r === 0 ? K[3] : K[2]);
          pc.set(x + w - 1, top + r, K[1]);
          if (dir === 'up' && r < 8) pc.set(AX - 1, top + r, K[1]);
        }
        ear(AX - 7, 1);
        ear(AX + 6, -1);
        if (dir === 'down') {
          pc.set(AX - 5, top + 4, SERGAL_EYE);
          pc.set(AX - 4, top + 5, SERGAL_EYE);
          pc.set(AX + 4, top + 4, SERGAL_EYE);
          pc.set(AX + 3, top + 5, SERGAL_EYE);
          pc.hline(AX - 1, top + 11, 2, DARK);
          pc.rect(AX - 2, top + 7, 4, 3, K[3]);
        }
        return;
      }
      shaded(pc, AX - 5, top + 1, 7, 8, KR);
      for (let c = 0; c < 9; c++) {
        const y0 = top + 3 + Math.floor(c * 0.5);
        const h = top + 9 - y0;
        pc.vline(AX + 2 + c, y0, h, c === 0 ? K[2] : K[2]);
        pc.set(AX + 2 + c, top + 8, K[3]);
      }
      pc.set(AX + 10, top + 7, DARK);
      pc.set(AX + 3, top + 4, SERGAL_EYE);
      pc.set(AX + 4, top + 4, SERGAL_EYE);
      for (let r = 0; r < 6; r++) {
        const w = Math.max(1, 3 - Math.floor(r / 2));
        const x = AX - 5 - Math.floor(r / 2);
        pc.hline(x, top - r, w, K[2]);
        pc.set(x + w - 1, top - r, K[1]);
      }
      pc.set(AX - 4, top - 1, K[0]);
    },
  },
};

function disc(pc: PixelCanvas, cx: number, cy: number, r: number, c: RGB): void {
  const ri = Math.ceil(r);
  for (let y = -ri; y <= ri; y++) {
    for (let x = -ri; x <= ri; x++) if (x * x + y * y <= r * r + 0.3) pc.set(cx + x, cy + y, c);
  }
}

function drawTail(pc: PixelCanvas, style: RaceStyle, dir: Direction, p: Pose): void {
  const tail = style.tail;
  if (!tail) return;
  const fluffy = tail.thick >= 5;
  // Start and end points of the tail curve, per facing.
  let from: [number, number];
  let to: [number, number];
  let bend: [number, number];
  if (dir === 'up') {
    // Hangs toward the viewer, in front of the legs.
    from = [AX - 0.5, AY - 13];
    to = [AX - 0.5 + p.sway * 2, AY + 1];
    bend = [AX - 0.5 + p.sway, AY - 6];
  } else if (dir === 'down') {
    // Behind the body, curling out to one side.
    from = [AX + 3, AY - 13];
    to = fluffy ? [AX + 11, AY - 1 + p.sway] : [AX + 14, AY - 3 + p.sway];
    bend = fluffy ? [AX + 10, AY - 10] : [AX + 9, AY - 10];
  } else {
    // Facing right: trails out behind to the left.
    from = [AX - 3, AY - 12];
    to = fluffy ? [AX - 13, AY - 3 + p.sway] : [AX - 16, AY - 4 + p.sway];
    bend = fluffy ? [AX - 11, AY - 12] : [AX - 10, AY - 9];
  }
  const steps = tail.len * 2;
  const point = (t: number): [number, number] => {
    const u = 1 - t; // quadratic bezier
    return [u * u * from[0] + 2 * u * t * bend[0] + t * t * to[0], u * u * from[1] + 2 * u * t * bend[1] + t * t * to[1]];
  };
  const radius = (t: number) =>
    fluffy ? 1.2 + (tail.thick / 2) * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) : (tail.thick / 2) * (1 - t * 0.8);
  // Shadow pass then fill pass gives the tail some volume.
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = point(t);
    disc(pc, Math.round(x), Math.round(y + 0.6), radius(t), K[1]);
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = point(t);
    const tip = fluffy && t > 0.72;
    const stripe = !fluffy && i % 5 === 0;
    disc(pc, Math.round(x - 0.4), Math.round(y - 0.4), Math.max(0.5, radius(t) - 0.9), tip ? K[3] : stripe ? K[1] : K[2]);
  }
}

function drawLeg(pc: PixelCanvas, style: RaceStyle, x: number, lift: number, dark: boolean): void {
  const top = AY - 10;
  const h = 10 - lift;
  const suit = dark ? ([SUIT[0], SUIT[0], SUIT[1]] as const) : SUIT;
  if (style.bareLegs) {
    shaded(pc, x, top, 4, 4, suit);
    const k = dark ? ([K[0], K[1], K[2]] as const) : KR;
    shaded(pc, x, top + 4, 4, h - 4, k);
    pc.hline(x - 1, top + h - 1, 5, k[0]);
  } else {
    shaded(pc, x, top, 4, h - 3, suit);
    pc.rect(x, top + h - 3, 4, 3, dark ? BOOT[0] : BOOT[1]);
    pc.hline(x, top + h - 1, 4, BOOT[0]);
  }
}

function drawArm(pc: PixelCanvas, style: RaceStyle, x: number, top: number, len: number, dark: boolean): void {
  const ramp = dark ? ([style.arm[0], style.arm[0], style.arm[1]] as const) : style.arm;
  shaded(pc, x, top, 3, len - 2, ramp);
  pc.rect(x, top + len - 2, 3, 2, style.hand);
  if (style.arm !== SUIT) pc.hline(x, top, 3, SUIT[1]); // short sleeve
}

function drawFrame(pc: PixelCanvas, race: PlaceholderRace, dir: Direction, p: Pose): void {
  const s = STYLES[race];
  const tw = s.torsoW;
  const torsoTop = AY - 21 + p.bob;
  const headTop = AY - 33 + p.bob;

  const torso = (x: number, w: number) => {
    shaded(pc, x, torsoTop, w, 12, SUIT);
    pc.hline(x, AY - 12 + p.bob, w, BELT);
    if (dir === 'down') pc.rect(AX - 1, AY - 12 + p.bob, 2, 1, BUCKLE);
    s.chest?.(pc, dir, x, torsoTop, w);
  };

  if (dir === 'down' || dir === 'up') {
    if (dir === 'down') drawTail(pc, s, dir, p);
    drawLeg(pc, s, AX - 5, p.liftL, false);
    drawLeg(pc, s, AX + 1, p.liftR, false);
    torso(AX - tw / 2, tw);
    drawArm(pc, s, AX - tw / 2 - 3, torsoTop + 1, 10 + p.swing, false);
    drawArm(pc, s, AX + tw / 2, torsoTop + 1, 10 - p.swing, false);
    s.head(pc, dir, headTop, p);
    if (dir === 'up') drawTail(pc, s, dir, p);
    return;
  }

  // Facing right.
  const sideW = tw - 4;
  drawTail(pc, s, dir, p);
  drawArm(pc, s, AX - 2 - p.swing * 2, torsoTop + 1, 10, true);
  drawLeg(pc, s, AX - 3 - Math.round(p.stride / 2), 0, true);
  drawLeg(pc, s, AX - 1 + Math.round(p.stride / 2), p.stride > 0 ? 1 : 0, false);
  torso(AX - sideW / 2, sideW);
  drawArm(pc, s, AX - 1 + p.swing * 2, torsoTop + 1, 10, false);
  s.head(pc, dir, headTop, p);
}

/** Draws one full sheet for `race` following `layout`. Left frames mirror right frames. */
export function generateCharacterSheet(race: PlaceholderRace, layout: SpriteLayoutDef): PixelCanvas {
  const { width, height } = layoutSheetSize(layout);
  const size = layout.frameSize;
  const sheet = new PixelCanvas(width, height);
  layout.animations.forEach((anim, a) => {
    layout.directions.forEach((dir, d) => {
      for (let f = 0; f < anim.frames; f++) {
        const frame = new PixelCanvas(48, 48);
        drawFrame(frame, race, dir === 'left' ? 'right' : dir, poseFor(anim.id, f));
        frame.outline(OUTLINE);
        // Center the 48px drawing in frames of other sizes.
        const off = (size - 48) / 2;
        sheet.blit(frame, f * size + off, (a * layout.directions.length + d) * size + off, dir === 'left');
      }
    });
  });
  return sheet;
}

export function isPlaceholderRace(id: string): id is PlaceholderRace {
  return (PLACEHOLDER_RACES as readonly string[]).includes(id);
}
