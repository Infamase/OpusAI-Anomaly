import { PUPPET_DIRS, PUPPET_PARTS, type PartId, type PuppetDir, type PuppetRig, type Pt } from '../puppet';
import { KEY_COLORS, hexToRgb, type RGB } from '../palette';
import { PixelCanvas } from '../PixelCanvas';
import { cap, ell, Rig, tri, v, type Ramp, type Shape, type V } from './rig';

/**
 * Generates each race's cutout pieces in code (see render/puppet.ts): torso,
 * head (+ an idle variant), tail, upper arm + shoulder, lower arm + hand,
 * upper leg + knee, lower leg + foot, for the front, side and back views.
 * Output follows docs/SPRITE_SPEC.md, so drawn PNG atlases can replace any race.
 *
 * Style target: the project's reference sheets (lean, realistic proportions,
 * colored outlines, soft 4-tone shading lit from the top-left, digitigrade
 * legs for sergals and lizardmen). Every piece is drawn on its own from a
 * bind-pose skeleton with the clay-like rasterizer in rig.ts, so it is whole
 * (rounded at the joints) and can rotate without opening gaps.
 *
 * Fur / scales / hair are painted in the primary KEY colors; the palette swapper
 * turns them into the chosen color.
 */
export const PLACEHOLDER_RACES = ['human', 'lizardman', 'sergal'] as const;
export type PlaceholderRace = (typeof PLACEHOLDER_RACES)[number];

/** Pieces are drawn in a 64x64 frame, then cut into atlas cells of this size. */
export const FRAME = 64;
export const CELL = 48;
const AX = 32;
/** Feet rest on this row. */
const GROUND = 60;

/** Region tags written while drawing a body (PixelCanvas.regions). Armor is fitted from these. */
export const BodyPart = {
  NONE: 0,
  HEAD: 1,
  EAR: 2,
  EYE: 3,
  TORSO: 4,
  ARM: 5,
  HAND: 6,
  LEG: 7,
  FOOT: 8,
  TAIL: 9,
  MOUTH: 10,
  NECK: 11,
  HIP: 12,
  HAIR: 13,
  SNOUT: 14,
} as const;
const P = BodyPart;

// ---- colors ------------------------------------------------------------------------

const rgb = (...hex: string[]) => hex.map(hexToRgb) as unknown as Ramp;
/** Hair / fur / scales: palette-swapped to the chosen color. */
const KEY: Ramp = KEY_COLORS.primary.map(hexToRgb) as unknown as Ramp;
const SKIN = rgb('#5e2a2c', '#b0634f', '#d68a67', '#f0ad84', '#ffd2a8');
const PALE = rgb('#6a3440', '#d2b0b2', '#ead8d6', '#f8efec', '#ffffff'); // sergal underside
const BELLY = rgb('#5a4a2c', '#b8a46a', '#d8c88c', '#ece0aa', '#faf4cc'); // lizard underside
const CLAW = rgb('#2e0e16', '#6e1e2a', '#962c38', '#b8404a', '#d86a6a');
const SHORTS = rgb('#1e2a4a', '#3e5f8c', '#5a80b0', '#7aa2cc', '#a6c6e2');
const LOIN = rgb('#2e1a12', '#5e3420', '#7e4a2a', '#9c6236', '#bf8350');
const WRAP = rgb('#2a1018', '#5a2232', '#743042', '#8c4052', '#ac5e6c');
const MOUTH_IN = rgb('#2a0e14', '#5e1a26', '#7e2634', '#9a3442', '#b84c58');
const EYE_HUMAN: RGB = [52, 34, 38];
const EYE_WHITE: RGB = [236, 226, 214];
const EYE_SERGAL: RGB = [255, 112, 40];
const EYE_SERGAL_DARK: RGB = [168, 28, 36];
const EYE_LIZARD: RGB = [250, 196, 40];
const EYE_LIZARD_HI: RGB = [255, 238, 150];
const PUPIL: RGB = [36, 14, 20];
const TONGUE: RGB = [220, 64, 92];
const TONGUE_DARK: RGB = [150, 30, 60];
const TOOTH: RGB = [250, 246, 236];

/** Head / tail variations baked into pieces. */
interface Pose {
  sway: number;
  tongue: boolean;
  earTwitch: boolean;
}
const REST: Pose = { sway: 0, tongue: false, earTwitch: false };

// ---- body plans ------------------------------------------------------------------------

interface Build {
  /** Head center y. */
  headY: number;
  neck: { top: number; bottom: number; r: number };
  shoulderX: number;
  shoulderY: number;
  delt: number;
  chest: { y: number; rx: number; ry: number; side: number };
  belly: { y: number; rx: number; ry: number; side: number };
  pelvis: { y: number; rx: number; ry: number; side: number };
  hipX: number;
  hipY: number;
  upperArm: { len: number; r0: number; r1: number };
  foreArm: { len: number; r0: number; r1: number };
  hand: number;
  thigh: { len: number; r0: number; r1: number };
  shin: { len: number; r0: number; r1: number };
  /** Digitigrade: a long metatarsus between shin and toes (sergal, lizardman). */
  meta: null | { len: number; r0: number; r1: number };
  foot: number;
  /** Skin for limbs/torso (or the key ramp for fur/scales). */
  hide: Ramp;
}

