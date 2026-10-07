import type { BodyPlan, CreatureDef } from '../content/types/creature';
import { buildRamp, hexToRgb, type RGB } from './palette';
import { PixelCanvas } from './PixelCanvas';
import { Rig, type Ramp, type Shape } from './placeholder/rig';

/**
 * Procedural creatures.
 *
 * A creature is a little 3D skeleton of tapered capsules (spine, neck, head,
 * jaw, legs, tail, plus extras like horns or mandibles) built from its body
 * def. Every frame the skeleton is posed (a gait from the distance walked,
 * attacks, crouches, leaps, lying down, dead), turned to face its heading,
 * projected into the game's 3/4 view (screen y = ground y − height), and
 * painted back to front with the same pixel-art rasterizer as the characters
 * (`placeholder/rig.ts`): lit from the top-left, quantized to a 5-tone ramp,
 * with colored outlines. So creatures turn smoothly in any direction and
 * still look hand-pixeled.
 *
 * Local axes: f forward, s to its right, z up (px).
 */

export interface P3 {
  f: number;
  s: number;
  z: number;
}

const p3 = (f: number, s: number, z: number): P3 => ({ f, s, z });
const add = (a: P3, b: P3): P3 => ({ f: a.f + b.f, s: a.s + b.s, z: a.z + b.z });
const sub = (a: P3, b: P3): P3 => ({ f: a.f - b.f, s: a.s - b.s, z: a.z - b.z });
const mul = (a: P3, k: number): P3 => ({ f: a.f * k, s: a.s * k, z: a.z * k });
const len = (a: P3): number => Math.hypot(a.f, a.s, a.z);
const norm = (a: P3): P3 => mul(a, 1 / (len(a) || 1));
const dot = (a: P3, b: P3): number => a.f * b.f + a.s * b.s + a.z * b.z;
const lerp3 = (a: P3, b: P3, t: number): P3 => add(a, mul(sub(b, a), t));

export type RampId = 'hide' | 'belly' | 'accent' | 'bone' | 'dark' | 'eye' | 'mask';

interface Prim {
  a: P3;
  b: P3;
  ra: number;
  rb: number;
}

/** One painted piece: its capsules share shading and an outline. */
interface Part {
  id: string;
  prims: Prim[];
  ramp: RampId;
  /** Draw right after this part (eyes on a head), regardless of depth. */
  over?: string;
  toneShift?: number;
  relief?: number;
  /** Body markings (stripes, spots) and a pale belly are painted onto it. */
  pattern?: boolean;
  /** Eyes: drawn flat; glowing ones are reported for the night overlay. */
  eye?: boolean;
  line?: boolean;
}

export interface CreatureModel {
  id: string;
  plan: BodyPlan;
  features: Set<string>;
  /** Body length, spine height at the hips, shoulder height. */
  L: number;
  hipH: number;
  shoulderH: number;
  hipR: number;
  chestR: number;
  neckLen: number;
  neckR: number;
  headR: number;
  snoutLen: number;
  legR: number;
  tailLen: number;
  tailR: number;
  ears: CreatureDef['body']['ears'];
  eyes: { count: number; glow: boolean; color: string };
  pattern: CreatureDef['body']['pattern'];
  hunch: number;
  segments: number;
  ramps: Record<RampId, Ramp>;
  eyeRgb: RGB;
  /** Gait: distance covered by one stride cycle at a walk and a run (px). */
  stride: { walk: number; run: number };
  /** Canvas reach: horizontal radius and height above the feet (px). */
  reach: number;
  up: number;
  /** Size of the ground shadow (half width, px). */
  shadow: number;
}

const clampMin = (v: number, m: number) => Math.max(m, v);

/** Turns a creature def into the measurements the poser uses. Pure; cache it per def. */
export function creatureModel(def: CreatureDef): CreatureModel {
  const b = def.body;
  const L = b.length;
  const build = b.build;
  const plan = b.plan;
  const features = new Set<string>(b.features);
  const hipR = clampMin(L * (plan === 'biped' ? 0.26 : 0.2) * build, 1.5);
  const chestR = clampMin(L * (plan === 'biped' ? 0.32 : 0.24) * build, 1.8);
  const headR = clampMin(L * (plan === 'biped' ? 0.3 : plan === 'serpent' ? 0.09 : 0.14) * b.head, 1.5);
  const hide = b.colors.hide;
  const ramps: Record<RampId, Ramp> = {
    hide: ramp(hide),
    belly: ramp(b.colors.belly ?? mix(hide, '#e8dcc0', 0.45)),
    accent: ramp(b.colors.accent ?? mix(hide, '#202020', 0.4)),
    bone: ramp(b.colors.bone),
    dark: ramp(mix(hide, '#300c10', 0.75)),
    eye: ramp(b.eyes.color),
    mask: ramp(b.colors.accent ?? '#5a5e52'),
  };
  const tailLen = L * b.tail;
  const neckLen = L * b.neck;
  const hipH = b.height;
  const shoulderH = hipH * (1 + b.slope);
  const snoutLen = L * 0.2 * b.snout;
  const spread = plan === 'hexapod' && b.neck < 0.2 ? hipH * 2.4 : 0;
  const tailR = clampMin(hipR * 0.32 * b.tailWidth, 0.8);
  const reach0 = Math.ceil(
    (L / 2 + Math.max(neckLen + headR * 2.2 + snoutLen, tailLen + tailR * 2 + (features.has('tailClub') ? tailR * 3 : 0) + 2) + spread + (features.has('mandibles') ? headR * 1.5 : 0)) * 1.08 + 6,
  );
  // Bipeds lie their full height along the ground when dead.
  const reach = plan === 'biped' ? Math.max(reach0, Math.ceil(b.height + L + headR * 2.5 + 6)) : reach0;
  const up = Math.ceil(
    plan === 'biped'
      ? hipH + L + headR * 2.5 + 4
      : plan === 'serpent'
        ? L * 0.45 + headR * 2 + 4
        : Math.max(hipH + chestR, shoulderH + neckLen * 0.8 + headR * 2.2 + (features.has('horns') ? headR * 1.6 : 0) + (b.ears === 'long' ? headR * 1.4 : headR * 0.8)) +
          (features.has('spikes') || features.has('frill') ? chestR * 0.9 : 0) +
          4,
  );
  return {
    id: def.id,
    plan,
    features,
    L,
    hipH,
    shoulderH,
    hipR,
    chestR,
    neckLen,
    neckR: clampMin(chestR * 0.5, 1.2),
    headR,
    snoutLen,
    legR: clampMin(L * (plan === 'biped' ? 0.085 : 0.045) * b.legs * Math.sqrt(build), 0.9),
    tailLen,
    tailR,
    ears: b.ears,
    eyes: b.eyes,
    pattern: b.pattern,
    hunch: b.hunch,
    segments: b.segments,
    ramps,
    eyeRgb: hexToRgb(b.eyes.color),
    stride: { walk: hipH * 1.3 + L * 0.35, run: (hipH * 1.3 + L * 0.35) * 2.1 },
    reach,
    up,
    shadow: Math.max(4, (plan === 'biped' ? hipR * 1.6 : L * 0.45) * (plan === 'hexapod' && spread ? 1.4 : 1)),
  };
}

