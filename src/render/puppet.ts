import { PixelCanvas } from './PixelCanvas';

/**
 * Cutout ("Flash-style") characters: a body is a handful of rigid pieces —
 * torso, head, upper arm + shoulder, lower arm + hand, upper leg + knee, lower
 * leg + foot, tail — each drawn once per facing and posed at runtime by
 * rotating it around its joint. One set of pieces gives smooth walk / sprint
 * cycles, arms that follow the aim in any direction, and recoil, without
 * drawing every frame.
 *
 * This module is pure math and pixels (no renderer): the rig description, the
 * pose solver, and a CPU compositor used for portraits, icons and tests.
 * CharacterView does the same composition on the GPU.
 *
 * Coordinates: "character space" has its origin at the feet (the entity
 * position), x right, y down, in pixels. Rig joints are given in "frame space"
 * (the 64x64 frame the bind pose was drawn in, anchor at `rig.anchor`).
 */

export const PUPPET_DIRS = ['down', 'right', 'up'] as const;
export type PuppetDir = (typeof PUPPET_DIRS)[number];

/**
 * Pieces. A/B are the two sides: screen-left/right in the front and back views,
 * far/near in the side view. `headAlt` is an optional variant of the head
 * (tongue flick, ear twitch) shown now and then while idle.
 */
export const PUPPET_PARTS = [
  'torso',
  'head',
  'headAlt',
  'tail',
  'upperArmA',
  'lowerArmA',
  'upperArmB',
  'lowerArmB',
  'upperLegA',
  'lowerLegA',
  'upperLegB',
  'lowerLegB',
] as const;
export type PartId = (typeof PUPPET_PARTS)[number];

/** Height of the gun pivot above the feet. Keep in sync with CHEST_HEIGHT in game/combat.ts. */
export const GUN_PIVOT = 31;
/** How far out from the pivot the gun is held. Keep in sync with HOLD_DISTANCE in game/combat.ts. */
export const GUN_HOLD = 5;

export interface Pt {
  x: number;
  y: number;
}

export interface PuppetPart {
  /** Where the piece's pivot (the joint it hangs from) sits in the bind pose, frame space. */
  joint: Pt;
  /** The same point inside the piece's atlas cell. */
  pivot: Pt;
}

export interface PuppetDirRig {
  parts: Partial<Record<PartId, PuppetPart>>;
  /** Bind-pose positions (frame space) of the joints at the far end of each limb piece. [A, B]. */
  elbow: [Pt, Pt];
  /** Hand center (where a grip sits). */
  hand: [Pt, Pt];
  knee: [Pt, Pt];
  /** Ground contact of the foot. */
  foot: [Pt, Pt];
}

/** Everything needed to pose one race's pieces. */
export interface PuppetRig {
  /** Atlas cell size: row = direction (PUPPET_DIRS order), column = part (PUPPET_PARTS order). */
  cell: number;
  /** The feet point of the bind-pose frame. */
  anchor: Pt;
  dirs: Record<PuppetDir, PuppetDirRig>;
  /** Longer legs and a bouncier gait for digitigrade races. */
  digitigrade: boolean;
}

/** What the character is doing; the pose is derived from this alone. */
export interface PuppetState {
  facing: 'down' | 'up' | 'left' | 'right';
  /** Walk-cycle phase (radians), advanced by distance travelled. */
  phase: number;
  /** 0 standing still .. 1 walking at full speed. */
  moving: number;
  sprint: boolean;
  /** Aim angle in screen space (radians, 0 = right, y down), or null when not aiming. */
  aim: number | null;
  /** Held weapon geometry in its own pixels (pointing right), or null if unarmed. */
  weapon: { grip: Pt; muzzle: Pt } | null;
  /** 1 right after a shot, decaying to 0. */
  recoil: number;
  /** 0..1 progress of a reload, or null. */
  reload: number | null;
  /** Seconds, for idle breathing and tail sway. */
  time: number;
}

export interface BonePose {
  /** Pivot position, character space. */
  x: number;
  y: number;
  /** Rotation relative to the bind pose (radians, clockwise on screen). */
  angle: number;
}