const BUILDS: Record<PlaceholderRace, Build> = {
  human: {
    headY: 13.5,
    neck: { top: 17.5, bottom: 22, r: 2.3 },
    shoulderX: 7.6,
    shoulderY: 22.6,
    delt: 2.9,
    chest: { y: 25.8, rx: 6.9, ry: 4.7, side: 4.6 },
    belly: { y: 31.2, rx: 5.1, ry: 4.4, side: 4 },
    pelvis: { y: 36.4, rx: 5.6, ry: 3.2, side: 4.2 },
    hipX: 3.1,
    hipY: 37.6,
    upperArm: { len: 8.6, r0: 2.6, r1: 2.0 },
    foreArm: { len: 7.6, r0: 2.1, r1: 1.5 },
    hand: 1.8,
    thigh: { len: 10.6, r0: 3.3, r1: 2.4 },
    shin: { len: 10.4, r0: 2.4, r1: 1.6 },
    meta: null,
    foot: 1.7,
    hide: SKIN,
  },
  sergal: {
    headY: 12.5,
    neck: { top: 16, bottom: 22, r: 2.4 },
    shoulderX: 8.2,
    shoulderY: 22.4,
    delt: 3.0,
    chest: { y: 25.8, rx: 7.2, ry: 4.9, side: 4.8 },
    belly: { y: 31.4, rx: 5.0, ry: 4.6, side: 4 },
    pelvis: { y: 36.4, rx: 5.6, ry: 3.3, side: 4.4 },
    hipX: 3.3,
    hipY: 37.4,
    upperArm: { len: 8.6, r0: 2.6, r1: 2.0 },
    foreArm: { len: 8.0, r0: 2.1, r1: 1.6 },
    hand: 2.0,
    thigh: { len: 8.0, r0: 3.6, r1: 2.5 },
    shin: { len: 8.6, r0: 2.3, r1: 1.6 },
    meta: { len: 7.4, r0: 1.6, r1: 1.4 },
    foot: 1.6,
    hide: KEY,
  },
  lizardman: {
    headY: 14,
    neck: { top: 17, bottom: 22.5, r: 3.0 },
    shoulderX: 8.4,
    shoulderY: 23,
    delt: 3.3,
    chest: { y: 26.2, rx: 7.4, ry: 5.0, side: 5 },
    belly: { y: 31.6, rx: 5.6, ry: 4.6, side: 4.6 },
    pelvis: { y: 36.6, rx: 5.9, ry: 3.3, side: 4.6 },
    hipX: 3.5,
    hipY: 37.6,
    upperArm: { len: 8.4, r0: 2.9, r1: 2.3 },
    foreArm: { len: 7.6, r0: 2.4, r1: 1.8 },
    hand: 2.1,
    thigh: { len: 8.0, r0: 3.9, r1: 2.8 },
    shin: { len: 8.4, r0: 2.6, r1: 1.8 },
    meta: { len: 7.2, r0: 1.9, r1: 1.6 },
    foot: 1.8,
    hide: KEY,
  },
};

// ---- skeleton -----------------------------------------------------------------------

interface Leg {
  hip: V;
  knee: V;
  /** Ankle (plantigrade) or hock (digitigrade). */
  ankle: V;
  /** Ball of the foot / toe joint (digitigrade), or the foot center. */
  ball: V;
  toe: V;
}

interface Arm {
  shoulder: V;
  elbow: V;
  hand: V;
}

/** Two-bone IK: the joint between `root` and `end`, bent toward `bendX` sign (side view) . */
function ik(root: V, end: V, a: number, b: number, bend: 1 | -1): V {
  const dx = end.x - root.x;
  const dy = end.y - root.y;
  const d = Math.min(Math.hypot(dx, dy), a + b - 0.01);
  const ang = Math.atan2(dy, dx);
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const off = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const c1 = { x: root.x + Math.cos(ang + off) * a, y: root.y + Math.sin(ang + off) * a };
  const c2 = { x: root.x + Math.cos(ang - off) * a, y: root.y + Math.sin(ang - off) * a };
  return (c1.x - c2.x) * bend >= 0 ? c1 : c2;
}

/** A leg seen from the side (facing +x). `fwd` moves the foot forward, `lift` raises it. */
function sideLeg(b: Build, hip: V, fwd: number, lift: number): Leg {
  const groundY = GROUND - b.foot;
  if (!b.meta) {
    const ankle = v(hip.x + fwd, groundY - 1.2 - lift);
    const knee = ik(hip, ankle, b.thigh.len, b.shin.len, 1);
    const ball = v(ankle.x + 2, groundY + 0.2 - lift * 0.6);
    return { hip, knee, ankle, ball, toe: v(ankle.x + 3.6, groundY + 0.4 - lift * 0.4) };
  }
  // Digitigrade: the ball of the foot is planted; the hock sits up and behind it.
  const ball = v(hip.x + fwd + 1.5, groundY - lift);
  const tilt = lift > 0.5 ? 0.5 : 0.28; // metatarsus leans back from the ball
  const ankle = v(ball.x - Math.sin(tilt) * b.meta.len, ball.y - Math.cos(tilt) * b.meta.len);
  const knee = ik(hip, ankle, b.thigh.len, b.shin.len, 1);
  return { hip, knee, ankle, ball, toe: v(ball.x + 3, ball.y + 0.6 + lift * 0.2) };
}

/** A leg seen from the front/back: straight down, shortened when lifted. */
function frontLeg(b: Build, hip: V, lift: number, outward: number): Leg {
  const groundY = GROUND - b.foot;
  const footX = hip.x + outward * 0.6;
  if (!b.meta) {
    const ankle = v(footX, groundY - 1.2 - lift);
    const knee = v(hip.x + outward * 0.5, hip.y + b.thigh.len - lift * 0.55);
    return { hip, knee, ankle, ball: v(footX, groundY + 0.1 - lift), toe: v(footX, groundY + 0.4 - lift) };
  }
  const ball = v(footX, groundY - lift);
  const ankle = v(footX, ball.y - b.meta.len * 0.92);
  const knee = v(hip.x + outward * 0.7, hip.y + b.thigh.len * 0.82 - lift * 0.4);
  return { hip, knee, ankle, ball, toe: v(footX, ball.y + 0.8) };
}

// ---- drawing helpers ------------------------------------------------------------------

function legShapes(b: Build, l: Leg, side: boolean): Shape[] {
  const s: Shape[] = [
    cap(l.hip, l.knee, b.thigh.r0, b.thigh.r1 + 0.2, { region: P.LEG }),
    cap(l.knee, l.ankle, b.shin.r0, b.shin.r1, { region: P.LEG }),
  ];
  if (b.meta) {
    s.push(cap(l.ankle, l.ball, b.meta.r0, b.meta.r1, { region: P.LEG }));
    // Hock bump: the heel joint sticks out behind.
    s.push(ell(side ? v(l.ankle.x - 0.3, l.ankle.y) : l.ankle, b.meta.r0 + 0.3, b.meta.r0 + 0.3, { region: P.LEG }));
    s.push(side ? cap(l.ball, l.toe, b.foot, b.foot - 0.5, { region: P.FOOT }) : ell(v(l.ball.x, l.ball.y + 0.3), b.foot + 1.2, b.foot, { region: P.FOOT }));
  } else {
    s.push(
      side
        ? cap(v(l.ankle.x - 1.2, l.ankle.y + 1), l.toe, b.foot, b.foot - 0.4, { region: P.FOOT })
        : ell(v(l.ball.x, l.ball.y), b.foot + 1, b.foot, { region: P.FOOT }),
    );
  }
  return s;
}