function ramp(hex: string): Ramp {
  return buildRamp(hex) as unknown as Ramp;
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i]! - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---- posing ------------------------------------------------------------------

export type CreatureAction = 'none' | 'alert' | 'windup' | 'strike' | 'charge' | 'leap' | 'spit' | 'drain' | 'rest';

export interface CreaturePose {
  /** Facing, radians (screen space: 0 = east, π/2 = south). */
  heading: number;
  /** 0 standing .. 1 walking .. 2 running flat out. */
  gait: number;
  /** Stride cycles walked so far. */
  phase: number;
  time: number;
  action: CreatureAction;
  /** 0..1 progress through the action. */
  actionT: number;
  /** Which attack is being made (bite, claw, charge...), for the strike shape. */
  attack?: string;
  dead?: boolean;
  /** Serpents: where the body has been, newest first, relative to the head (world px, ground plane). */
  trail?: { x: number; y: number }[];
  /** Serpents: 0 on the surface .. 1 fully under the ground. */
  buried?: number;
}

export const restPose = (heading = Math.PI / 2): CreaturePose => ({ heading, gait: 0, phase: 0, time: 0, action: 'none', actionT: 0 });

const TAU = Math.PI * 2;

/** One foot's offset through a stride: forward offset (−½..½ of the stride) and lift. */
function footCycle(p: number, stance: number, stride: number, lift: number): { df: number; z: number } {
  p -= Math.floor(p);
  if (p < stance) return { df: stride * (0.5 - p / stance), z: 0 };
  const q = (p - stance) / (1 - stance);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * q);
  return { df: stride * (-0.5 + e), z: lift * Math.sin(Math.PI * q) };
}

/** Two-bone IK: the knee, bending toward `bend` (a direction). */
function knee(hip: P3, foot: P3, l1: number, l2: number, bend: P3): P3 {
  const d0 = sub(foot, hip);
  const d = Math.min(len(d0), l1 + l2 - 0.01);
  const dir = norm(d0);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let perp = sub(bend, mul(dir, dot(bend, dir)));
  if (len(perp) < 1e-4) perp = p3(0, 0, 1);
  return add(add(hip, mul(dir, a)), mul(norm(perp), h));
}

const smooth = (t: number) => t * t * (3 - 2 * t);
/** 0 → 1 → 0 over an action. */
const bump = (t: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, t)));

/** Builds the posed skeleton as paintable parts (local coordinates). */
export function poseCreature(m: CreatureModel, pose: CreaturePose): Part[] {
  switch (m.plan) {
    case 'quadruped':
      return poseQuadruped(m, pose, 4);
    case 'hexapod':
      return poseQuadruped(m, pose, 6);
    case 'biped':
      return poseBiped(m, pose);
    case 'serpent':
      return poseSerpent(m, pose);
  }
}

interface Frame {
  /** Body origin shift (bounce, crouch). */
  dz: number;
  /** Pitch of the spine (nose up +), radians. */
  pitch: number;
}