export interface PuppetPose {
  dir: PuppetDir;
  /** Mirror horizontally (facing left reuses the right-facing pieces). */
  flip: boolean;
  bones: Partial<Record<PartId, BonePose>>;
  /** Held weapon: grip position, rotation, and vertical flip for guns pointing left. */
  weapon: { x: number; y: number; angle: number; flipY: boolean } | null;
  /** Back-to-front draw order. */
  order: (PartId | 'weapon')[];
}

// ---- small vector helpers ------------------------------------------------------------

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const rot = (p: Pt, a: number): Pt => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });
const ang = (p: Pt) => Math.atan2(p.y, p.x);
const len = (p: Pt) => Math.hypot(p.x, p.y);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Two-bone IK: the middle joint between `root` and `end`. `prefer` picks the bend (the candidate closest to it). */
export function solveIk(root: Pt, end: Pt, a: number, b: number, prefer: Pt): Pt {
  const d = clamp(len(sub(end, root)), Math.abs(a - b) + 0.01, a + b - 0.01);
  const base = ang(sub(end, root));
  const off = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  const c1 = add(root, { x: Math.cos(base + off) * a, y: Math.sin(base + off) * a });
  const c2 = add(root, { x: Math.cos(base - off) * a, y: Math.sin(base - off) * a });
  return len(sub(c1, prefer)) <= len(sub(c2, prefer)) ? c1 : c2;
}

// ---- pose solver -----------------------------------------------------------------------

const ORDER: Record<PuppetDir, (PartId | 'weapon')[]> = {
  down: ['tail', 'lowerLegA', 'upperLegA', 'lowerLegB', 'upperLegB', 'torso', 'head', 'upperArmA', 'upperArmB', 'weapon', 'lowerArmA', 'lowerArmB'],
  right: ['upperArmA', 'lowerArmA', 'tail', 'lowerLegA', 'upperLegA', 'torso', 'lowerLegB', 'upperLegB', 'head', 'weapon', 'upperArmB', 'lowerArmB'],
  up: ['weapon', 'lowerLegA', 'upperLegA', 'lowerLegB', 'upperLegB', 'torso', 'upperArmA', 'lowerArmA', 'upperArmB', 'lowerArmB', 'head', 'tail'],
};

/**
 * Turns a state into bone transforms. Pure and deterministic, so the same
 * state always draws the same picture (which lets the view skip redraws).
 */
