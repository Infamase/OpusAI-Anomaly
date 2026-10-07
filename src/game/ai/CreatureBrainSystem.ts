import type { EventBus } from '../../core/EventBus';
import type { ContentRegistry } from '../../content/Registry';
import type { CreatureAttack, CreatureDef } from '../../content/types/creature';
import type { Entity, System, World } from '../../ecs/World';
import { applyDamage, lineOfSight, segmentHitsSolid } from '../combat';
import type { CombatEvents } from '../combatEvents';
import {
  Character,
  Collider,
  Combatant,
  Creature,
  CreatureBrain,
  Faction,
  Health,
  Spit,
  Transform,
  Velocity,
  type CreatureState,
} from '../components';
import type { Relations } from '../factions';
import { moveAxis } from '../systems/MovementSystem';
import { TILE_PX, type TileMap } from '../world/TileMap';
import { findPath, walkableLine, type Avoid, type Point } from './pathfinding';

const PERCEPTION_INTERVAL = 0.25;
/** Packmates this close hear about a fight. */
const PACK_RADIUS = 560;
const ARRIVE = 6;
/** How far behind it a creature can't see (cos of the half-angle it can). */
const FOV_COS = Math.cos((130 * Math.PI) / 180);
/** Gravity for spit globs, px/s². */
const SPIT_G = 520;

interface Noise {
  x: number;
  y: number;
  source: Entity;
  /** Loudness: how far it carries for a creature with average hearing. */
  loud: number;
}

/**
 * Creature decision-making. Each creature runs a small state machine shaped
 * by its temperament:
 *
 *   passive      grazes; bolts from anything dangerous (gunfire, predators, armed people close by)
 *   territorial  warns intruders (alert), then attacks those who come inside its territory
 *   predator     hunts anything hostile it sees, hears or smells; packs circle and dart in
 *   ambush       waits hidden (burrowed, cloaked, crouched), stalks closer, then strikes
 *
 *   rest/wander ──notices──► alert ─► chase ─► attack (wind-up → strike → recover) ─► chase …
 *        ▲                                │ hurt / pack broken
 *        └──────── return ◄── flee ◄──────┘
 *
 * Attacks are telegraphed with a wind-up (a crouch, a lowered head) so the
 * player can react: bites and claws in reach, charges that run straight
 * through, pounces through the air, globs of acid that arc and can be dodged.
 * Creatures only write intents (velocity, heading); movement and damage use
 * the shared rules.
 */
export class CreatureBrainSystem implements System {
  readonly name = 'creatureBrain';
  private noises: Noise[] = [];
  private world: World | null = null;