function poseQuadruped(m: CreatureModel, pose: CreaturePose, legs: 4 | 6): Part[] {
  const parts: Part[] = [];
  const { L, hipR, chestR } = m;
  const t = pose.time;
  const act = pose.action;
  const at = pose.actionT;
  const moving = Math.min(1, pose.gait);
  const running = Math.max(0, Math.min(1, pose.gait - 1));
  const insect = legs === 6 && m.neckLen < L * 0.2;
  const rest = act === 'rest' ? 1 : 0;

  // Body height: crouch before a pounce / strike, sink down to rest, bounce when running.
  let crouch = 0;
  if (act === 'windup') crouch = smooth(Math.min(1, at * 1.6)) * (pose.attack === 'leap' ? 0.3 : 0.14);
  if (act === 'rest') crouch = 0.5;
  const bounce = running * Math.abs(Math.sin(pose.phase * TAU)) * m.hipH * 0.12 + moving * (1 - running) * Math.abs(Math.sin(pose.phase * TAU * 2)) * m.hipH * 0.03;
  const breathe = Math.sin(t * 2.4) * 0.35 * (1 - moving);
  const frame: Frame = { dz: -crouch * m.hipH + bounce, pitch: 0 };
  if (running) frame.pitch = Math.sin(pose.phase * TAU) * 0.12 * running;
  if (act === 'leap') frame.pitch = 0.25 - at * 0.5;
  if (act === 'charge') frame.pitch = -0.08;
  const hipZ = m.hipH + frame.dz;
  const shZ = m.shoulderH + frame.dz;
  const pitchZ = (f: number) => f * Math.sin(frame.pitch);

  const rump = insect ? p3(-chestR * 0.4, 0, hipZ) : p3(-L / 2, 0, hipZ + pitchZ(-L / 2));
  const chest = insect ? p3(chestR * 0.35, 0, shZ) : p3(L / 2, 0, shZ + pitchZ(L / 2));

  // ---- torso
  if (insect) {
    // Thorax and a big abdomen behind it, slightly raised.
    const abdA = p3(-chestR * 0.6, 0, hipZ + chestR * 0.15);
    const abdB = p3(-L * 0.55, 0, hipZ + chestR * 0.35 + Math.sin(t * 3) * 0.4);
    parts.push({ id: 'abdomen', ramp: 'hide', pattern: true, prims: [{ a: abdA, b: abdB, ra: hipR * 1.25 + breathe * 0.4, rb: hipR * 0.75 }] });
    parts.push({ id: 'torso', ramp: 'hide', pattern: true, prims: [{ a: rump, b: chest, ra: chestR * 0.9, rb: chestR }] });
    if (m.features.has('carapace')) {
      parts.push({ id: 'shell', ramp: 'accent', over: 'abdomen', relief: 1.3, prims: [{ a: add(abdA, p3(0, 0, hipR * 0.35)), b: add(abdB, p3(0, 0, hipR * 0.25)), ra: hipR * 1.05, rb: hipR * 0.55 }] });
    }
    if (m.features.has('sac')) {
      const pulse = 1 + Math.sin(t * 4) * 0.06;
      parts.push({ id: 'sac', ramp: 'accent', relief: 0.8, prims: [{ a: add(abdB, p3(chestR * 0.3, 0, hipR * 0.5)), b: add(abdB, p3(-hipR * 0.4, 0, hipR * 0.7)), ra: hipR * 0.9 * pulse, rb: hipR * 0.8 * pulse }] });
    }
  } else {
    // Spine, plus a deep chest, rounded haunches and a sagging belly so it reads as an animal, not a tube.
    const mid = lerp3(rump, chest, 0.5);
    parts.push({
      id: 'torso',
      ramp: 'hide',
      pattern: true,
      prims: [
        { a: rump, b: chest, ra: hipR * 0.9 + breathe * 0.3, rb: chestR * 0.9 + breathe * 0.4 },
        { a: add(chest, p3(-chestR * 0.35, 0, chestR * 0.12)), b: add(chest, p3(-chestR * 0.1, 0, -chestR * 0.22)), ra: chestR * 1.08, rb: chestR * 1.02 },
        { a: add(rump, p3(hipR * 0.35, 0, hipR * 0.12)), b: add(rump, p3(hipR * 0.15, 0, -hipR * 0.1)), ra: hipR * 1.04, rb: hipR },
        { a: add(mid, p3(-L * 0.12, 0, -hipR * 0.3)), b: add(mid, p3(L * 0.12, 0, -chestR * 0.3)), ra: (hipR + chestR) * 0.42, rb: (hipR + chestR) * 0.45 },
      ],
    });
    if (m.features.has('sac')) {
      const pulse = 1 + Math.sin(t * 4) * 0.06;
      parts.push({ id: 'sac', ramp: 'accent', relief: 0.8, prims: [{ a: add(rump, p3(L * 0.15, 0, hipR * 0.6)), b: add(rump, p3(L * 0.05, 0, hipR * 0.9)), ra: hipR * 0.95 * pulse, rb: hipR * 0.8 * pulse }] });
    }
  }

  // ---- back features: spikes, plates, mane
  const spineAt = (u: number, up: number) => {
    const p = lerp3(rump, chest, u);
    const r = (insect ? chestR : hipR + (chestR - hipR) * u) * up;
    return add(p, p3(0, 0, r));
  };
  if (m.features.has('spikes') || m.features.has('plates')) {
    const plates = m.features.has('plates');
    const n = Math.max(3, Math.round(L / (plates ? 7 : 5)));
    for (let i = 0; i < n; i++) {
      const u = 0.1 + (0.85 * i) / (n - 1);
      const base = spineAt(u, 0.75);
      const h = (plates ? chestR * 0.9 : chestR * 0.75) * (0.6 + 0.4 * Math.sin(Math.PI * u));
      const tip = add(base, plates ? p3(-h * 0.25, 0, h) : p3(-h * 0.35, 0, h));
      parts.push({
        id: `spike${i}`,
        ramp: plates ? 'accent' : 'bone',
        relief: plates ? 0.6 : 1,
        prims: [{ a: base, b: tip, ra: plates ? h * 0.42 : clampMin(h * 0.22, 0.9), rb: plates ? h * 0.12 : 0.5 }],
      });
    }
  }
  if (m.features.has('mane')) {
    // Bristles along the shoulders and neck.
    const tufts: Prim[] = [];
    for (let i = 0; i < 7; i++) {
      const base = spineAt(0.45 + i * 0.09, 0.85);
      const h = chestR * (0.35 + 0.25 * Math.sin((i / 6) * Math.PI));
      tufts.push({ a: base, b: add(base, p3(-h * 0.8, (i % 2 ? 1 : -1) * 0.6, h)), ra: clampMin(chestR * 0.2, 0.9), rb: 0.5 });
    }
    parts.push({ id: 'mane', ramp: 'accent', relief: 0.6, prims: tufts });
  }

  // ---- legs
  const stance = running ? 0.38 : 0.62;
  const stride = (running ? m.stride.run : m.stride.walk) * moving * 0.55;
  const lift = m.hipH * (running ? 0.35 : 0.22) * moving;
  // Phase offsets: quadrupeds walk (LH, LF, RH, RF) and gallop; insects use tripods.
  const quadWalk = [0.25, 0.75, 0, 0.5]; // LF, RF, LH, RH
  const quadRun = [0.45, 0.55, 0, 0.1];
  const legSpec: { f: number; side: 1 | -1; off: number; front: boolean }[] = [];
  if (legs === 4) {
    const k = running ? quadRun : quadWalk;
    legSpec.push({ f: L / 2 - chestR * 0.35, side: -1, off: k[0]!, front: true });
    legSpec.push({ f: L / 2 - chestR * 0.35, side: 1, off: k[1]!, front: true });
    legSpec.push({ f: -L / 2 + hipR * 0.35, side: -1, off: k[2]!, front: false });
    legSpec.push({ f: -L / 2 + hipR * 0.35, side: 1, off: k[3]!, front: false });
  } else {
    const fs = insect ? [chestR * 0.6, chestR * 0.05, -chestR * 0.5] : [L / 2 - chestR * 0.3, 0, -L / 2 + hipR * 0.3];
    fs.forEach((f, i) => {
      legSpec.push({ f, side: -1, off: i % 2 === 0 ? 0 : 0.5, front: i === 0 });
      legSpec.push({ f, side: 1, off: i % 2 === 0 ? 0.5 : 0, front: i === 0 });
    });
  }
  for (let i = 0; i < legSpec.length; i++) {
    const lg = legSpec[i]!;
    const r = insect ? chestR : lg.front ? chestR : hipR;
    const bodyZ = (insect ? hipZ : lg.front ? shZ : hipZ) + pitchZ(lg.f);
    const hip = p3(lg.f, lg.side * r * (insect ? 0.75 : 0.5), bodyZ - r * (insect ? 0.1 : 0.35));
    const legLen = insect ? m.hipH * 1.25 : bodyZ - r * 0.35 + m.hipH * 0.12 * (1 + crouch * 2);
    const upper = insect ? legLen * 0.85 : (m.hipH - r * 0.35) * 0.58;
    const lower = insect ? legLen * 1.05 : (m.hipH - r * 0.35) * 0.58;
    let foot: P3;
    if (pose.dead) {
      foot = p3(lg.f + (lg.front ? 2 : -2), hip.s * (insect ? 2.4 : 1.1), 0);
    } else if (act === 'leap' && !insect) {
      // Airborne: forelegs reach ahead, hind legs push back.
      foot = add(hip, lg.front ? p3(upper * 1.1, 0, -upper * 0.8) : p3(-upper * 1.2, 0, -upper * 0.7));
    } else if (rest) {
      foot = p3(lg.f + (lg.front ? upper * 0.6 : -upper * 0.2), hip.s * (insect ? 1.8 : 1.3), 0);
    } else {
      const c = footCycle(pose.phase + lg.off, stance, stride, lift);
      const splay = insect ? hip.s + lg.side * upper * 0.95 : hip.s * 1.08;
      foot = p3(lg.f + c.df + (insect ? (lg.front ? upper * 0.35 : i >= 4 ? -upper * 0.35 : 0) : 0), splay, c.z);
    }
    const bend = insect ? p3(0, lg.side * 0.4, 1) : lg.front ? p3(-1, 0, 0) : p3(1, 0, 0);
    const kn = knee(hip, foot, upper, lower, bend);
    const lr = m.legR * (insect ? 0.8 : 1);
    const prims: Prim[] = [
      { a: hip, b: kn, ra: lr * (insect ? 1.1 : 1.45), rb: lr },
      { a: kn, b: foot, ra: lr, rb: lr * 0.8 },
    ];
    if (!insect) prims.push({ a: foot, b: add(foot, p3(lr * 0.9, 0, 0)), ra: lr * 1.05, rb: lr * 0.9 });
    parts.push({ id: `leg${i}`, ramp: 'hide', toneShift: lg.side < 0 ? -1 : 0, prims });
    if (m.features.has('claws') && !insect) {
      parts.push({ id: `claw${i}`, ramp: 'bone', over: `leg${i}`, line: false, prims: [{ a: add(foot, p3(lr * 1.2, 0, 0)), b: add(foot, p3(lr * 2.3, 0, -0.3)), ra: 0.7, rb: 0.4 }] });
    }
  }

  // ---- neck and head
  const alertLift = act === 'alert' ? 0.35 : 0;
  let neckPitch = (insect ? 0 : 0.7) + alertLift - running * 0.35 - rest * 0.6;
  let reachOut = 0;
  let jaw = 0;
  if (act === 'windup') {
    if (pose.attack === 'spit') neckPitch += 0.5 * smooth(at);
    else if (pose.attack === 'charge') neckPitch -= 0.7 * smooth(at);
    else neckPitch -= 0.25 * smooth(at);
    reachOut = -0.15 * smooth(at);
    jaw = pose.attack === 'spit' ? 0.3 * at : 0.15 * at;
  }
  if (act === 'charge') neckPitch -= 0.7;
  if (act === 'strike' || act === 'drain') {
    const k = act === 'drain' ? 0.6 + Math.sin(t * 9) * 0.15 : bump(at);
    reachOut = (pose.attack === 'spit' ? 0.2 : 0.55) * k;
    jaw = 0.9 * k;
    if (pose.attack === 'spit') neckPitch += 0.2 * (1 - at);
  }
  const neckBase = insect ? add(chest, p3(chestR * 0.6, 0, 0)) : add(chest, p3(chestR * 0.35, 0, chestR * 0.3));
  const nl = m.neckLen * (1 + reachOut);
  const neckDir = p3(Math.cos(neckPitch), 0, Math.sin(neckPitch));
  const headC = insect ? add(neckBase, p3(m.headR * 0.7 + m.L * reachOut * 0.3, 0, -m.headR * 0.1)) : add(neckBase, mul(neckDir, nl));
  if (!insect && m.neckLen > 0.5) {
    parts.push({ id: 'neck', ramp: 'hide', pattern: true, prims: [{ a: neckBase, b: headC, ra: m.neckR * 1.25, rb: m.neckR }] });
  }
  if (m.features.has('frill')) {
    const open = 0.5 + alertLift + (act === 'windup' ? 0.6 * at : 0);
    for (let k = -2; k <= 2; k++) {
      const dir = p3(-0.4, k * 0.45 * open, 0.8 + Math.abs(k) * -0.1);
      parts.push({ id: `frill${k}`, ramp: 'accent', relief: 0.6, line: false, prims: [{ a: add(headC, p3(-m.headR * 0.5, 0, 0)), b: add(headC, mul(dir, m.headR * (1.6 + open * 0.6))), ra: m.headR * 0.45, rb: 0.6 }] });
    }
  }
  addHead(parts, m, headC, neckPitch * (insect ? 0 : 0.35) - (act === 'charge' ? 0.5 : 0), jaw, t, act === 'alert');

  // ---- tail
  if (m.tailLen > 1 && !insect) {
    const n = 5;
    const seg = m.tailLen / n;
    let p = add(rump, p3(-hipR * 0.6, 0, hipR * 0.25));
    let ang = (alertLift ? 0.5 : -0.35) + running * 0.5 - rest * 0.5;
    const tailParts: Prim[] = [];
    for (let i = 0; i < n; i++) {
      const sway = Math.sin(t * (moving ? 6 : 2) - i * 0.7) * (0.12 + moving * 0.15) * (i + 1);
      ang += m.features.has('tailClub') ? 0.02 : -0.08;
      const dir = p3(-Math.cos(ang) * Math.cos(sway), Math.sin(sway), Math.sin(ang));
      const q = add(p, mul(dir, seg));
      if (q.z < 1) q.z = 1;
      const r0 = m.tailR * (1 - i / n) + 0.5;
      tailParts.push({ a: p, b: q, ra: r0, rb: m.tailR * (1 - (i + 1) / n) + 0.5 });
      p = q;
    }
    parts.push({ id: 'tail', ramp: 'hide', pattern: true, prims: tailParts });
    if (m.features.has('tailClub')) parts.push({ id: 'club', ramp: 'accent', relief: 1.3, prims: [{ a: p, b: add(p, p3(-1.5, 0, 0.4)), ra: m.tailR * 1.35, rb: m.tailR * 1.2 }] });
  }
  return parts;
}