export function solvePose(rig: PuppetRig, s: PuppetState): PuppetPose {
  const flip = s.facing === 'left';
  const dir: PuppetDir = s.facing === 'left' ? 'right' : s.facing;
  const r = rig.dirs[dir];
  const side = dir === 'right';
  const A = rig.anchor;
  const fs = (p: Pt): Pt => sub(p, A); // frame space -> character space (bind pose)
  // Aim in the puppet's own (unflipped) space.
  const aim = s.aim === null ? null : flip ? Math.PI - s.aim : s.aim;
  const sprint = s.sprint && s.moving > 0.1;
  const aiming = aim !== null && s.weapon !== null && !sprint && s.reload === null;
  const m = clamp(s.moving, 0, 1);
  const u = s.phase;

  // Gait parameters.
  const stride = (sprint ? 8.5 : 5.4) * m;
  const lift = (sprint ? 5 : 3) * m;
  const bob = m * (sprint ? 1.4 : 0.8) * Math.abs(Math.sin(u)) - (m > 0 ? 0.3 : 0) + (m < 0.05 ? Math.sin(s.time * 2.2) * 0.35 : 0);
  let lean = sprint ? 0.2 : m * 0.04;
  if (aiming && side) lean += clamp(Math.sin(aim!) * 0.12, -0.1, 0.12) - s.recoil * 0.05;

  const bones: Partial<Record<PartId, BonePose>> = {};
  // Torso: rotates about the hips' center; the legs don't lean with it.
  const torsoJ = r.parts.torso!.joint;
  const torsoPos = add(fs(torsoJ), { x: 0, y: bob });
  bones.torso = { ...torsoPos, angle: lean };
  /** A torso-attached joint's position after the torso's lean. */
  const onTorso = (bind: Pt): Pt => add(torsoPos, rot(sub(bind, torsoJ), lean));

  // Head (and its idle variant), turned a little toward the aim in side view.
  const headJ = r.parts.head!.joint;
  const look = aiming && side ? clamp(aim! * 0.45, -0.35, 0.35) : 0;
  const head = { ...onTorso(headJ), angle: lean * 0.5 + look };
  const alt = !!r.parts.headAlt && m < 0.05 && !aiming && Math.sin(s.time * 0.9) > 0.97;
  bones[alt ? 'headAlt' : 'head'] = head;

  // Tail: hangs from the pelvis and sways.
  if (r.parts.tail) {
    const sway = Math.sin(s.time * 1.6) * 0.05 + (m > 0 ? Math.sin(u) * 0.07 : 0) - (sprint ? 0.15 : 0);
    bones.tail = { ...add(fs(r.parts.tail.joint), { x: 0, y: bob }), angle: sway };
  }

  // ---- legs
  for (const [i, k] of [
    [0, 'A'],
    [1, 'B'],
  ] as const) {
    const up = r.parts[`upperLeg${k}`]!;
    const lo = r.parts[`lowerLeg${k}`]!;
    const hip = add(fs(up.joint), { x: 0, y: bob });
    const kneeBind = r.knee[i];
    const footBind = r.foot[i];
    const l1 = len(sub(kneeBind, up.joint));
    const l2 = len(sub(footBind, kneeBind));
    // Leg A leads at phase 0; B is half a cycle behind.
    const p = i === 0 ? u : u + Math.PI;
    let foot: Pt;
    if (side) {
      foot = add(fs(footBind), { x: stride * Math.cos(p), y: -lift * Math.max(0, -Math.sin(p)) });
    } else {
      // Front/back: the foot lifts toward the camera, which reads as the leg getting shorter.
      foot = add(fs(footBind), { x: 0, y: -lift * 0.8 * Math.max(0, -Math.sin(p)) });
    }
    let knee: Pt;
    if (side) {
      // Knees bend forward (+x); digitigrade shins are already angled in the piece.
      const prefer = add(hip, rot(sub(kneeBind, up.joint), 0));
      knee = solveIk(hip, foot, l1, l2, add(prefer, { x: 4, y: 0 }));
      const upperAngle = ang(sub(knee, hip)) - ang(sub(kneeBind, up.joint));
      const lowerAngle = ang(sub(foot, knee)) - ang(sub(footBind, kneeBind));
      bones[`upperLeg${k}`] = { ...hip, angle: upperAngle };
      bones[`lowerLeg${k}`] = { ...knee, angle: lowerAngle };
    } else {
      // Straight down; a lifted foot pulls the lower leg up under the thigh.
      const raise = fs(footBind).y - foot.y;
      knee = add(hip, sub(kneeBind, up.joint));
      bones[`upperLeg${k}`] = { ...hip, angle: 0 };
      bones[`lowerLeg${k}`] = { ...add(knee, { x: 0, y: -raise }), angle: 0 };
    }
  }

  // ---- arms
  const armIk = (k: 'A' | 'B', target: Pt) => {
    const i = k === 'A' ? 0 : 1;
    const up = r.parts[`upperArm${k}`]!;
    const shoulder = onTorso(up.joint);
    const l1 = len(sub(r.elbow[i], up.joint));
    const l2 = len(sub(r.hand[i], r.elbow[i]));
    // Elbows hang down and out to the arm's own side.
    const outward = side ? 0 : k === 'A' ? -6 : 6;
    const elbow = solveIk(shoulder, target, l1, l2, add(shoulder, { x: outward, y: 8 }));
    bones[`upperArm${k}`] = { ...shoulder, angle: ang(sub(elbow, shoulder)) - ang(sub(r.elbow[i], up.joint)) };
    bones[`lowerArm${k}`] = { ...elbow, angle: ang(sub(target, elbow)) - ang(sub(r.hand[i], r.elbow[i])) };
  };
  const armFree = (k: 'A' | 'B', upperRel: number, lowerRel: number) => {
    const i = k === 'A' ? 0 : 1;
    const up = r.parts[`upperArm${k}`]!;
    const shoulder = onTorso(up.joint);
    const ua = lean + upperRel;
    const elbow = add(shoulder, rot(sub(r.elbow[i], up.joint), ua));
    bones[`upperArm${k}`] = { ...shoulder, angle: ua };
    bones[`lowerArm${k}`] = { ...elbow, angle: ua + lowerRel };
  };

  let weapon: PuppetPose['weapon'] = null;
  const gunGeo = s.weapon;
  if (gunGeo) {
    const gunLen = gunGeo.muzzle.x - gunGeo.grip.x;
    const support = { x: Math.min(9, gunLen * 0.4), y: 0 };
    if (aiming) {
      const a = aim!;
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const pivot = { x: 0, y: -GUN_PIVOT + bob * 0.5 };
      const kick = s.recoil * 2.5;
      const grip = add(pivot, { x: d.x * (GUN_HOLD - kick), y: d.y * (GUN_HOLD - kick) });
      const flipY = Math.cos(a) < 0;
      // Muzzle climb: the barrel kicks up (screen -y) after a shot.
      const climb = s.recoil * 0.12 * (flipY ? 1 : -1);
      const gunAngle = a + climb;
      weapon = { ...grip, angle: gunAngle, flipY };
      const supportPt = add(grip, rot({ x: support.x, y: flipY ? -support.y : support.y }, gunAngle));
      // Side view: the near arm holds the grip, the far arm the foregrip.
      // Front/back: the arm on the side the gun points to holds the grip.
      const gripArm: 'A' | 'B' = side ? 'B' : Math.cos(a) >= 0 ? 'B' : 'A';
      const otherArm: 'A' | 'B' = gripArm === 'A' ? 'B' : 'A';
      armIk(gripArm, grip);
      armIk(otherArm, gunLen > 16 ? supportPt : grip);
    } else {
      // Carry: gun held low across the body, muzzle down and forward.
      const reloading = s.reload !== null;
      const carryAngle = side ? (sprint ? 1.1 : 0.85) : dir === 'down' ? 2.2 : 0.95;
      const grip = side
        ? { x: 3 + (sprint ? -1 : 0), y: -24 + bob }
        : { x: dir === 'down' ? 4 : -4, y: -24 + bob };
      // Reloading tips the gun up toward the chest.
      const angle = reloading ? (side ? -0.3 + Math.sin(s.reload! * Math.PI) * 0.2 : dir === 'down' ? 2.8 : 0.3) : carryAngle;
      const flipY = Math.cos(angle) < 0;
      weapon = { ...grip, angle, flipY };
      const supportPt = add(grip, rot({ x: support.x * (reloading ? 0.5 : 1), y: 0 }, angle));
      const gripArm: 'A' | 'B' = side ? 'B' : dir === 'down' ? 'B' : 'A';
      armIk(gripArm, grip);
      if (sprint && side) {
        // The free arm pumps.
        armFree('A', -0.7 * Math.cos(u), -1.2);
      } else {
        armIk(gripArm === 'A' ? 'B' : 'A', gunLen > 16 || reloading ? supportPt : add(grip, { x: 0, y: 1 }));
      }
    }
  } else if (sprint) {
    // Arms pump: swing opposite to the legs, elbows bent.
    if (side) {
      armFree('A', -0.85 * Math.cos(u), -1.3);
      armFree('B', 0.85 * Math.cos(u), -1.3);
    } else {
      armFree('A', 0.15 * Math.cos(u), -0.9);
      armFree('B', -0.15 * Math.cos(u), 0.9);
    }
  } else {
    // Walking / idle: gentle swing.
    const sw = side ? 0.32 * m * Math.cos(u) : 0.06 * m * Math.cos(u);
    const breathe = Math.sin(s.time * 2.2) * 0.03;
    armFree('A', -sw + (side ? 0 : breathe), side ? -0.15 * m : 0);
    armFree('B', sw - (side ? 0 : breathe), side ? -0.15 * m : 0);
  }

  const order = ORDER[dir].map((p) => (p === 'head' && alt ? 'headAlt' : p));
  return { dir, flip, bones, weapon, order: order.filter((p) => p === 'weapon' || bones[p as PartId] !== undefined) };
}