  /** Tiles to stay out of (anomalies, fire). */
  avoid?: Avoid;
  /** How lit a spot is (0..1): creatures without night vision see less in the dark. */
  lightAt?: (x: number, y: number) => number;
  /** Fog and rain shorten sight. */
  sightScale?: () => number;
  /** Is it night now (nocturnal creatures come out, day ones bed down)? */
  isNight?: () => boolean;

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
    private relations: Relations,
    private rand: () => number = Math.random,
  ) {
    events.on('shot', (s) => this.noises.push({ x: s.x, y: s.y, source: s.shooter, loud: 1.5 }));
    events.on('explosion', (x) => this.noises.push({ x: x.x, y: x.y, source: x.owner ?? -1, loud: 2.4 }));
    events.on('hit', (h) => this.world && this.onHit(this.world, h.target, h.attacker, h.killed));
  }

  update(world: World, dt: number): void {
    this.world = world;
    const map = this.map();
    if (!map) return;
    const list = [...world.query(Creature, CreatureBrain, Transform, Velocity, Health)];
    for (const e of list) {
      const h = world.req(e, Health);
      const b = world.req(e, CreatureBrain);
      const c = world.req(e, Creature);
      const def = this.content.get('creature', c.defId);
      if (h.dead) {
        world.req(e, Velocity).x = world.req(e, Velocity).y = 0;
        b.lift = 0;
        continue;
      }
      b.stateTime += dt;
      b.thinkIn -= dt;
      b.repathIn -= dt;
      b.sinceSeen += dt;
      b.sinceHurt += dt;
      b.revealed = Math.max(0, b.revealed - dt);
      b.voiceIn -= dt;
      for (let i = 0; i < b.cooldowns.length; i++) b.cooldowns[i] = Math.max(0, b.cooldowns[i]! - dt);
      if (def.abilities.regen > 0 && b.sinceHurt > 5) h.hp = Math.min(def.health, h.hp + def.abilities.regen * dt);
      if (b.thinkIn <= 0) {
        b.thinkIn = PERCEPTION_INTERVAL * (0.8 + this.rand() * 0.4);
        this.perceive(world, map, e, b, c, def);
      }
      this.hear(world, e, b, def);
      this.behave(world, map, e, b, c, def, dt);
      this.abilities(b, c, def, dt);
    }
    this.separate(world, list);
    this.noises.length = 0;
  }

  // ---- perception ---------------------------------------------------------------

  private active(def: CreatureDef): boolean {
    if (def.activity === 'any' || !this.isNight) return true;
    return def.activity === 'night' ? this.isNight() : !this.isNight();
  }

  /** Can it sense `o` (sight, smell, the sound of someone running)? */
  private senses(world: World, map: TileMap, e: Entity, c: Creature, def: CreatureDef, o: Entity, dist: number, sleepy: number): boolean {
    const t = world.req(e, Transform);
    const ot = world.req(o, Transform);
    const oc = world.get(o, Creature);
    if (oc?.hidden) return dist < def.senses.smell * 0.5 * sleepy;
    if (dist < def.senses.smell * sleepy) return true;
    // Footsteps: people running are heard well, walking less so.
    const ov = world.get(o, Velocity);
    const speed = ov ? Math.hypot(ov.x, ov.y) : 0;
    if (world.has(o, Combatant) && speed > 20) {
      const ear = def.senses.hearing * (world.get(o, Character)?.sprinting ? 0.32 : 0.14) * sleepy;
      if (dist < ear) return true;
    }
    let sight = def.senses.sight * (this.sightScale?.() ?? 1) * sleepy;
    if (sight <= 0 || dist > sight) return false;
    if (oc && oc.visibility < 0.5) sight = Math.min(sight, 60);
    if (!def.senses.nightVision && this.lightAt && dist > 70) {
      const lit = Math.max(0, Math.min(1, (this.lightAt(ot.x, ot.y - 16) - 0.12) / 0.55));
      sight = 70 + (sight - 70) * lit;
    }
    if (dist > sight) return false;
    // Wide field of view; not straight behind.
    const hx = Math.cos(c.heading);
    const hy = Math.sin(c.heading);
    if (dist > 50 && ((ot.x - t.x) * hx + (ot.y - t.y) * hy) / Math.max(1, dist) < FOV_COS) return false;
    return lineOfSight(map, t.x, t.y - 10, ot.x, ot.y - 16);
  }

  private perceive(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef): void {
    const t = world.req(e, Transform);
    const sleepy = b.state === 'rest' ? 0.5 : 1;
    // Keep tabs on the current target.
    if (b.target !== null) {
      if (!alive(world, b.target)) {
        b.target = null;
      } else {
        const tt = world.req(b.target, Transform);
        const dist = Math.hypot(tt.x - t.x, tt.y - t.y);
        if (this.senses(world, map, e, c, def, b.target, dist, 1) || dist < 40) {
          b.lastSeenX = tt.x;
          b.lastSeenY = tt.y;
          b.sinceSeen = 0;
        }
      }
    }
    // Morale: a pack that has lost too many breaks and runs.
    if (def.morale > 0 && b.state !== 'flee') {
      const { alive: living, total } = this.packCount(world, c.lairId);
      if (total > 1 && living / total <= 1 - def.morale) return this.startFlee(world, e, b, b.target, 6);
    }
    if (b.state === 'flee' || b.state === 'attack') return;

    let best: Entity | null = null;
    let bestDist = Infinity;
    let threat: Entity | null = null;
    let threatDist = Infinity;
    for (const o of world.query(Health, Transform, Faction)) {
      if (o === e || world.req(o, Health).dead) continue;
      const ot = world.req(o, Transform);
      const dist = Math.hypot(ot.x - t.x, ot.y - t.y);
      if (dist > 700) continue;
      const attitude = this.relations.attitude(world, e, o);
      if (attitude === 'friendly') continue;
      const hostile = attitude === 'hostile';
      if (def.temperament === 'passive') {
        // Danger: anything hostile, or someone armed walking right up.
        const armed = world.has(o, Combatant) && dist < def.senses.sight * 0.4;
        if ((hostile || armed) && this.senses(world, map, e, c, def, o, dist, sleepy) && dist < threatDist) {
          threat = o;
          threatDist = dist;
        }
        continue;
      }
      if (def.temperament === 'territorial') {
        // Intruders: anyone not friendly who comes too close.
        const zone = def.territory * (b.state === 'chase' ? 1.6 : 1.7);
        if (dist > zone && !(hostile && c.grudges.has(o))) continue;
      } else if (!hostile) continue;
      if (!this.senses(world, map, e, c, def, o, dist, sleepy)) continue;
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    if (threat !== null) {
      this.voice(world, e, 'alert');
      this.startFlee(world, e, b, threat, 5 + this.rand() * 3);
      this.alertPack(world, e, threat, true);
      return;
    }
    if (best === null) {
      if (b.state === 'alert' && b.stateTime > 1.5) this.setState(b, 'wander');
      return;
    }
    if (b.target === best && (b.state === 'chase' || b.state === 'stalk')) return;
    if (def.temperament === 'territorial' && !c.grudges.has(best)) {
      // Fair warning first: it only comes for you inside its territory.
      if (bestDist > def.territory) {
        if (b.state !== 'alert') {
          this.setState(b, 'alert');
          b.target = best;
          this.voice(world, e, 'alert');
        }
        return;
      }
    }
    this.engage(world, e, b, def, best);
    this.alertPack(world, e, best, false);
  }

  private hear(world: World, e: Entity, b: CreatureBrain, def: CreatureDef): void {
    if (!this.noises.length || b.state === 'attack' || b.state === 'flee') return;
    const t = world.req(e, Transform);
    for (const n of this.noises) {
      if (n.source === e) continue;
      const d = Math.hypot(n.x - t.x, n.y - t.y);
      if (d > def.senses.hearing * n.loud) continue;
      if (def.temperament === 'passive') {
        this.voice(world, e, 'alert');
        this.startFlee(world, e, b, null, 5 + this.rand() * 3, { x: n.x, y: n.y });
        return;
      }
      if (b.state === 'chase' || b.state === 'stalk') return;
      // Predators come to have a look; others prick up their ears.
      const hostile = alive(world, n.source) && this.relations.hostile(world, e, n.source);
      if (def.temperament === 'predator' && hostile && d < def.senses.hearing) {
        this.engage(world, e, b, def, n.source);
        b.sinceSeen = 1;
      } else if (b.state === 'rest' || b.state === 'wander') {
        this.setState(b, 'alert');
        b.target = null;
        b.lastSeenX = n.x;
        b.lastSeenY = n.y;
      }
      return;
    }
  }

  private onHit(world: World, target: Entity, attacker: Entity | null, killed: boolean): void {
    const c = world.get(target, Creature);
    const b = world.get(target, CreatureBrain);
    if (!c || !b) return;
    b.sinceHurt = 0;
    b.revealed = 2.5;
    if (killed || attacker === null || attacker === target || !alive(world, attacker)) return;
    if (world.get(attacker, Creature)?.lairId === c.lairId) return;
    const def = this.content.get('creature', c.defId);
    // The whole pack remembers who did it.
    for (const m of world.query(Creature)) if (world.req(m, Creature).lairId === c.lairId) world.req(m, Creature).grudges.add(attacker);
    const h = world.req(target, Health);
    if (def.temperament === 'passive') {
      this.startFlee(world, target, b, attacker, 6 + this.rand() * 3);
      this.alertPack(world, target, attacker, true);
      return;
    }
    if (def.flee > 0 && h.hp < def.health * def.flee) return this.startFlee(world, target, b, attacker, 6 + this.rand() * 4);
    if (b.state !== 'attack') this.engage(world, target, b, def, attacker);
    this.alertPack(world, target, attacker, false);
  }

  private engage(world: World, e: Entity, b: CreatureBrain, def: CreatureDef, target: Entity): void {
    const fresh = b.target !== target || (b.state !== 'chase' && b.state !== 'stalk');
    b.target = target;
    const tt = world.req(target, Transform);
    b.lastSeenX = tt.x;
    b.lastSeenY = tt.y;
    b.sinceSeen = 0;
    if (b.state === 'attack') return;
    this.setState(b, def.temperament === 'ambush' ? 'stalk' : 'chase');
    b.goal = null;
    b.path = [];
    b.repathIn = 0;
    if (fresh) this.voice(world, e, 'alert');
  }

  /** Tells packmates nearby: they join the fight (or the stampede). */
  private alertPack(world: World, e: Entity, target: Entity, flee: boolean): void {
    const c = world.req(e, Creature);
    const t = world.req(e, Transform);
    for (const m of world.query(Creature, CreatureBrain, Transform)) {
      if (m === e || world.req(m, Creature).lairId !== c.lairId || !alive(world, m)) continue;
      const mt = world.req(m, Transform);
      if (Math.hypot(mt.x - t.x, mt.y - t.y) > PACK_RADIUS) continue;
      const mb = world.req(m, CreatureBrain);
      const def = this.content.get('creature', world.req(m, Creature).defId);
      if (flee) {
        if (mb.state !== 'flee') this.startFlee(world, m, mb, target, 5 + this.rand() * 3, { x: t.x, y: t.y });
      } else if (mb.state !== 'chase' && mb.state !== 'attack' && mb.state !== 'flee' && mb.state !== 'stalk') {
        if (alive(world, target)) this.engage(world, m, mb, def, target);
      }
    }
  }

  private packCount(world: World, lairId: string): { alive: number; total: number } {
    let living = 0;
    let total = 0;
    for (const m of world.query(Creature, Health)) {
      if (world.req(m, Creature).lairId !== lairId) continue;
      total++;
      if (!world.req(m, Health).dead) living++;
    }
    return { alive: living, total };
  }

  // ---- behaviour ---------------------------------------------------------------

  private setState(b: CreatureBrain, s: CreatureState): void {
    if (b.state === s) return;
    b.state = s;
    b.stateTime = 0;
    b.goal = null;
    b.path = [];
    b.repathIn = 0;
    if (s !== 'attack') b.attack = null;
  }

  private startFlee(world: World, e: Entity, b: CreatureBrain, from: Entity | null, seconds: number, at?: Point): void {
    const p = at ?? (from !== null && world.isAlive(from) ? world.req(from, Transform) : world.req(e, Transform));
    this.setState(b, 'flee');
    b.threatX = p.x;
    b.threatY = p.y;
    b.waitLeft = seconds;
    b.target = from;
  }

  private behave(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef, dt: number): void {
    const t = world.req(e, Transform);
    const vel = world.req(e, Velocity);
    vel.x = vel.y = 0;
    switch (b.state) {
      case 'rest':
      case 'wander':
        return this.idle(world, map, e, b, c, def, dt);
      case 'alert': {
        // Stand and face it; growl. Territorial ones hold their ground until it comes closer.
        const p = b.target !== null && alive(world, b.target) ? world.req(b.target, Transform) : { x: b.lastSeenX, y: b.lastSeenY };
        this.turnToward(c, def, p.x - t.x, p.y - t.y, dt);
        if (b.stateTime > (b.target !== null ? 6 : 2.5)) this.setState(b, 'wander');
        return;
      }
      case 'flee': {
        b.waitLeft -= dt;
        if (b.waitLeft <= 0) return this.setState(b, 'return');
        if (!b.goal || b.repathIn <= 0) {
          b.goal = runAway(map, t, { x: b.threatX, y: b.threatY }, 220 + this.rand() * 140, this.avoid);
          b.path = [];
          b.repathIn = 1.6;
          if (b.target !== null && alive(world, b.target)) {
            const tt = world.req(b.target, Transform);
            b.threatX = tt.x;
            b.threatY = tt.y;
          }
        }
        return this.move(world, map, e, b, c, def, dt, def.speed.run);
      }
      case 'return': {
        if (!b.goal) b.goal = { x: b.homeX + (this.rand() - 0.5) * b.radius, y: b.homeY + (this.rand() - 0.5) * b.radius };
        if (Math.hypot(t.x - b.homeX, t.y - b.homeY) < b.radius * 0.8) return this.setState(b, 'wander');
        this.move(world, map, e, b, c, def, dt, def.speed.walk * 1.4);
        if (!b.goal) this.setState(b, 'wander');
        return;
      }
      case 'stalk':
      case 'chase':
        return this.hunt(world, map, e, b, c, def, dt);
      case 'attack':
        return this.attacking(world, map, e, b, c, def, dt);
    }
  }

  private idle(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef, dt: number): void {
    const t = world.req(e, Transform);
    const awake = this.active(def);
    if (!awake && b.state !== 'rest') this.setState(b, 'rest');
    if (awake && b.state === 'rest') this.setState(b, 'wander');
    if (b.voiceIn <= 0) {
      b.voiceIn = 7 + this.rand() * 12;
      if (awake) this.voice(world, e, 'idle');
    }
    if (b.goal) {
      this.move(world, map, e, b, c, def, dt, def.speed.walk * (b.state === 'rest' ? 0.8 : 1));
      return;
    }
    b.waitLeft -= dt;
    if (b.waitLeft > 0) return;
    if (b.state === 'rest') {
      // Back to the den, then lie still.
      if (Math.hypot(t.x - b.homeX, t.y - b.homeY) > 40) b.goal = { x: b.homeX + (this.rand() - 0.5) * 30, y: b.homeY + (this.rand() - 0.5) * 30 };
      b.waitLeft = 6 + this.rand() * 6;
      return;
    }
    // Amble somewhere else within its range; herds drift together.
    b.waitLeft = 2 + this.rand() * 5;
    for (let i = 0; i < 6; i++) {
      const a = this.rand() * Math.PI * 2;
      const r = b.radius * Math.sqrt(this.rand());
      const x = b.homeX + Math.cos(a) * r;
      const y = b.homeY + Math.sin(a) * r;
      if (walkableAt(map, x, y) && !this.avoid?.(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX))) {
        b.goal = { x, y };
        break;
      }
    }
  }

  private hunt(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef, dt: number): void {
    const t = world.req(e, Transform);
    const target = b.target;
    if (target === null || !alive(world, target)) {
      b.target = null;
      return this.setState(b, 'return');
    }
    // Lost it, or dragged too far from home: give up.
    const fromHome = Math.hypot(t.x - b.homeX, t.y - b.homeY);
    if (b.sinceSeen > 8 || fromHome > def.leash) return this.setState(b, 'return');
    const tt = world.req(target, Transform);
    const dx = tt.x - t.x;
    const dy = tt.y - t.y;
    const dist = Math.hypot(dx, dy);
    // Territorial creatures stop once the intruder has fled far enough.
    if (def.temperament === 'territorial' && !world.req(e, Creature).grudges.has(target) && dist > def.territory * 2.2) return this.setState(b, 'return');
    const h = world.req(e, Health);
    if (def.flee > 0 && h.hp < def.health * def.flee) return this.startFlee(world, e, b, target, 6);

    // An attack in reach and ready? Wind it up.
    const pick = b.sinceSeen < 1 ? this.chooseAttack(world, map, e, b, def, target, dist) : -1;
    if (pick >= 0) return this.startAttack(world, e, b, def, pick, tt);

    // Otherwise close in. Packs circle at a distance while their bites recharge.
    const ready = def.attacks.some((a, i) => b.cooldowns[i]! <= 0 && isMelee(a));
    let speed = b.state === 'stalk' ? def.speed.walk * (dist < 200 ? 0.9 : 1.2) : def.speed.run;
    if (b.state === 'stalk' && (dist < 120 || b.sinceHurt < 2)) speed = def.speed.run; // spotted: go
    const reach = def.attacks.reduce((m, a) => (isMelee(a) ? Math.max(m, a.range) : m), 24);
    if (!ready && dist < reach + 70 && def.pack[1] > 1) {
      const a = Math.atan2(t.y - tt.y, t.x - tt.x) + b.orbit * 0.5;
      const r = reach + 50;
      b.goal = { x: tt.x + Math.cos(a) * r, y: tt.y + Math.sin(a) * r };
      b.path = [];
      if (this.rand() < dt * 0.3) b.orbit = (b.orbit * -1) as 1 | -1;
      this.steer(world, map, e, c, def, b.goal, def.speed.run * 0.75, dt);
      return;
    }
    // Ranged attackers keep their distance.
    const ranged = def.attacks.findIndex((a) => a.kind === 'spit');
    if (ranged >= 0 && dist < def.attacks[ranged]!.range * 0.45 && b.cooldowns[ranged]! > 0 && !def.attacks.some((a) => isMelee(a) && dist < a.range * 2)) {
      b.goal = runAway(map, t, tt, 120, this.avoid);
      return this.move(world, map, e, b, c, def, dt, def.speed.walk * 1.5);
    }
    const goal = b.sinceSeen < 1 ? { x: tt.x, y: tt.y } : { x: b.lastSeenX, y: b.lastSeenY };
    if (dist < 220 && walkableLine(map, t, goal, 5, this.creatureAvoid(map))) {
      b.path = [];
      b.goal = goal;
      this.steer(world, map, e, c, def, goal, speed, dt);
      return;
    }
    if (!b.goal || Math.hypot(b.goal.x - goal.x, b.goal.y - goal.y) > 48) {
      b.goal = goal;
      b.repathIn = Math.min(b.repathIn, 0);
    }
    this.move(world, map, e, b, c, def, dt, speed);
  }

  /** Best attack usable right now (by weight among those in range and ready), or -1. */
  private chooseAttack(world: World, map: TileMap, e: Entity, b: CreatureBrain, def: CreatureDef, target: Entity, dist: number): number {
    const t = world.req(e, Transform);
    const tt = world.req(target, Transform);
    const tc = world.get(target, Collider);
    const own = world.get(e, Collider);
    const slack = (tc ? tc.w / 2 : 6) + (own ? own.w / 2 : 6);
    let total = 0;
    const ok: number[] = [];
    def.attacks.forEach((a, i) => {
      if (b.cooldowns[i]! > 0) return;
      const reach = isMelee(a) ? a.range + slack * 0.5 : a.range;
      if (dist > reach || dist < a.minRange) return;
      if (a.kind === 'spit' && !lineOfSight(map, t.x, t.y - 10, tt.x, tt.y - 16)) return;
      if ((a.kind === 'charge' || a.kind === 'leap') && !walkableLine(map, t, tt, 6)) return;
      ok.push(i);
      total += a.weight;
    });
    if (!ok.length) return -1;
    let r = this.rand() * total;
    for (const i of ok) {
      r -= def.attacks[i]!.weight;
      if (r <= 0) return i;
    }
    return ok[ok.length - 1]!;
  }

  private startAttack(world: World, e: Entity, b: CreatureBrain, def: CreatureDef, index: number, at: Point): void {
    const t = world.req(e, Transform);
    this.setState(b, 'attack');
    const a = def.attacks[index]!;
    b.attack = { index, phase: 'windup', t: 0, dur: a.windup * (0.85 + this.rand() * 0.3), aimX: at.x, aimY: at.y, fromX: t.x, fromY: t.y, hit: [] };
    b.revealed = Math.max(b.revealed, 2);
    if (a.kind !== 'bite' && a.kind !== 'claw') this.voice(world, e, 'attack');
  }

  private attacking(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef, dt: number): void {
    const st = b.attack;
    if (!st) return this.setState(b, 'chase');
    const a = def.attacks[st.index]!;
    const t = world.req(e, Transform);
    const vel = world.req(e, Velocity);
    const target = b.target !== null && alive(world, b.target) ? b.target : null;
    const tt = target !== null ? world.req(target, Transform) : null;
    st.t += dt;
    if (st.phase === 'windup') {
      // Track the target while winding up.
      if (tt) {
        st.aimX = tt.x;
        st.aimY = tt.y;
        // Lead a moving target a little (pounces and globs).
        const tv = world.get(target!, Velocity);
        if (tv && (a.kind === 'leap' || a.kind === 'spit')) {
          const flight = Math.hypot(tt.x - t.x, tt.y - t.y) / (a.kind === 'spit' ? a.speed : def.speed.run * 1.5);
          st.aimX += tv.x * flight * 0.6;
          st.aimY += tv.y * flight * 0.6;
        }
      }
      this.turnToward(c, def, st.aimX - t.x, st.aimY - t.y, dt, 2.5);
      if (st.t >= st.dur) {
        st.phase = 'strike';
        st.t = 0;
        st.fromX = t.x;
        st.fromY = t.y;
        const d = Math.max(1, Math.hypot(st.aimX - t.x, st.aimY - t.y));
        if (a.kind === 'charge') st.dur = Math.min(1.6, (Math.max(d, 80) + 60) / (def.speed.run * 1.35));
        else if (a.kind === 'leap') st.dur = Math.max(0.32, Math.min(0.8, d / (def.speed.run * 1.6)));
        else if (a.kind === 'drain') st.dur = 0.7;
        else st.dur = a.kind === 'spit' ? 0.25 : 0.22;
        if (a.kind === 'spit') this.spit(world, e, a, st.aimX, st.aimY);
        if (a.kind === 'leap' || a.kind === 'charge') this.voice(world, e, 'attack');
        if (a.kind === 'bite' || a.kind === 'claw' || a.kind === 'drain') this.events.emit('creature', { entity: e, x: t.x, y: t.y, defId: def.id, sound: 'bite' });
      }
      return;
    }
    if (st.phase === 'strike') {
      const u = Math.min(1, st.t / st.dur);
      const dirX = st.aimX - st.fromX;
      const dirY = st.aimY - st.fromY;
      const len = Math.max(1, Math.hypot(dirX, dirY));
      if (a.kind === 'charge') {
        const sp = def.speed.run * 1.35;
        vel.x = (dirX / len) * sp;
        vel.y = (dirY / len) * sp;
        this.turnToward(c, def, dirX, dirY, dt);
        // Anyone in the way gets trampled; a wall stops it dead.
        this.trample(world, e, a, def);
        const moved = Math.hypot(t.x - t.prevX, t.y - t.prevY);
        if (st.t > 0.15 && moved < sp * dt * 0.3) {
          this.recover(b, 1.4);
          return;
        }
      } else if (a.kind === 'leap') {
        const d = Math.min(len, a.range * 1.1);
        vel.x = (dirX / len) * (d / st.dur);
        vel.y = (dirY / len) * (d / st.dur);
        b.lift = Math.sin(Math.PI * u) * Math.min(34, d * 0.22);
        if (u >= 1) {
          b.lift = 0;
          this.events.emit('creature', { entity: e, x: t.x, y: t.y, defId: def.id, sound: 'land' });
          if (target !== null && tt && Math.hypot(tt.x - t.x, tt.y - t.y) < reachOf(world, e, target, 22)) this.strike(world, e, target, a, def);
        }
      } else if (a.kind === 'bite' || a.kind === 'claw' || a.kind === 'drain') {
        // A short lunge, and the bite lands halfway.
        if (u < 0.5) {
          vel.x = (dirX / len) * def.speed.run * 0.5;
          vel.y = (dirY / len) * def.speed.run * 0.5;
        }
        if (!st.hit.length && u >= 0.45 && target !== null && tt) {
          const d = Math.hypot(tt.x - t.x, tt.y - t.y);
          const facing = Math.cos(c.heading) * (tt.x - t.x) + Math.sin(c.heading) * (tt.y - t.y);
          if (d < reachOf(world, e, target, a.range) && facing > -d * 0.2) {
            st.hit.push(target);
            this.strike(world, e, target, a, def);
          } else st.hit.push(-1);
        }
      }
      if (u >= 1) this.recover(b, a.kind === 'charge' ? 0.8 : a.kind === 'leap' ? 0.55 : a.kind === 'spit' ? 0.5 : 0.3);
      return;
    }
    // Recovering.
    vel.x = vel.y = 0;
    b.lift = 0;
    if (st.t >= st.dur) {
      b.cooldowns[st.index] = a.cooldown * (0.85 + this.rand() * 0.3);
      b.attack = null;
      this.setState(b, 'chase');
      if (def.abilities.burrow) b.revealed = 0;
    }
  }

  private recover(b: CreatureBrain, seconds: number): void {
    if (!b.attack) return;
    b.attack.phase = 'recover';
    b.attack.t = 0;
    b.attack.dur = seconds;
    b.lift = 0;
  }

  /** A charge runs over everyone in its path (once each). */
  private trample(world: World, e: Entity, a: CreatureAttack, def: CreatureDef): void {
    const st = world.req(e, CreatureBrain).attack!;
    const t = world.req(e, Transform);
    const r = def.hitbox.w / 2 + 10;
    for (const o of world.query(Character, Transform, Health)) {
      if (o === e || st.hit.includes(o) || world.req(o, Health).dead) continue;
      if (this.relations.attitude(world, e, o) === 'friendly') continue;
      const ot = world.req(o, Transform);
      if (Math.hypot(ot.x - t.x, ot.y - t.y) > r + (world.get(o, Collider)?.w ?? 12) / 2) continue;
      st.hit.push(o);
      this.strike(world, e, o, a, def);
    }
  }

  /** Lands a blow: damage, bleeding, a shove, and (draining) a meal. */
  private strike(world: World, e: Entity, victim: Entity, a: CreatureAttack, def: CreatureDef): void {
    const t = world.req(e, Transform);
    const vt = world.req(victim, Transform);
    const res = applyDamage(world, this.content, victim, { amount: a.damage, type: a.type, ap: a.ap, attacker: e });
    const vh = world.req(victim, Health);
    if (res.dealt > 0 && a.bleed > 0) vh.bleed = Math.min(4, vh.bleed + a.bleed);
    if (res.dealt > 0) vh.cause = `Killed by ${/^[aeiou]/i.test(def.name) ? 'an' : 'a'} ${def.name.toLowerCase()}.`;
    const angle = Math.atan2(vt.y - t.y, vt.x - t.x);
    this.events.emit('hit', { target: victim, attacker: e, x: vt.x, y: vt.y - 18, angle, ...res });
    if (res.killed) this.events.emit('death', { entity: victim, killer: e });
    if (a.heal > 0 && res.dealt > 0) {
      const h = world.req(e, Health);
      h.hp = Math.min(def.health, h.hp + res.dealt * a.heal);
    }
    const map = this.map();
    const col = world.get(victim, Collider);
    if (a.knockback > 0 && map && col && !vh.dead) {
      for (let i = 0; i < 4; i++) {
        vt.x = moveAxis(map, vt.x, vt.y, (Math.cos(angle) * a.knockback) / 4, col, 'x');
        vt.y = moveAxis(map, vt.x, vt.y, (Math.sin(angle) * a.knockback) / 4, col, 'y');
      }
    }
  }

  private spit(world: World, e: Entity, a: CreatureAttack, x: number, y: number): void {
    const t = world.req(e, Transform);
    const d = Math.max(20, Math.min(a.range * 1.1, Math.hypot(x - t.x, y - t.y)));
    const ang = Math.atan2(y - t.y, x - t.x);
    const flight = d / a.speed;
    const z0 = 12;
    const g = world.create();
    world.add(g, Transform, { x: t.x + Math.cos(ang) * 10, y: t.y + Math.sin(ang) * 10, prevX: t.x, prevY: t.y });
    world.add(g, Spit, {
      vx: Math.cos(ang) * a.speed,
      vy: Math.sin(ang) * a.speed,
      z: z0,
      vz: (0.5 * SPIT_G * flight * flight - z0) / flight,
      damage: a.damage,
      type: a.type,
      splash: a.splash,
      color: a.color,
      owner: e,
      faction: world.get(e, Faction)?.id ?? '',
      left: flight + 0.5,
    });
  }

  // ---- abilities ---------------------------------------------------------------

  private abilities(b: CreatureBrain, c: Creature, def: CreatureDef, dt: number): void {
    if (def.abilities.cloak) {
      const want = b.revealed > 0 || (b.attack && b.attack.phase !== 'windup') ? 1 : 0.06;
      c.visibility += (want - c.visibility) * Math.min(1, dt * (want > c.visibility ? 8 : 1.5));
    }
    if (def.abilities.burrow) {
      // Surfaces to strike (during the wind-up), dives back after.
      const st = b.attack;
      const want = st && (st.phase !== 'recover' || st.t < st.dur * 0.5) ? 0 : b.state === 'flee' && b.sinceHurt < 1 ? 0 : 1;
      const rate = st && st.phase === 'windup' ? 1 / Math.max(0.15, st.dur * 0.8) : 1.3;
      b.buried += Math.sign(want - b.buried) * Math.min(Math.abs(want - b.buried), rate * dt);
      c.hidden = b.buried > 0.6;
      c.visibility = 1 - b.buried;
    }
  }

  // ---- movement ----------------------------------------------------------------

  /** Closed doors count as walls for animals. */
  private creatureAvoid(map: TileMap): Avoid {
    return (tx, ty) => !!this.avoid?.(tx, ty) || map.isSolid(tx, ty);
  }

  private move(world: World, map: TileMap, e: Entity, b: CreatureBrain, c: Creature, def: CreatureDef, dt: number, speed: number): void {
    const t = world.req(e, Transform);
    if (!b.goal) return;
    if (b.repathIn <= 0 || !b.path.length) {
      if (this.avoid?.(Math.floor(b.goal.x / TILE_PX), Math.floor(b.goal.y / TILE_PX))) {
        b.goal = null;
        b.path = [];
        return;
      }
      const path = findPath(map, t, b.goal, b.state === 'chase' ? 1500 : 2500, this.creatureAvoid(map));
      b.repathIn = b.state === 'chase' || b.state === 'stalk' ? 0.8 : 4;
      if (!path) {
        b.goal = null;
        b.path = [];
        return;
      }
      b.path = path;
    }
    let next = b.path[0];
    while (next && Math.hypot(next.x - t.x, next.y - t.y) < ARRIVE) {
      b.path.shift();
      next = b.path[0];
    }
    if (!next) {
      b.goal = null;
      return;
    }
    this.steer(world, map, e, c, def, next, speed, dt);
    // Stuck against something: give up on this goal.
    const moved = Math.hypot(t.x - t.prevX, t.y - t.prevY);
    b.stuckFor = moved < speed * dt * 0.2 ? b.stuckFor + dt : 0;
    if (b.stuckFor > 1.2) {
      b.goal = null;
      b.path = [];
      b.stuckFor = 0;
    }
  }

  /** Heads for a point: turns at its agility and moves the way it faces (no strafing for animals). */
  private steer(world: World, _map: TileMap, e: Entity, c: Creature, def: CreatureDef, p: Point, speed: number, dt: number): void {
    const t = world.req(e, Transform);
    const vel = world.req(e, Velocity);
    const dx = p.x - t.x;
    const dy = p.y - t.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const off = this.turnToward(c, def, dx, dy, dt);
    // Slow down for sharp turns, so it swings round instead of sliding sideways.
    const k = Math.max(0.15, Math.cos(Math.min(Math.PI / 2, Math.abs(off))));
    const sp = Math.min(speed * k, d / dt);
    vel.x = Math.cos(c.heading) * sp * 0.6 + (dx / d) * sp * 0.4;
    vel.y = Math.sin(c.heading) * sp * 0.6 + (dy / d) * sp * 0.4;
  }

  /** Turns toward a direction; returns how far off it still is (radians). */
  private turnToward(c: Creature, def: CreatureDef, dx: number, dy: number, dt: number, boost = 1): number {
    if (dx === 0 && dy === 0) return 0;
    const want = Math.atan2(dy, dx);
    let diff = want - c.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const step = def.agility * boost * dt;
    c.heading += Math.max(-step, Math.min(step, diff));
    return diff - Math.max(-step, Math.min(step, diff));
  }

  /** Light push apart so packs don't stack up. */
  private separate(world: World, list: Entity[]): void {
    for (const a of list) {
      if (world.req(a, Health).dead) continue;
      const ta = world.req(a, Transform);
      const va = world.req(a, Velocity);
      const ra = (world.get(a, Collider)?.w ?? 12) / 2;
      for (const o of list) {
        if (o === a || world.req(o, Health).dead) continue;
        const to = world.req(o, Transform);
        const dx = ta.x - to.x;
        const dy = ta.y - to.y;
        const d = Math.hypot(dx, dy);
        // Bodies are longer than their feet box: keep a little more room.
        const min = (ra + (world.get(o, Collider)?.w ?? 12) / 2) * 1.6;
        if (d > 0.01 && d < min) {
          va.x += (dx / d) * (min - d) * 5;
          va.y += (dy / d) * (min - d) * 5;
        }
      }
    }
  }

  private voice(world: World, e: Entity, sound: 'idle' | 'alert' | 'attack'): void {
    const t = world.req(e, Transform);
    this.events.emit('creature', { entity: e, x: t.x, y: t.y, defId: world.req(e, Creature).defId, sound });
  }
}