/** Head, snout, jaw, eyes, ears and head features around cranium center `c`. */
function addHead(parts: Part[], m: CreatureModel, c: P3, pitch: number, jawOpen: number, t: number, alert: boolean, opts: { faceDir?: P3 } = {}): void {
  const r = m.headR;
  const fwd = opts.faceDir ?? p3(Math.cos(pitch), 0, Math.sin(pitch));
  const down = p3(-fwd.z, 0, fwd.f);
  const headPrims: Prim[] = [{ a: add(c, mul(fwd, -r * 0.15)), b: add(c, mul(fwd, r * 0.2)), ra: r, rb: r * 0.95 }];
  if (m.snoutLen > 0.5) {
    const tip = add(add(c, mul(fwd, r * 0.4 + m.snoutLen)), mul(down, -r * 0.05));
    headPrims.push({ a: add(c, mul(fwd, r * 0.4)), b: tip, ra: r * 0.72, rb: clampMin(r * 0.42, 0.8) });
  }
  parts.push({ id: 'head', ramp: 'hide', prims: headPrims });
  // Lower jaw (opens to bite), and the dark mouth inside.
  if (m.snoutLen > 0.5 || jawOpen > 0) {
    const ja = jawOpen * 0.9;
    const jdir = add(mul(fwd, Math.cos(ja)), mul(down, Math.sin(ja)));
    const base = add(c, add(mul(fwd, r * 0.25), mul(down, r * 0.45)));
    const jl = r * 0.4 + Math.max(m.snoutLen, r * 0.8) * 0.9;
    if (jawOpen > 0.1) parts.push({ id: 'mouth', ramp: 'dark', over: 'head', line: false, prims: [{ a: base, b: add(base, mul(add(fwd, mul(down, ja * 0.45)), jl * 0.9)), ra: r * 0.45, rb: r * 0.3 }] });
    parts.push({ id: 'jaw', ramp: 'hide', toneShift: -1, prims: [{ a: base, b: add(base, mul(jdir, jl)), ra: r * 0.5, rb: clampMin(r * 0.28, 0.7) }] });
    if (jawOpen > 0.25) {
      const tip = add(c, mul(fwd, r * 0.4 + m.snoutLen * 0.85));
      parts.push({ id: 'teeth', ramp: 'bone', over: 'head', line: false, prims: [{ a: add(tip, mul(down, r * 0.25)), b: add(tip, mul(down, r * 0.55)), ra: 0.7, rb: 0.5 }] });
    }
  }
  const side = (k: number) => p3(0, k, 0);
  // Eyes in pairs, the first pair forward, extra pairs higher up and back.
  const pairs = Math.ceil(m.eyes.count / 2);
  for (let i = 0; i < pairs; i++) {
    for (const k of [-1, 1]) {
      if (i * 2 + (k > 0 ? 1 : 0) >= m.eyes.count) continue;
      const pos = add(add(add(c, mul(fwd, r * (0.55 - i * 0.22))), mul(side(k), r * (0.62 - i * 0.08))), mul(down, -r * (0.25 + i * 0.28)));
      parts.push({ id: `eye${i}${k}`, ramp: 'eye', over: 'head', eye: true, line: false, prims: [{ a: pos, b: pos, ra: clampMin(r * 0.2, 0.6), rb: clampMin(r * 0.2, 0.6) }] });
    }
  }
  if (m.eyes.count === 0 && !m.features.has('mask')) {
    // Eyeless: a scarred brow.
    for (const k of [-1, 1]) {
      const pos = add(add(c, mul(fwd, r * 0.55)), mul(side(k), r * 0.55));
      parts.push({ id: `scar${k}`, ramp: 'dark', over: 'head', line: false, prims: [{ a: add(pos, mul(down, -r * 0.3)), b: add(pos, mul(down, -r * 0.1)), ra: 0.6, rb: 0.6 }] });
    }
  }
  // Ears.
  if (m.ears !== 'none') {
    for (const k of [-1, 1]) {
      const base = add(add(c, mul(fwd, -r * 0.25)), add(mul(side(k), r * 0.55), mul(down, -r * 0.6)));
      const perk = alert ? 0.3 : 0;
      const tip =
        m.ears === 'long'
          ? add(base, add(mul(fwd, -r * 1.3), add(mul(side(k), r * 0.3), mul(down, -r * (0.5 + perk)))))
          : m.ears === 'round'
            ? add(base, mul(down, -r * 0.35))
            : add(base, add(mul(fwd, -r * 0.2), add(mul(side(k), r * 0.15), mul(down, -r * (0.85 + perk)))));
      parts.push({ id: `ear${k}`, ramp: 'hide', toneShift: k < 0 ? -1 : 0, prims: [{ a: base, b: tip, ra: r * (m.ears === 'round' ? 0.35 : 0.32), rb: m.ears === 'round' ? r * 0.3 : 0.5 }] });
    }
  }
  if (m.features.has('horns')) {
    for (const k of [-1, 1]) {
      const base = add(add(c, mul(side(k), r * 0.45)), mul(down, -r * 0.7));
      const mid = add(base, add(mul(fwd, -r * 0.3), add(mul(side(k), r * 0.5), mul(down, -r * 0.7))));
      const tip = add(mid, add(mul(fwd, r * 0.55), mul(down, -r * 0.4)));
      parts.push({ id: `horn${k}`, ramp: 'bone', prims: [{ a: base, b: mid, ra: r * 0.3, rb: r * 0.2 }, { a: mid, b: tip, ra: r * 0.2, rb: 0.5 }] });
    }
  }
  if (m.features.has('tusks')) {
    for (const k of [-1, 1]) {
      const base = add(add(c, mul(fwd, r * 0.3 + m.snoutLen * 0.7)), add(mul(side(k), r * 0.4), mul(down, r * 0.25)));
      const tip = add(base, add(mul(fwd, r * 0.55), add(mul(side(k), r * 0.25), mul(down, -r * 0.65))));
      parts.push({ id: `tusk${k}`, ramp: 'bone', prims: [{ a: base, b: tip, ra: clampMin(r * 0.18, 0.8), rb: 0.5 }] });
    }
  }
  if (m.features.has('mandibles')) {
    const open = 0.35 + jawOpen * 0.6 + Math.sin(t * 7) * 0.08;
    for (const k of [-1, 1]) {
      const base = add(add(c, mul(fwd, r * 0.7)), mul(side(k), r * 0.5));
      const mid = add(base, add(mul(fwd, r * 0.75), mul(side(k), r * 0.45 * open)));
      const tip = add(mid, add(mul(fwd, r * 0.55), mul(side(k), -r * 0.45)));
      parts.push({ id: `mandible${k}`, ramp: 'bone', toneShift: k < 0 ? -1 : 0, prims: [{ a: base, b: mid, ra: clampMin(r * 0.22, 0.8), rb: clampMin(r * 0.18, 0.7) }, { a: mid, b: tip, ra: clampMin(r * 0.18, 0.7), rb: 0.5 }] });
    }
  }
  if (m.features.has('antennae')) {
    for (const k of [-1, 1]) {
      const base = add(add(c, mul(fwd, r * 0.5)), add(mul(side(k), r * 0.35), mul(down, -r * 0.6)));
      const wob = Math.sin(t * 5 + k) * r * 0.3;
      const mid = add(base, add(mul(fwd, r * 0.9), add(mul(side(k), r * 0.6 + wob), mul(down, -r * 1.1))));
      const tip = add(mid, add(mul(fwd, r * 0.9), add(mul(side(k), r * 0.4), mul(down, -r * 0.1 + wob))));
      parts.push({ id: `antenna${k}`, ramp: 'accent', line: false, prims: [{ a: base, b: mid, ra: 0.6, rb: 0.5 }, { a: mid, b: tip, ra: 0.5, rb: 0.5 }] });
    }
  }
  if (m.features.has('mask')) {
    // A gas mask: rubber face, two round lenses, a filter can.
    const face = add(c, mul(fwd, r * 0.55));
    parts.push({ id: 'mask', ramp: 'mask', over: 'head', prims: [{ a: add(face, mul(down, -r * 0.2)), b: add(face, mul(down, r * 0.35)), ra: r * 0.62, rb: r * 0.55 }] });
    for (const k of [-1, 1]) {
      const lens = add(add(face, mul(fwd, r * 0.4)), add(mul(side(k), r * 0.35), mul(down, -r * 0.18)));
      parts.push({ id: `lens${k}`, ramp: 'eye', over: 'mask', eye: true, line: false, prims: [{ a: lens, b: lens, ra: clampMin(r * 0.24, 0.7), rb: clampMin(r * 0.24, 0.7) }] });
    }
    const can = add(face, add(mul(fwd, r * 0.45), mul(down, r * 0.55)));
    parts.push({ id: 'filter', ramp: 'dark', over: 'mask', prims: [{ a: can, b: add(can, add(mul(fwd, r * 0.35), mul(down, r * 0.25))), ra: r * 0.28, rb: r * 0.28 }] });
  }
  if (m.features.has('tentacles')) {
    const mouth = add(c, add(mul(fwd, r * 0.75), mul(down, r * 0.4)));
    for (let i = 0; i < 4; i++) {
      const k = i - 1.5;
      const wob = Math.sin(t * 4 + i * 1.7) * r * 0.25 + jawOpen * r * 0.6;
      const tip = add(mouth, add(mul(fwd, r * 0.3 + jawOpen * r * 0.8), add(mul(side(k), r * 0.22 + wob * 0.3), mul(down, r * 0.9 - jawOpen * r * 0.5))));
      parts.push({ id: `tentacle${i}`, ramp: 'dark', toneShift: 1, line: false, prims: [{ a: add(mouth, mul(side(k), r * 0.15)), b: tip, ra: clampMin(r * 0.14, 0.7), rb: 0.5 }] });
    }
  }
}