// ---- CPU compositor ----------------------------------------------------------------------

export interface PuppetLayers {
  rig: PuppetRig;
  /** Atlases drawn bottom to top (body, then armor). */
  atlases: PixelCanvas[];
  /** Weapon art (pointing right) and its grip. */
  weapon?: { pixels: PixelCanvas; grip: Pt };
}

/**
 * Draws a posed puppet into pixels with nearest-neighbor rotation (the same
 * result the GPU path gives). `out` is centered so character-space (0, 0)
 * lands on (ox, oy).
 */
export function composePuppet(layers: PuppetLayers, pose: PuppetPose, out: PixelCanvas, ox: number, oy: number): void {
  const { rig, atlases } = layers;
  const C = rig.cell;
  const row = PUPPET_DIRS.indexOf(pose.dir);
  const sx = pose.flip ? -1 : 1;
  const stamp = (src: PixelCanvas, srcX: number, srcY: number, w: number, h: number, pivot: Pt, at: Pt, angle: number, flipY: boolean) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const reach = Math.ceil(Math.hypot(w, h)) + 1;
    const cx = ox + sx * at.x;
    const cy = oy + at.y;
    for (let y = Math.floor(cy - reach); y <= cy + reach; y++) {
      for (let x = Math.floor(cx - reach); x <= cx + reach; x++) {
        if (!out.inBounds(x, y)) continue;
        // Output pixel center -> piece space (undo flip, rotation, translation).
        const dx = (x + 0.5 - cx) * sx;
        const dy = y + 0.5 - cy;
        const lx = dx * cos + dy * sin;
        let ly = -dx * sin + dy * cos;
        if (flipY) ly = -ly;
        const px = Math.floor(lx + pivot.x);
        const py = Math.floor(ly + pivot.y);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const a = src.alpha(srcX + px, srcY + py);
        if (a) out.set(x, y, src.get(srcX + px, srcY + py), a);
      }
    }
  };
  for (const id of pose.order) {
    if (id === 'weapon') {
      if (pose.weapon && layers.weapon) {
        const w = layers.weapon;
        stamp(w.pixels, 0, 0, w.pixels.width, w.pixels.height, { x: w.grip.x + 0.5, y: w.grip.y + 0.5 }, pose.weapon, pose.weapon.angle, pose.weapon.flipY);
      }
      continue;
    }
    const bone = pose.bones[id];
    const part = rig.dirs[pose.dir].parts[id];
    if (!bone || !part) continue;
    const col = PUPPET_PARTS.indexOf(id);
    for (const atlas of atlases) stamp(atlas, col * C, row * C, C, C, part.pivot, bone, bone.angle, false);
  }
}

/** A neutral standing pose (portraits, icons). */
export function restState(facing: PuppetState['facing'] = 'down'): PuppetState {
  return { facing, phase: 0, moving: 0, sprint: false, aim: null, weapon: null, recoil: 0, reload: null, time: 0 };
}

/** Rough integer key of a pose, to skip redrawing an unchanged character. */
export function poseKey(pose: PuppetPose): string {
  const q = (n: number) => Math.round(n * 4);
  const parts = pose.order.map((id) => {
    if (id === 'weapon') return pose.weapon ? `w${q(pose.weapon.x)},${q(pose.weapon.y)},${Math.round(pose.weapon.angle * 40)}` : 'w';
    const b = pose.bones[id]!;
    return `${q(b.x)},${q(b.y)},${Math.round(b.angle * 40)}`;
  });
  return `${pose.dir}${pose.flip ? 'f' : ''}|${parts.join('|')}`;
}