function armShapes(b: Build, a: Arm): Shape[] {
  return [
    ell(v(a.shoulder.x, a.shoulder.y + 1), b.delt * 0.85, b.delt, { region: P.ARM, z: 0.2 }),
    cap(a.shoulder, a.elbow, b.upperArm.r0, b.upperArm.r1, { region: P.ARM }),
    cap(a.elbow, a.hand, b.foreArm.r0, b.foreArm.r1, { region: P.ARM }),
    ell(v(a.hand.x, a.hand.y + b.hand * 0.6), b.hand * 0.9, b.hand * 1.1, { region: P.HAND }),
  ];
}

/** A tapering chain of capsules through `pts` (tails, tufts). */
function chain(pts: V[], r0: number, r1: number, region: number, z = 0): Shape[] {
  const out: Shape[] = [];
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const ra = r0 + ((r1 - r0) * i) / n;
    const rb = r0 + ((r1 - r0) * (i + 1)) / n;
    out.push(cap(pts[i]!, pts[i + 1]!, ra, rb, { region, z }));
  }
  return out;
}

type Dir = 'down' | 'up' | 'right';

// ---- bind skeleton & pieces ----------------------------------------------------------------

/** The bind pose: limbs straight and a little apart, so every piece can be drawn whole. */
interface Skeleton {
  hip: V;
  legs: [Leg, Leg];
  arms: [Arm, Arm];
  neck: V;
  tail: V | null;
}

function bindSkeleton(race: PlaceholderRace, dir: Dir): Skeleton {
  const b = BUILDS[race];
  const tailRoot = race === 'human' ? null : tailPoints(race, dir, 0, 0)[0]!;
  if (dir === 'right') {
    const hip = v(AX - 0.5, b.hipY);
    const legs: [Leg, Leg] = [sideLeg(b, v(hip.x + 0.6, hip.y), 0, 0), sideLeg(b, v(hip.x - 0.2, hip.y), 0, 0)];
    const arm = (dx: number): Arm => {
      const shoulder = v(AX - 0.6 + dx, b.shoulderY);
      const elbow = v(shoulder.x - 0.4, shoulder.y + b.upperArm.len);
      return { shoulder, elbow, hand: v(elbow.x + 1.4, elbow.y + b.foreArm.len) };
    };
    const lean = race === 'human' ? 0 : 0.6;
    return { hip, legs, arms: [arm(0.8), arm(-0.4)], neck: v(AX + 0.6 + lean, b.neck.top + 1.5), tail: tailRoot };
  }
  const hip = v(AX, b.hipY);
  const legs: [Leg, Leg] = [frontLeg(b, v(AX - b.hipX, b.hipY), 0, -1), frontLeg(b, v(AX + b.hipX, b.hipY), 0, 1)];
  const arm = (sx: number): Arm => {
    const shoulder = v(AX + sx * b.shoulderX, b.shoulderY);
    const elbow = v(shoulder.x + sx * 1.6, shoulder.y + b.upperArm.len);
    return { shoulder, elbow, hand: v(elbow.x + sx * 0.5, elbow.y + b.foreArm.len) };
  };
  return { hip, legs, arms: [arm(-1), arm(1)], neck: v(AX, b.neck.top + 1.5), tail: tailRoot };
}

/** Center of the hand (where a gun grip sits). */
const handCenter = (b: Build, a: Arm): V => v(a.hand.x, a.hand.y + b.hand * 0.6);

/** Draws one piece of the bind pose into `rig`. Returns false if the race has no such piece. */
function drawPiece(rig: Rig, race: PlaceholderRace, dir: Dir, part: PartId): boolean {
  const b = BUILDS[race];
  const sk = bindSkeleton(race, dir);
  const side = dir === 'right';
  const k = part.endsWith('A') ? 0 : 1;
  // In the side view the A limbs are the far ones: a shade darker.
  const far = side && k === 0 ? -1 : 0;
  switch (part) {
    case 'torso': {
      const torso = side
        ? rig.add({ region: P.TORSO, ramp: b.hide }, [
            cap(v(AX + 0.4 + (race === 'human' ? 0 : 0.6), b.neck.top), v(AX - 0.2, b.neck.bottom), b.neck.r, b.neck.r + 0.5, { region: P.NECK }),
            ell(v(AX + 0.6 + (race === 'human' ? 0 : 0.6), b.chest.y), b.chest.side, b.chest.ry, { region: P.TORSO }),
            ell(v(AX + 0.4, b.belly.y), b.belly.side, b.belly.ry, { region: P.TORSO, z: -0.4 }),
            ell(v(AX - 0.6, b.pelvis.y), b.pelvis.side, b.pelvis.ry, { region: P.HIP }),
          ])
        : rig.add({ region: P.TORSO, ramp: b.hide }, [
            cap(v(AX, b.neck.top), v(AX, b.neck.bottom), b.neck.r, b.neck.r + 0.6, { region: P.NECK }),
            // Trapezius: slopes from the neck down to the shoulders.
            cap(v(AX - 1.5, b.neck.bottom - 0.8), v(AX - b.shoulderX + 1.2, b.shoulderY + 0.6), 2.2, 2.4, { region: P.TORSO, z: -0.6 }),
            cap(v(AX + 1.5, b.neck.bottom - 0.8), v(AX + b.shoulderX - 1.2, b.shoulderY + 0.6), 2.2, 2.4, { region: P.TORSO, z: -0.6 }),
            ell(v(AX, b.chest.y), b.chest.rx, b.chest.ry, { region: P.TORSO }),
            ell(v(AX, b.belly.y), b.belly.rx, b.belly.ry, { region: P.TORSO, z: -0.5 }),
            ell(v(AX, b.pelvis.y), b.pelvis.rx, b.pelvis.ry, { region: P.HIP }),
          ]);
      bodyMarkings(rig, race, dir, b, torso, 0);
      if (dir === 'down') muscleLines(rig, b, 0, 0);
      return true;
    }
    case 'head':
    case 'headAlt':
      if (part === 'headAlt' && race === 'human') return false;
      head(rig, race, dir, b, part === 'headAlt' ? { sway: 0, tongue: race === 'lizardman', earTwitch: race === 'sergal' } : REST, 0);
      return true;
    case 'tail':
      if (race === 'human') return false;
      tail(rig, race, dir, REST, 0);
      return true;
    case 'upperArmA':
    case 'upperArmB': {
      const a = sk.arms[k];
      rig.add({ region: P.ARM, ramp: b.hide, toneShift: far }, [
        ell(v(a.shoulder.x, a.shoulder.y + 1), b.delt * 0.85, b.delt, { region: P.ARM, z: 0.2 }),
        cap(a.shoulder, a.elbow, b.upperArm.r0, b.upperArm.r1 + 0.2, { region: P.ARM }),
      ]);
      return true;
    }
    case 'lowerArmA':
    case 'lowerArmB': {
      const a = sk.arms[k];
      rig.add({ region: P.ARM, ramp: b.hide, toneShift: far }, [
        ell(a.elbow, b.upperArm.r1 + 0.1, b.upperArm.r1 + 0.1, { region: P.ARM }),
        cap(a.elbow, a.hand, b.foreArm.r0, b.foreArm.r1, { region: P.ARM }),
        ell(v(a.hand.x, a.hand.y + b.hand * 0.6), b.hand * 0.9, b.hand * 1.1, { region: P.HAND }),
      ]);
      if (race === 'sergal' && dir !== 'up') rig.decal(PALE, [cap(a.elbow, a.hand, 2.6, 2.8)], { regions: [P.ARM, P.HAND] });
      return true;
    }
    case 'upperLegA':
    case 'upperLegB': {
      const l = sk.legs[k];
      const leg = rig.add({ region: P.LEG, ramp: b.hide, toneShift: far }, [
        cap(l.hip, l.knee, b.thigh.r0, b.thigh.r1 + 0.2, { region: P.LEG }),
        ell(l.knee, b.thigh.r1 + 0.3, b.thigh.r1 + 0.3, { region: P.LEG }),
      ]);
      bodyMarkings(rig, race, dir, b, leg, 0);
      return true;
    }
    case 'lowerLegA':
    case 'lowerLegB': {
      const l = sk.legs[k];
      const shapes = legShapes(b, l, side).slice(1); // everything below the thigh
      shapes.unshift(ell(l.knee, b.shin.r0 + 0.1, b.shin.r0 + 0.1, { region: P.LEG }));
      rig.add({ region: P.LEG, ramp: b.hide, toneShift: far }, shapes);
      if (race === 'sergal' && dir !== 'up') legMarkings(rig, race, l);
      feetDetails(rig, race, [l], side);
      return true;
    }
  }
}