function poseBiped(m: CreatureModel, pose: CreaturePose): Part[] {
  const parts: Part[] = [];
  const t = pose.time;
  const act = pose.action;
  const at = pose.actionT;
  const moving = Math.min(1, pose.gait);
  const running = Math.max(0, Math.min(1, pose.gait - 1));
  // Crawlers drop to all fours to run (and to pounce).
  const crawl = m.features.has('claws') ? Math.max(running, act === 'leap' ? 1 : 0, act === 'windup' && pose.attack === 'leap' ? smooth(at) : 0) : 0;
  const rest = act === 'rest' ? 1 : 0;
  const legLen = m.hipH;
  const crouch = act === 'windup' ? 0.18 * smooth(at) : rest * 0.35;
  const bob = moving * Math.abs(Math.sin(pose.phase * TAU)) * legLen * 0.05;
  const pelvisZ = legLen * (0.93 - crouch - crawl * 0.25) + bob;
  const pelvis = p3(0, 0, pelvisZ);
  const lean = (m.hunch * 0.9 + crawl * (1.45 - m.hunch * 0.9) + (act === 'windup' ? 0.25 * at : 0)) * (Math.PI / 2) * 0.95;
  const spineLen = m.L;
  const chest = add(pelvis, p3(Math.sin(lean) * spineLen, 0, Math.cos(lean) * spineLen));
  const breathe = Math.sin(t * 2.2) * 0.3 * (1 - moving);
  parts.push({ id: 'torso', ramp: 'hide', pattern: true, prims: [{ a: pelvis, b: chest, ra: m.hipR, rb: m.chestR + breathe }] });

  // Legs: a two-beat walk; knees forward.
  const stride = (running ? m.stride.run : m.stride.walk) * moving * 0.5;
  const stance = running ? 0.42 : 0.6;
  const lift = legLen * (running ? 0.3 : 0.2) * moving;
  const legSegs = legLen * 0.56;
  for (const side of [-1, 1] as const) {
    const hip = add(pelvis, p3(0, side * m.hipR * 0.65, -m.hipR * 0.2));
    let foot: P3;
    if (pose.dead) foot = add(hip, p3(-1, side * 2, -hip.z));
    else if (act === 'leap') foot = add(hip, p3(-legSegs * 1.3, side * 1, -legSegs * 0.6));
    else {
      const c = footCycle(pose.phase + (side < 0 ? 0 : 0.5), stance, stride, lift);
      foot = p3(c.df - crawl * legSegs * 0.3, hip.s * 1.1, c.z);
    }
    const kn = knee(hip, foot, legSegs, legSegs, p3(1, 0, 0.1));
    parts.push({
      id: `leg${side}`,
      ramp: 'hide',
      toneShift: side < 0 ? -1 : 0,
      prims: [
        { a: hip, b: kn, ra: m.legR * 1.6, rb: m.legR * 1.15 },
        { a: kn, b: foot, ra: m.legR * 1.15, rb: m.legR * 0.9 },
        { a: foot, b: add(foot, p3(m.legR * 2, 0, 0)), ra: m.legR, rb: m.legR * 0.8 },
      ],
    });
  }

  // Arms: long, hanging and swinging, or reaching the ground on all fours, or slashing.
  const armLen = m.L * 1.05;
  const seg = armLen * 0.5;
  const fwdDir = p3(Math.sin(lean), 0, Math.cos(lean));
  for (const side of [-1, 1] as const) {
    const shoulder = add(chest, add(mul(fwdDir, -m.chestR * 0.3), p3(0, side * m.chestR * 0.85, 0)));
    let hand: P3;
    if (pose.dead) hand = add(shoulder, p3(seg * 0.6, side * seg, -shoulder.z + 1));
    else if (crawl > 0.5 && act !== 'leap') {
      const c = footCycle(pose.phase + (side < 0 ? 0.5 : 0), 0.45, stride * 1.2, lift);
      hand = p3(chest.f + seg * 0.5 + c.df, shoulder.s * 1.05, c.z);
    } else if (act === 'leap') hand = add(shoulder, p3(seg * 1.7, side * 2, -seg * 0.3));
    else if ((act === 'strike' || act === 'windup') && (pose.attack === 'claw' || pose.attack === 'leap') && side > 0) {
      // Rears back, then swipes across.
      const k = act === 'windup' ? -smooth(at) : bump(at) * 2 - 1;
      hand = add(shoulder, p3(seg * (0.6 + k * 1.1), side * seg * 0.3 * (1 - k), seg * (0.3 - Math.abs(k) * 0.6)));
    } else if (act === 'drain') {
      hand = add(shoulder, p3(seg * 1.5, -side * seg * 0.3, -seg * 0.3));
    } else {
      const swing = Math.sin((pose.phase + (side < 0 ? 0.5 : 0)) * TAU) * seg * 0.6 * moving;
      hand = add(shoulder, p3(seg * 0.35 + swing, side * seg * 0.2, -armLen * 0.85 + Math.sin(t * 1.5 + side) * 0.5));
      if (hand.z < 1) hand.z = 1;
    }
    const el = knee(shoulder, hand, seg, seg, p3(-1, side * 0.6, -0.2));
    const prims: Prim[] = [
      { a: shoulder, b: el, ra: m.legR * 1.3, rb: m.legR },
      { a: el, b: hand, ra: m.legR, rb: m.legR * 0.85 },
    ];
    parts.push({ id: `arm${side}`, ramp: 'hide', toneShift: side < 0 ? -1 : 0, prims });
    if (m.features.has('claws')) {
      const dir = norm(sub(hand, el));
      parts.push({ id: `claw${side}`, ramp: 'bone', over: `arm${side}`, line: false, prims: [{ a: hand, b: add(hand, mul(dir, m.legR * 3)), ra: 0.8, rb: 0.4 }] });
    }
  }

  // Head on a short neck, jutting forward.
  const headPitch = lean - Math.PI / 2 + 0.35 + (act === 'alert' ? 0.2 : 0);
  const neckEnd = add(chest, mul(norm(p3(Math.sin(lean) + 0.6, 0, Math.cos(lean) + 0.2)), m.neckLen + m.headR * 0.7));
  if (m.neckLen > 0.5) parts.push({ id: 'neck', ramp: 'hide', prims: [{ a: chest, b: neckEnd, ra: m.neckR, rb: m.neckR * 0.9 }] });
  let jaw = 0;
  if (act === 'strike' && pose.attack === 'bite') jaw = bump(at);
  if (act === 'drain') jaw = 0.8;
  if (act === 'windup') jaw = 0.3 * at;
  addHead(parts, m, neckEnd, -headPitch * 0.3, jaw, t, act === 'alert', { faceDir: norm(p3(Math.cos(headPitch * 0.4), 0, -Math.sin(headPitch * 0.4) - 0.15)) });
  return parts;
}