/**
 * Spit globs: arc through the air, splash where they land (or on a wall),
 * hurting everyone in the splash who isn't on the spitter's side.
 */
export class SpitSystem implements System {
  readonly name = 'spit';

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
    private relations: Relations,
  ) {}

  update(world: World, dt: number): void {
    const map = this.map();
    for (const g of [...world.query(Spit, Transform)]) {
      const s = world.req(g, Spit);
      const t = world.req(g, Transform);
      t.prevX = t.x;
      t.prevY = t.y;
      const nx = t.x + s.vx * dt;
      const ny = t.y + s.vy * dt;
      s.z += s.vz * dt;
      s.vz -= SPIT_G * dt;
      s.left -= dt;
      const wall = map ? segmentHitsSolid(map, t.x, t.y, nx, ny, 'shots') : null;
      if (wall !== null) {
        t.x += (nx - t.x) * wall;
        t.y += (ny - t.y) * wall;
        this.splash(world, g, s, t.x, t.y);
        continue;
      }
      t.x = nx;
      t.y = ny;
      if (s.z <= 0 || s.left <= 0) this.splash(world, g, s, t.x, t.y);
    }
  }

  private splash(world: World, g: Entity, s: Spit, x: number, y: number): void {
    this.events.emit('splash', { x, y, radius: s.splash, color: s.color });
    const owner = world.isAlive(s.owner) ? s.owner : null;
    for (const o of world.query(Character, Transform, Health)) {
      if (o === s.owner || world.req(o, Health).dead) continue;
      if (owner !== null && this.relations.attitude(world, owner, o) === 'friendly') continue;
      if (owner === null && world.get(o, Faction)?.id === s.faction) continue;
      const ot = world.req(o, Transform);
      const d = Math.hypot(ot.x - x, ot.y - y);
      if (d > s.splash * 1.5) continue;
      const k = d <= s.splash ? 1 : 1 - (d - s.splash) / (s.splash * 0.5);
      const res = applyDamage(world, this.content, o, { amount: s.damage * k, type: s.type, ap: 0, attacker: owner });
      if (res.dealt > 0) world.req(o, Health).cause = 'Dissolved by acid.';
      this.events.emit('hit', { target: o, attacker: owner, x: ot.x, y: ot.y - 12, angle: Math.atan2(ot.y - y, ot.x - x), ...res });
      if (res.killed) this.events.emit('death', { entity: o, killer: owner });
    }
    world.destroy(g);
  }
}