// ---- race details ----------------------------------------------------------------------

/** Pale bellies, shorts, loincloths. */
function bodyMarkings(rig: Rig, race: PlaceholderRace, dir: Dir, b: Build, torso: number, bob: number): void {
  const y = (n: number) => n + bob;
  const side = dir === 'right';
  if (race === 'human') {
    // Shorts over the pelvis (the legs get theirs below).
    const top = y(b.pelvis.y - 2.2);
    const hem = y(b.hipY + 5.6);
    // Big capsules whose top edge sits on the waistline.
    const shorts: Shape[] = side
      ? [cap(v(AX - 0.6, top + 6.2), v(AX - 0.6, hem - 5.4), 6.2, 5.4)]
      : [cap(v(AX - 2.2, top + 5), v(AX - 3.4, hem - 3.6), 5, 3.6), cap(v(AX + 2.2, top + 5), v(AX + 3.4, hem - 3.6), 5, 3.6)];
    rig.decal(SHORTS, shorts, { regions: [P.HIP, P.LEG, P.TORSO] });
    // Waistband and hem.
    for (let x = AX - 8; x <= AX + 8; x++) {
      if (rig.isPainted(x, Math.round(top)) && rig.regionAt(x, Math.round(top)) !== P.ARM && rig.regionAt(x, Math.round(top)) !== P.HAND) rig.mark(x, top, 1);
    }
    return;
  }
  const pale = race === 'sergal' ? PALE : BELLY;
  if (dir === 'down') {
    // Chest-to-belly underside, plus throat.
    rig.decal(pale, [ell(v(AX, y(b.chest.y + 1.6)), b.chest.rx - 2.3, b.chest.ry), ell(v(AX, y(b.belly.y)), b.belly.rx - 1.6, b.belly.ry + 0.8), cap(v(AX, y(b.neck.top)), v(AX, y(b.neck.bottom)), b.neck.r - 0.7)], { parts: [torso] });
  } else if (side) {
    rig.decal(pale, [ell(v(AX + 3.8, y(b.chest.y + 1.5)), 2.6, b.chest.ry + 0.5), ell(v(AX + 3.2, y(b.belly.y)), 2.4, b.belly.ry + 0.6), cap(v(AX + 2.2, y(b.neck.top)), v(AX + 2.8, y(b.neck.bottom)), 1.4)], { parts: [torso] });
  }
  if (race === 'lizardman' && dir === 'down') {
    // Belly plates.
    for (let r = 0; r < 4; r++) rig.markLine(v(AX - 2.5, y(b.belly.y - 2.5 + r * 2)), v(AX + 2.5, y(b.belly.y - 2.5 + r * 2)), 2);
  }
  // Loincloth.
  const cloth = race === 'sergal' ? LOIN : WRAP;
  if (side) rig.decal(cloth, [ell(v(AX - 0.6, y(b.pelvis.y + 0.4)), b.pelvis.side + 1, 2.2)], { parts: [torso] });
  else rig.decal(cloth, [ell(v(AX, y(b.pelvis.y + 0.4)), b.pelvis.rx + 1, 2.2)], { parts: [torso] });
}

function armMarkings(rig: Rig, race: PlaceholderRace, dir: Dir, arms: Arm[]): void {
  if (race !== 'sergal' || dir === 'up') return;
  // Pale forearms and hands.
  for (const a of arms) rig.decal(PALE, [cap(v((a.elbow.x * 2 + a.shoulder.x) / 3, (a.elbow.y * 2 + a.shoulder.y) / 3), a.hand, 2.4, 2.6)], { regions: [P.ARM, P.HAND] });
}

function legMarkings(rig: Rig, race: PlaceholderRace, l: Leg): void {
  if (race !== 'sergal') return;
  rig.decal(PALE, [cap(l.knee, l.ball, 2.6, 2.4), cap(l.ball, l.toe, 2.4)], { regions: [P.LEG, P.FOOT] });
}

function muscleLines(rig: Rig, b: Build, bob: number, rise: number): void {
  const y = (n: number) => n + bob;
  const cy = y(b.chest.y) - rise * 0.5;
  // Pectoral line and sternum, a hint of abs.
  rig.markLine(v(AX - 4.5, cy + 2.5), v(AX - 1, cy + 3.2), 2);
  rig.markLine(v(AX + 1, cy + 3.2), v(AX + 4.5, cy + 2.5), 2);
  rig.markLine(v(AX, cy - 1), v(AX, cy + 2), 2);
  rig.markLine(v(AX, y(b.belly.y - 2)), v(AX, y(b.belly.y + 2)), 2);
}