function poseSerpent(m: CreatureModel, pose: CreaturePose): Part[] {
  const parts: Part[] = [];
  const n = m.segments;
  const segLen = m.L / n;
  const r0 = clampMin(m.L * 0.075 * (m.chestR / Math.max(1, m.L * 0.24)), 1.5);
  const buried = pose.buried ?? 0;
  const act = pose.action;
  const at = pose.actionT;
  const t = pose.time;
  const moving = Math.min(1, pose.gait);
  // Rearing: the front of the body lifts out of the ground (a strike from below, or a threat display).
  let rear = 0;
  if (act === 'windup') rear = smooth(at) * 0.8;
  if (act === 'strike') rear = 0.8 + bump(at) * 0.3;
  if (act === 'alert') rear = 0.35;
  if (pose.dead) rear = 0;
  const pts: P3[] = [];
  // Follow the trail (converted to local axes) or lie straight behind.
  const ch = Math.cos(pose.heading);
  const sh = Math.sin(pose.heading);
  const trail = pose.trail ?? [];
  for (let i = 0; i < n; i++) {
    const d = i * segLen;
    let f = -d;
    let s = 0;
    // Distance along the trail.
    let acc = 0;
    let prev = { x: 0, y: 0 };
    for (const q of trail) {
      const l = Math.hypot(q.x - prev.x, q.y - prev.y);
      if (acc + l >= d && l > 0) {
        const u = (d - acc) / l;
        const x = prev.x + (q.x - prev.x) * u;
        const y = prev.y + (q.y - prev.y) * u;
        f = x * ch + y * sh;
        s = -x * sh + y * ch;
        break;
      }
      acc += l;
      prev = q;
    }
    const wave = Math.sin(pose.phase * TAU - i * 0.7) * r0 * 0.9 * moving * (i / n + 0.3);
    const r = r0 * (i === 0 ? 1.15 : 1 - (i / n) * 0.6);
    const lift = rear * Math.max(0, 1 - i / (n * 0.45)) * m.L * 0.45;
    const reachF = act === 'strike' ? bump(at) * m.L * 0.25 * Math.max(0, 1 - i / 3) : 0;
    pts.push(p3(f + reachF, s + wave, r - buried * r * 2.6 + lift));
  }
  // Body from tail to neck, then the head.
  const body: Prim[] = [];
  for (let i = n - 1; i >= 1; i--) {
    const a = pts[i]!;
    const b = pts[i - 1]!;
    if (a.z < -r0 * 0.3 && b.z < -r0 * 0.3) continue;
    body.push({ a, b, ra: r0 * (1 - (i / n) * 0.6), rb: r0 * (1 - ((i - 1) / n) * 0.6) });
  }
  if (body.length) parts.push({ id: 'torso', ramp: 'hide', pattern: true, prims: body });
  const head = pts[0]!;
  if (head.z > -r0 * 0.5) {
    const jaw = act === 'strike' ? bump(at) : act === 'windup' ? at * 0.4 : act === 'alert' ? 0.2 : 0;
    const pitch = rear > 0.3 ? -0.6 + jaw * 0.3 : 0;
    addHead(parts, m, head, pitch, jaw, t, false);
    if (jaw > 0.3) {
      // A ring of teeth around the open maw.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * TAU + 0.4;
        const base = add(head, p3(m.headR * 0.8, Math.cos(a) * m.headR * 0.7, Math.sin(a) * m.headR * 0.7));
        parts.push({ id: `fang${k}`, ramp: 'bone', over: 'head', line: false, prims: [{ a: base, b: add(base, p3(m.headR * 0.7 * jaw, -Math.cos(a) * 0.6, -Math.sin(a) * 0.6)), ra: 0.8, rb: 0.4 }] });
      }
    }
  }
  return parts;
}