function alive(world: World, e: Entity): boolean {
  return world.isAlive(e) && !(world.get(e, Health)?.dead ?? true);
}

const isMelee = (a: CreatureAttack) => a.kind === 'bite' || a.kind === 'claw' || a.kind === 'drain';

/** Center-to-center distance at which a blow of `range` lands. */
function reachOf(world: World, e: Entity, target: Entity, range: number): number {
  return range + ((world.get(e, Collider)?.w ?? 12) + (world.get(target, Collider)?.w ?? 12)) / 4;
}

function walkableAt(map: TileMap, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE_PX);
  const ty = Math.floor(y / TILE_PX);
  return map.inBounds(tx, ty) && !map.isSolid(tx, ty) && !map.isSolid(tx, ty - 1);
}

/** A spot roughly `dist` away from a threat, on open ground. */
function runAway(map: TileMap, from: Point, threat: Point, dist: number, avoid?: Avoid): Point | null {
  const away = Math.atan2(from.y - threat.y, from.x - threat.x);
  for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.3, -2.3]) {
    for (const k of [1, 0.6, 0.35]) {
      const x = from.x + Math.cos(away + turn) * dist * k;
      const y = from.y + Math.sin(away + turn) * dist * k;
      if (walkableAt(map, x, y) && !avoid?.(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX))) return { x, y };
    }
  }
  return null;
}