function feetDetails(rig: Rig, race: PlaceholderRace, legs: Leg[], side: boolean): void {
  if (race === 'human') return;
  // Dark claws on the toes.
  for (const l of legs) {
    if (side) {
      rig.dot(l.toe.x + 1.2, l.toe.y + 0.4, CLAW[1]);
    } else {
      for (const dx of [-1.6, 0, 1.6]) rig.dot(l.ball.x + dx, l.ball.y + 2, CLAW[1]);
    }
  }
}

function tailPoints(race: PlaceholderRace, dir: Dir, s: number, bob: number): V[] {
  const y = (n: number) => n + bob;
  if (race === 'sergal') {
    // Long and slender, curling at the ground into a fluffy pale tip.
    if (dir === 'right') return [v(28.5, y(37.5)), v(24, y(40.5)), v(19.5, y(45)), v(16.5 + s * 0.5, 50.5), v(16 + s, 55), v(18.5 + s, 57.4), v(22 + s, 57.2)];
    if (dir === 'down') return [v(35, y(37)), v(40, y(41)), v(44, y(46.5)), v(46 + s * 0.5, 52), v(45.5 + s, 56.6), v(42.5 + s, 58.2), v(39.5 + s, 57.4)];
    return [v(32, y(38)), v(32.5, y(44)), v(34 + s * 0.6, 50), v(37 + s, 55), v(41 + s, 57.6), v(44.5 + s, 57)];
  }
  // Lizardman: thick, heavy, tapering to a point on the ground.
  if (dir === 'right') return [v(28.5, y(36.5)), v(23, y(41)), v(17.5, y(46.5)), v(12.5 + s * 0.4, 52), v(8 + s, 56.4), v(3.5 + s, 58.6)];
  if (dir === 'down') return [v(35, y(37.5)), v(39.5, y(43)), v(43, y(49)), v(45.5 + s * 0.5, 54.5), v(47.5 + s, 58.6)];
  return [v(32, y(37.5)), v(32.2, y(44)), v(31.5 + s * 0.4, 50), v(29 + s, 55.4), v(24.5 + s, 58.6), v(20 + s, 59.4)];
}

function tail(rig: Rig, race: PlaceholderRace, dir: Dir, p: Pose, bob: number): void {
  if (race === 'human') return;
  const pts = tailPoints(race, dir, p.sway, bob);
  if (race === 'sergal') {
    const part = rig.add({ region: P.TAIL, ramp: KEY }, [...chain(pts, 2.1, 2.9, P.TAIL), ell(pts[pts.length - 2]!, 3, 2.6, { region: P.TAIL, z: 0.4 })]);
    rig.decal(PALE, [...chain(pts.slice(3), 3.2, 3.4, P.TAIL)], { parts: [part] });
    return;
  }
  const part = rig.add({ region: P.TAIL, ramp: KEY }, chain(pts, 3.8, 0.8, P.TAIL));
  if (dir === 'right') rig.decal(BELLY, chain(pts.map((q) => v(q.x + 0.6, q.y + 2.6)), 1.6, 0.4, P.TAIL), { parts: [part] });
}

// ---- heads ------------------------------------------------------------------------------

function head(rig: Rig, race: PlaceholderRace, dir: Dir, b: Build, p: Pose, bob: number): void {
  const hy = b.headY + bob;
  if (race === 'human') return humanHead(rig, dir, hy);
  if (race === 'sergal') return sergalHead(rig, dir, hy, p);
  return lizardHead(rig, dir, hy, p);
}

function humanHead(rig: Rig, dir: Dir, hy: number): void {
  if (dir === 'right') {
    rig.add({ region: P.HEAD, ramp: SKIN }, [
      ell(v(31.6, hy), 4.3, 5.2),
      ell(v(33.2, hy + 2.6), 3.2, 2.6, { region: P.HEAD }), // jaw
      tri(v(35.4, hy - 0.4), v(37.2, hy + 1.6), v(35.2, hy + 1.9), { region: P.HEAD }), // nose
      ell(v(30.4, hy + 0.6), 1.2, 1.7, { region: P.EAR, z: 3 }),
    ]);
    rig.dot(34.4, hy - 0.2, EYE_HUMAN, P.EYE);
    rig.markLine(v(33.6, hy - 1.6), v(35, hy - 1.7), 1); // brow
    // Hair: swept, with a messy fringe; beard along the jaw.
    rig.add({ region: P.HAIR, ramp: KEY }, [
      ell(v(31, hy - 2.6), 4.6, 3.4),
      cap(v(28.8, hy - 1.5), v(28.4, hy + 2.6), 2.6, 2),
      tri(v(33.5, hy - 5.5), v(36.5, hy - 2.6), v(33, hy - 2.4)),
      tri(v(29, hy - 5.6), v(31.5, hy - 7.6), v(32.6, hy - 5)),
      tri(v(26.6, hy - 3), v(28.4, hy - 5.2), v(28.6, hy - 1)),
    ]);
    rig.add({ region: P.HAIR, ramp: KEY, line: false }, [ell(v(33.8, hy + 3.4), 2.6, 1.6), cap(v(31.4, hy + 1.2), v(33, hy + 3.4), 1.1)]);
    rig.dot(35.6, hy + 2.6, MOUTH_IN[1], P.MOUTH);
    return;
  }
  const front = dir === 'down';
  rig.add({ region: P.HEAD, ramp: SKIN }, [
    ell(v(AX, hy), 4.5, 5.3),
    ell(v(AX - 4.6, hy + 0.6), 1.1, 1.6, { region: P.EAR }),
    ell(v(AX + 4.6, hy + 0.6), 1.1, 1.6, { region: P.EAR }),
  ]);
  if (front) {
    for (const sx of [-1, 1]) {
      rig.dot(AX + sx * 1.9, hy + 0.4, EYE_HUMAN, P.EYE);
      rig.mark(AX + sx * 2.2, hy - 1, 1);
    }
    rig.mark(AX, hy + 1.8, 1);
    rig.add({ region: P.HAIR, ramp: KEY }, [
      ell(v(AX, hy - 3.6), 5, 2.7),
      tri(v(AX - 5.2, hy - 2.2), v(AX - 3.6, hy - 6.8), v(AX - 0.8, hy - 4)),
      tri(v(AX - 1.8, hy - 4), v(AX + 0.8, hy - 7.8), v(AX + 3, hy - 4)),
      tri(v(AX + 1.6, hy - 4), v(AX + 5.6, hy - 6.4), v(AX + 5.4, hy - 1.2)),
      tri(v(AX - 4, hy - 3), v(AX - 0.4, hy - 2.4), v(AX - 3, hy - 1.4)),
      cap(v(AX - 4.6, hy - 2), v(AX - 4.4, hy + 1.4), 0.9),
      cap(v(AX + 4.6, hy - 2), v(AX + 4.4, hy + 1.4), 0.9),
    ]);
    // Short beard along the jaw.
    rig.add({ region: P.HAIR, ramp: KEY, line: false }, [ell(v(AX, hy + 4.2), 2.8, 1.3), cap(v(AX - 3.8, hy + 1.6), v(AX - 2, hy + 4), 0.8), cap(v(AX + 3.8, hy + 1.6), v(AX + 2, hy + 4), 0.8)]);
    rig.dot(AX - 0.5, hy + 3, MOUTH_IN[1], P.MOUTH);
    rig.dot(AX + 0.5, hy + 3, MOUTH_IN[1], P.MOUTH);
    return;
  }
  rig.add({ region: P.HAIR, ramp: KEY }, [ell(v(AX, hy - 1.2), 5, 4.8), ell(v(AX, hy + 2.6), 3.6, 2.2), tri(v(AX - 4, hy - 4), v(AX - 1.6, hy - 7.4), v(AX + 0.8, hy - 4.6)), tri(v(AX + 1.2, hy - 4.6), v(AX + 4.2, hy - 6.6), v(AX + 4.8, hy - 2.4))]);
}