// ---- painting ------------------------------------------------------------------

export interface CreatureFrame {
  canvas: PixelCanvas;
  /** Glowing eyes, canvas px. */
  glow: { x: number; y: number }[];
}

/** Canvas size for a model and where its feet sit in it. */
/** How much front-to-back depth is squashed on screen (3/4 view). */
const FORESHORTEN = 0.68;

export function frameSize(m: CreatureModel): { w: number; h: number; ox: number; oy: number } {
  const w = m.reach * 2 + 4;
  return { w, h: m.reach * 2 + m.up + 4, ox: m.reach + 2, oy: m.reach + m.up + 2 };
}

/**
 * Projects the posed parts into a canvas and paints them. `rig` and `target`
 * can be reused between frames (they must be frameSize()).
 */
export function paintCreature(m: CreatureModel, parts: Part[], heading: number, dead = false, rig?: Rig, target?: PixelCanvas): CreatureFrame {
  const { w, h, ox, oy } = frameSize(m);
  rig ??= new Rig(w, h);
  rig.reset();
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  // Bodies are drawn foreshortened front-to-back, like the 3/4 view of the characters; a
  // serpent follows its real path on the ground, so it isn't.
  const depthScale = m.plan === 'serpent' ? 1 : FORESHORTEN;
  // Lying dead: rolled onto its left side, legs pointing out to its right.
  const deadLift = m.plan === 'serpent' ? 0 : m.plan === 'biped' ? m.chestR : m.hipR;
  const deadShift = m.plan === 'serpent' ? 0 : m.plan === 'biped' ? (m.hipH + m.L) * 0.5 : m.hipH * 0.9;
  const projectFlat = (f: number, side: number, z: number) => {
    const x = f * c - side * s;
    const y = (f * s + side * c) * depthScale;
    return { x: ox + x, y: oy + y - z, d: y + z };
  };
  const project = (p: P3): { x: number; y: number; d: number } => {
    const f = p.f;
    let side = p.s;
    let z = p.z;
    if (dead && m.plan === 'biped') {
      // Fallen flat on its face, stretched out along its heading.
      return projectFlat(f + z * 0.95, side, deadLift * 0.55 + z * 0.06);
    }
    if (dead && m.plan !== 'serpent') {
      // Rolled over: legs stick out away from the viewer.
      const ns = z - deadShift;
      z = deadLift - side * 0.5 + Math.max(0, z - deadShift) * 0.35;
      side = ns;
    }
    const x = f * c - side * s;
    const y = (f * s + side * c) * depthScale;
    return { x: ox + x, y: oy + y - z, d: y + z };
  };
  // Depth per part (average of its capsule ends), with details sitting on their parents.
  const placed = parts.map((part, i) => {
    let d = 0;
    let k = 0;
    const shapes: Shape[] = [];
    for (const pr of part.prims) {
      const a = project(pr.a);
      const b = project(pr.b);
      d += a.d + b.d;
      k += 2;
      shapes.push({ k: 'cap', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, ra: pr.ra, rb: pr.rb });
    }
    return { part, shapes, depth: k ? d / k : 0, i };
  });
  const byId = new Map(placed.map((p) => [p.part.id, p] as const));
  for (const p of placed) {
    if (p.part.over) {
      const parent = byId.get(p.part.over);
      if (parent) p.depth = parent.depth + 0.001 * (p.i + 1);
    }
  }
  // Eyes on the far side of the head are hidden by it.
  const visible = placed.filter((p) => {
    if (!p.part.eye || !p.part.over) return true;
    const parent = byId.get(p.part.over);
    if (!parent || !parent.shapes.length) return true;
    const e = p.part.prims[0]!.a;
    const hp = parent.part.prims[0]!;
    const hc = lerp3(hp.a, hp.b, 0.5);
    // Toward the viewer is +y (south) and +z: compare the eye's offset from the head center.
    const off = sub(e, hc);
    const wy = off.f * s + off.s * c;
    return wy + off.z > -0.35 * m.headR;
  });
  visible.sort((a, b) => a.depth - b.depth);
  const glow: { x: number; y: number }[] = [];
  const indexOf = new Map<string, number>();
  for (const p of visible) {
    if (p.part.eye && p.shapes[0]!.k === 'cap' && p.part.prims[0]!.ra < 1) {
      const sh = p.shapes[0]!;
      rig.dot(sh.a.x, sh.a.y, m.eyeRgb);
      if (m.eyes.glow) glow.push({ x: sh.a.x, y: sh.a.y });
      continue;
    }
    const idx = rig.add(
      {
        region: 1,
        ramp: m.ramps[p.part.ramp],
        toneShift: p.part.toneShift,
        relief: p.part.relief,
        line: p.part.line,
        shadow: !p.part.eye,
      },
      p.shapes,
    );
    indexOf.set(p.part.id, idx);
    if (p.part.eye && m.eyes.glow && p.shapes[0]!.k === 'cap') glow.push({ x: p.shapes[0]!.a.x, y: p.shapes[0]!.a.y });
  }
  // Markings and the pale underside, painted onto the body parts.
  const patterned = visible.filter((p) => p.part.pattern && indexOf.has(p.part.id));
  if (patterned.length) {
    const ids = patterned.map((p) => indexOf.get(p.part.id)!);
    const belly: Shape[] = [];
    const marks: Shape[] = [];
    let seed = 0;
    for (const p of patterned) {
      for (const sh of p.shapes) {
        if (sh.k !== 'cap') continue;
        const r = Math.min(sh.ra, sh.rb);
        if (!dead && m.plan !== 'serpent') belly.push({ k: 'cap', a: { x: sh.a.x, y: sh.a.y + sh.ra * 0.75 }, b: { x: sh.b.x, y: sh.b.y + sh.rb * 0.75 }, ra: sh.ra * 0.62, rb: sh.rb * 0.62 });
        if (m.pattern === 'none' || r < 1.5) continue;
        const dx = sh.b.x - sh.a.x;
        const dy = sh.b.y - sh.a.y;
        const l = Math.hypot(dx, dy) || 1;
        const nx = -dy / l;
        const ny = dx / l;
        const count = Math.max(1, Math.round(l / (m.pattern === 'bands' ? 6 : 4)));
        for (let k = 0; k < count; k++) {
          const u = (k + 0.5) / count;
          const px = sh.a.x + dx * u;
          const py = sh.a.y + dy * u;
          const rr = sh.ra + (sh.rb - sh.ra) * u;
          seed++;
          const hsh = hash(seed + m.id.length * 31);
          if (m.pattern === 'stripes' || m.pattern === 'bands') {
            if (m.pattern === 'bands' && k % 2) continue;
            const wid = m.pattern === 'bands' ? 1.6 : 0.8;
            marks.push({ k: 'cap', a: { x: px + nx * rr - dx * 0.04, y: py + ny * rr - rr * 0.3 }, b: { x: px - nx * rr * 0.2, y: py - ny * rr * 0.2 }, ra: wid, rb: wid * 0.6 });
          } else if (m.pattern === 'spots') {
            const off = (hsh - 0.5) * rr * 1.2;
            marks.push({ k: 'ell', c: { x: px + nx * off, y: py + ny * off - rr * 0.2 }, rx: 1.2 + hsh, ry: 1 + hsh * 0.6 });
          } else {
            const off = (hsh - 0.5) * rr * 1.4;
            marks.push({ k: 'ell', c: { x: px + nx * off, y: py + ny * off - rr * 0.25 }, rx: 2.2 + hsh * 1.4, ry: 1.4 + hsh });
          }
        }
      }
    }
    if (belly.length) rig.decal(m.ramps.belly, belly, { parts: ids });
    if (marks.length) rig.decal(m.ramps.accent, marks, { parts: ids });
  }
  const canvas = rig.finish(target);
  return { canvas, glow };
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Convenience: pose and paint in one go (icons, tests, previews). */
export function drawCreature(def: CreatureDef, pose: CreaturePose = restPose()): CreatureFrame {
  const m = creatureModel(def);
  return paintCreature(m, poseCreature(m, pose), pose.heading, pose.dead);
}