/**
 * Sergal head, after the reference sheet: a long, flat, shark-like wedge with a
 * slender separate lower jaw, a pale muzzle and jaw, red eyes set high and far
 * back under a heavy brow, tall swept ears and a spiky mane.
 */
function sergalHead(rig: Rig, dir: Dir, hy: number, p: Pose): void {
  const twitch = p.earTwitch ? 1 : 0;
  if (dir === 'right') {
    // Far ear (behind everything).
    rig.add({ region: P.EAR, ramp: KEY, toneShift: -1 }, [tri(v(26.4, hy - 1.6), v(29.4, hy - 3), v(22.6 - twitch, hy - 10.6))]);
    // Mane: long spikes sweeping back and down the neck.
    rig.add({ region: P.HAIR, ramp: KEY }, [
      tri(v(28.4, hy - 2.4), v(29.4, hy + 0.6), v(22.4, hy - 0.4)),
      tri(v(28, hy), v(29, hy + 3.4), v(21.6, hy + 3.6)),
      tri(v(28.2, hy + 2.6), v(29.6, hy + 6.4), v(22.6, hy + 7.8)),
      tri(v(28.8, hy + 5.4), v(30.6, hy + 9), v(24.4, hy + 11.4)),
      tri(v(29.6, hy + 8.2), v(31.6, hy + 11.2), v(26.6, hy + 13.4)),
    ]);
    // Skull, then the long, flat upper snout (a flatter part of its own, so its top
    // catches the light): a tall wedge with a gently sloping top.
    const skull = rig.add({ region: P.HEAD, ramp: KEY }, [ell(v(30.4, hy - 0.8), 3.9, 3.3)]);
    const h = rig.add({ region: P.SNOUT, ramp: KEY, relief: 0.55, line: false }, [
      tri(v(29.8, hy - 3.6), v(41.6, hy - 0.4), v(30.4, hy + 3)),
      tri(v(30.4, hy + 3), v(41.6, hy - 0.4), v(41.6, hy + 2.6)),
      tri(v(41.4, hy - 0.4), v(44, hy + 1.2), v(41.4, hy + 2.6)),
    ]);
    // The front of the snout and its underside are pale; the bridge stays fur-colored.
    rig.decal(PALE, [tri(v(35.6, hy + 0.2), v(44.4, hy + 1), v(32, hy + 3.4)), ell(v(41.8, hy + 1.2), 2.4, 1.6)], { parts: [h, skull] });
    // Slender pale lower jaw under the snout; its top edge is the mouth line.
    rig.add({ region: P.SNOUT, ramp: PALE, line: false, shadow: false, relief: 0.45 }, [tri(v(30.4, hy + 2.2), v(31.4, hy + 6.8), v(42, hy + 2.8), { dome: 0.5 })]);
    rig.markLine(v(31.4, hy + 2.6), v(41.4, hy + 2.6), 0);
    rig.dot(31.8, hy + 3.6, MOUTH_IN[2], P.MOUTH);
    rig.dot(38, hy + 3.4, TOOTH, P.MOUTH);
    rig.dot(35, hy + 3.4, TOOTH, P.MOUTH);
    // Eye high and back on the snout, under a heavy brow.
    rig.markLine(v(32.2, hy - 2.8), v(36.2, hy - 1.6), 0);
    rig.dot(33.6, hy - 1.4, EYE_SERGAL, P.EYE);
    rig.dot(34.6, hy - 1, EYE_SERGAL, P.EYE);
    rig.dot(35.4, hy - 1, EYE_SERGAL_DARK, P.EYE);
    rig.dot(43.6, hy + 0.6, PUPIL, P.SNOUT); // nose
    // Near ear on top, with a pale inner edge.
    rig.add({ region: P.EAR, ramp: KEY }, [tri(v(28.2, hy - 2.2), v(31, hy - 3.2), v(25.4 - twitch, hy - 11.4))]);
    rig.decal(PALE, [tri(v(28.8, hy - 2.8), v(30, hy - 3.2), v(26.4 - twitch, hy - 8.6))], { regions: [P.EAR] });
    return;
  }
  const front = dir === 'down';
  // Ears: tall, set wide, leaning a little outward.
  for (const sx of [-1, 1]) {
    const tw = sx === 1 ? twitch : 0;
    rig.add({ region: P.EAR, ramp: KEY }, [tri(v(AX + sx * 1.6, hy - 2.8), v(AX + sx * 5.2, hy - 0.8), v(AX + sx * (6.2 + tw), hy - 11.2 + tw))]);
    if (front) rig.decal(PALE, [tri(v(AX + sx * 3, hy - 2.4), v(AX + sx * 4.8, hy - 1.4), v(AX + sx * 5.6, hy - 7.8))], { regions: [P.EAR] });
  }
  // Mane: spiky ruff flaring out from the cheeks and down the neck.
  rig.add({ region: P.HAIR, ramp: KEY }, [
    tri(v(AX - 3.6, hy - 0.4), v(AX - 8.6, hy + 1.6), v(AX - 3.8, hy + 3)),
    tri(v(AX - 3.6, hy + 2), v(AX - 8, hy + 5.6), v(AX - 2.8, hy + 5.4)),
    tri(v(AX - 3, hy + 4.4), v(AX - 6, hy + 9.4), v(AX - 1, hy + 7)),
    tri(v(AX + 3.6, hy - 0.4), v(AX + 8.6, hy + 1.6), v(AX + 3.8, hy + 3)),
    tri(v(AX + 3.6, hy + 2), v(AX + 8, hy + 5.6), v(AX + 2.8, hy + 5.4)),
    tri(v(AX + 3, hy + 4.4), v(AX + 6, hy + 9.4), v(AX + 1, hy + 7)),
  ]);
  if (front) {
    // Head-on, the long muzzle points at the viewer: a broad brow with the eyes at its
    // corners, the snout narrowing down to the nose, and the lower jaw showing on both
    // sides of it (drawn first, so the overlap draws the mouth lines).
    rig.add({ region: P.SNOUT, ramp: PALE, relief: 0.5 }, [tri(v(AX - 4.6, hy + 1.4), v(AX + 4.6, hy + 1.4), v(AX, hy + 8.6), { dome: 0.6 })]);
    const h = rig.add({ region: P.HEAD, ramp: KEY }, [
      ell(v(AX, hy - 1), 5.2, 3.6),
      tri(v(AX - 3.8, hy), v(AX + 3.8, hy), v(AX, hy + 7.4), { region: P.SNOUT, dome: 0.8 }),
    ]);
    // Pale muzzle below the eyes, as in the reference.
    rig.decal(PALE, [tri(v(AX - 3.9, hy + 0.6), v(AX + 3.9, hy + 0.6), v(AX, hy + 7.8))], { parts: [h] });
    for (const sx of [-1, 1]) {
      // Angled eyes at the corners of the brow, under a heavy brow line.
      rig.markLine(v(AX + sx * 1, hy - 1.2), v(AX + sx * 4.6, hy - 2.2), 0);
      rig.dot(AX + sx * 3.4, hy - 0.8, EYE_SERGAL, P.EYE);
      rig.dot(AX + sx * 2.4, hy - 0.6, EYE_SERGAL, P.EYE);
      rig.dot(AX + sx * 3.4, hy - 1.4, EYE_SERGAL_DARK, P.EYE);
      // Mouth line down each side of the muzzle, with a fang near the corner.
      rig.markLine(v(AX + sx * 3.9, hy + 1.8), v(AX + sx * 1, hy + 7), 0);
      rig.dot(AX + sx * 3.2, hy + 3.2, TOOTH, P.MOUTH);
    }
    rig.dot(AX, hy + 7, PUPIL, P.SNOUT); // nose
    return;
  }
  rig.add({ region: P.HEAD, ramp: KEY }, [ell(v(AX, hy - 0.6), 5, 4), ell(v(AX, hy + 2.4), 3.8, 2.8)]);
  rig.add({ region: P.HAIR, ramp: KEY }, [tri(v(AX - 2.6, hy + 0.6), v(AX + 2.6, hy + 0.6), v(AX, hy + 10.4)), tri(v(AX - 4.4, hy + 1.6), v(AX - 0.6, hy + 2.4), v(AX - 3, hy + 8.4)), tri(v(AX + 4.4, hy + 1.6), v(AX + 0.6, hy + 2.4), v(AX + 3, hy + 8.4))]);
}

function lizardHead(rig: Rig, dir: Dir, hy: number, p: Pose): void {
  if (dir === 'right') {
    // Blunt snout, heavy jaw, a crest of spikes down the back of the head.
    rig.add({ region: P.HAIR, ramp: KEY }, [
      tri(v(28, hy - 3.4), v(26.2, hy - 6.2), v(30, hy - 4.4)),
      tri(v(27, hy - 1), v(24.4, hy - 2.6), v(27.6, hy + 1.2)),
      tri(v(27.4, hy + 2.4), v(25, hy + 2.6), v(28.4, hy + 4.6)),
    ]);
    const h = rig.add({ region: P.HEAD, ramp: KEY }, [
      ell(v(30.8, hy - 0.4), 4.2, 4.2),
      cap(v(32.6, hy + 0.6), v(38.2, hy + 1.4), 3, 2.3, { region: P.SNOUT }),
      cap(v(31.6, hy + 3), v(36.6, hy + 3.4), 2.4, 1.6, { region: P.SNOUT, z: -0.5 }),
    ]);
    rig.decal(BELLY, [cap(v(30.6, hy + 4), v(36.2, hy + 4.1), 1.8, 1.2)], { parts: [h] });
    rig.dot(33.4, hy - 1, EYE_LIZARD, P.EYE);
    rig.dot(34.2, hy - 1, PUPIL, P.EYE);
    rig.dot(33.4, hy - 0.2, EYE_LIZARD_HI, P.EYE);
    rig.markLine(v(32.6, hy - 2.4), v(34.6, hy - 2.2), 1);
    rig.dot(38.6, hy + 0.2, KEY[0], P.SNOUT);
    rig.markLine(v(33.4, hy + 2.6), v(39.4, hy + 2.6), 0);
    if (p.tongue) {
      for (let i = 0; i < 4; i++) rig.dot(40 + i, hy + 2.6, TONGUE, P.MOUTH);
      rig.dot(44, hy + 1.8, TONGUE, P.MOUTH);
      rig.dot(44, hy + 3.4, TONGUE_DARK, P.MOUTH);
    }
    return;
  }
  const front = dir === 'down';
  // Crest.
  rig.add({ region: P.HAIR, ramp: KEY }, front
    ? [tri(v(AX - 2.2, hy - 3.4), v(AX - 0.4, hy - 7), v(AX + 0.6, hy - 3.8)), tri(v(AX - 0.4, hy - 3.8), v(AX + 1.4, hy - 6.4), v(AX + 2.6, hy - 3.4))]
    : [tri(v(AX - 1.4, hy - 3), v(AX, hy - 7), v(AX + 1.4, hy - 3)), tri(v(AX - 1.4, hy + 1), v(AX, hy - 2.6), v(AX + 1.4, hy + 1)), tri(v(AX - 1.4, hy + 4.4), v(AX, hy + 1.4), v(AX + 1.4, hy + 4.4))]);
  if (front) {
    const h = rig.add({ region: P.HEAD, ramp: KEY }, [
      ell(v(AX, hy - 0.6), 5, 4.4),
      ell(v(AX, hy + 2.6), 4.4, 2.8, { region: P.SNOUT }),
    ]);
    rig.decal(BELLY, [ell(v(AX, hy + 4.6), 3.2, 1.6)], { parts: [h] });
    for (const sx of [-1, 1]) {
      rig.dot(AX + sx * 3.6, hy - 1, EYE_LIZARD, P.EYE);
      rig.dot(AX + sx * 3, hy - 1, PUPIL, P.EYE);
      rig.dot(AX + sx * 3.6, hy - 0.2, EYE_LIZARD_HI, P.EYE);
      rig.markLine(v(AX + sx * 2.4, hy - 2.6), v(AX + sx * 4.6, hy - 2.2), 1);
      rig.dot(AX + sx * 1, hy + 1.6, KEY[0], P.SNOUT);
    }
    rig.markLine(v(AX - 3, hy + 3.6), v(AX + 3, hy + 3.6), 0);
    if (p.tongue) {
      rig.dot(AX, hy + 4.6, TONGUE, P.MOUTH);
      rig.dot(AX, hy + 5.6, TONGUE, P.MOUTH);
      rig.dot(AX - 1, hy + 6.6, TONGUE, P.MOUTH);
      rig.dot(AX + 1, hy + 6.6, TONGUE_DARK, P.MOUTH);
    }
    return;
  }
  rig.add({ region: P.HEAD, ramp: KEY }, [ell(v(AX, hy - 0.4), 5, 4.6), ell(v(AX, hy + 2.4), 4.2, 2.6)]);
}

// ---- public API ---------------------------------------------------------------------

/** Where each piece's pivot sits inside its atlas cell (pieces hang down / up from it). */
function pivotCell(part: PartId, dir: Dir): Pt {
  switch (part) {
    case 'torso':
      return { x: 24, y: 40 };
    case 'head':
    case 'headAlt':
      return { x: 24, y: 34 };
    case 'tail':
      return dir === 'right' ? { x: 40, y: 8 } : dir === 'down' ? { x: 10, y: 8 } : { x: 18, y: 8 };
    default:
      return { x: 24, y: 8 };
  }
}

/** The joint a piece hangs from, in the bind pose (frame space). */
function pieceJoint(race: PlaceholderRace, dir: Dir, part: PartId): V {
  const sk = bindSkeleton(race, dir);
  const k = part.endsWith('A') ? 0 : 1;
  switch (part) {
    case 'torso':
      return sk.hip;
    case 'head':
    case 'headAlt':
      return sk.neck;
    case 'tail':
      return sk.tail ?? sk.hip;
    case 'upperArmA':
    case 'upperArmB':
      return sk.arms[k].shoulder;
    case 'lowerArmA':
    case 'lowerArmB':
      return sk.arms[k].elbow;
    case 'upperLegA':
    case 'upperLegB':
      return sk.legs[k].hip;
    default:
      return sk.legs[k].knee;
  }
}

/** How a piece drawn in the 64px frame maps into its atlas cell: cell = frame - offset. */
export function pieceWindow(race: PlaceholderRace, dir: Dir, part: PartId): { ox: number; oy: number; joint: Pt; pivot: Pt } {
  const joint = pieceJoint(race, dir, part);
  const pc = pivotCell(part, dir);
  const ox = Math.round(joint.x) - pc.x;
  const oy = Math.round(joint.y) - pc.y;
  return { ox, oy, joint, pivot: { x: joint.x - ox, y: joint.y - oy } };
}

/** One piece in the bind pose, before finishing (for armor fitting), or null if the race lacks it. */
export function rigPiece(race: PlaceholderRace, dir: Dir, part: PartId): Rig | null {
  const rig = new Rig(FRAME, FRAME);
  return drawPiece(rig, race, dir, part) ? rig : null;
}

/** Copies a 64px piece drawing into its cell of an atlas. */
export function blitPiece(atlas: PixelCanvas, piece: PixelCanvas, race: PlaceholderRace, dir: Dir, part: PartId): void {
  const { ox, oy } = pieceWindow(race, dir, part);
  const col = PUPPET_PARTS.indexOf(part);
  const row = PUPPET_DIRS.indexOf(dir);
  for (let y = 0; y < FRAME; y++) {
    for (let x = 0; x < FRAME; x++) {
      const a = piece.alpha(x, y);
      if (!a) continue;
      const cx = x - ox;
      const cy = y - oy;
      if (cx < 0 || cy < 0 || cx >= CELL || cy >= CELL) continue;
      atlas.region = piece.regionAt(x, y);
      atlas.set(col * CELL + cx, row * CELL + cy, piece.get(x, y), a);
    }
  }
}

/** The atlas size for one race: a row per facing, a column per piece. */
export const ATLAS_WIDTH = CELL * PUPPET_PARTS.length;
export const ATLAS_HEIGHT = CELL * PUPPET_DIRS.length;

/** The rig (joints and pivots) for a race's generated pieces. */
export function placeholderRig(race: PlaceholderRace): PuppetRig {
  const b = BUILDS[race];
  const dirs = {} as PuppetRig['dirs'];
  for (const dir of PUPPET_DIRS) {
    const sk = bindSkeleton(race, dir);
    const parts: PuppetRig['dirs'][PuppetDir]['parts'] = {};
    for (const part of PUPPET_PARTS) {
      if ((part === 'tail' || part === 'headAlt') && race === 'human') continue;
      const w = pieceWindow(race, dir, part);
      parts[part] = { joint: w.joint, pivot: w.pivot };
    }
    dirs[dir] = {
      parts,
      elbow: [sk.arms[0].elbow, sk.arms[1].elbow],
      hand: [handCenter(b, sk.arms[0]), handCenter(b, sk.arms[1])],
      knee: [sk.legs[0].knee, sk.legs[1].knee],
      foot: [sk.legs[0].ball, sk.legs[1].ball],
    };
  }
  return { cell: CELL, anchor: { x: AX, y: GROUND }, dirs, digitigrade: !!b.meta };
}

/** Draws a race's full piece atlas (body layer). Region tags are kept for tests and armor. */
export function generatePuppetAtlas(race: PlaceholderRace): PixelCanvas {
  const atlas = new PixelCanvas(ATLAS_WIDTH, ATLAS_HEIGHT).enableRegions();
  for (const dir of PUPPET_DIRS) {
    for (const part of PUPPET_PARTS) {
      const rig = rigPiece(race, dir, part);
      if (rig) blitPiece(atlas, rig.finish(), race, dir, part);
    }
  }
  return atlas;
}

/** Generic dark outline for small generated art (items, weapons). */
export const PLACEHOLDER_OUTLINE: RGB = [28, 20, 26];

export function isPlaceholderRace(id: string): id is PlaceholderRace {
  return (PLACEHOLDER_RACES as readonly string[]).includes(id);
}

