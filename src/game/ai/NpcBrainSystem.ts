import type { EventBus } from '../../core/EventBus';
import { toDirection } from '../../core/math';
import type { ContentRegistry } from '../../content/Registry';
import type { WeaponDef } from '../../content/types';
import type { Entity, System, World } from '../../ecs/World';
import { aimHeight, CHEST_HEIGHT, lineOfSight, segmentHitsSolid } from '../combat';
import { liveGrenades, throwGrenade } from '../explosives';
import type { CombatEvents } from '../combatEvents';
import {
  Aim,
  Brain,
  Character,
  Combatant,
  Creature,
  Equipment,
  Faction,
  Health,
  Inventory,
  Npc,
  Stats,
  Transform,
  Velocity,
  type BrainState,
} from '../components';
import { pickQuickHeal, useConsumable } from '../consumables';
import { PLAYER_FACTION, type Relations } from '../factions';
import { countItem, takeItem } from '../items';
import type { TileMap } from '../world/TileMap';
import { TILE_PX } from '../world/TileMap';
import { findPath, type Avoid, type Point } from './pathfinding';

/** Vision: range, half-angle of the cone (cos), and the "feel someone right behind you" radius. */
const SIGHT = 380;
const FOV_COS = Math.cos((75 * Math.PI) / 180);
const CLOSE_SENSE = 80;
/** Gunshots are heard this far away. */
const SHOT_HEARING = 560;
/** Squadmates within this range get told about a contact. */
const SQUAD_RADIUS = 520;
const PERCEPTION_INTERVAL = 0.2;
const ARRIVE = 7;
/** Explosions are heard this far away. */
const BLAST_HEARING = 900;
/**
 * Grenades are rare: after any NPC throws one, nobody else may for this long
 * (plus a random bit), and each NPC waits much longer before its next.
 */
const GROUP_GRENADE_COOLDOWN = 18;
const OWN_GRENADE_COOLDOWN = 50;

export type BarkKind = 'greet' | 'contact' | 'hurt' | 'reload' | 'retreat' | 'angry' | 'search' | 'grenadeOut' | 'grenade';

interface Noise {
  x: number;
  y: number;
  source: Entity;
  radius: number;
}

/**
 * NPC decision-making. A small state machine per NPC:
 *
 *   idle / patrol ──hears shot──► investigate ──spots hostile──► combat
 *        ▲                              │                         │  ▲
 *        └────────── gives up ◄─────────┘          low health ──► retreat (hide, heal)
 *
 * Perception runs a few times per second (staggered) to stay cheap; movement and
 * trigger control run every tick. NPCs only write intents (velocity, aim,
 * Combatant flags), exactly like the player's controls, so all combat rules are
 * shared.
 */
export class NpcBrainSystem implements System {
  readonly name = 'npcBrain';
  private noises: Noise[] = [];
  private world: World | null = null;
  /** Seconds until any NPC may throw a grenade (shared, so they never all throw at once). */
  private groupGrenadeIn = 10;
  /** Live grenades this tick (computed once). */
  private grenades: { e: Entity; x: number; y: number; radius: number; left: number }[] = [];

  /** Known hazards (anomalies) to route around. */
  avoid?: Avoid;
  /** How lit a spot is (0 dark .. 1 daylight); in the dark, people are only noticed close up or in a light. */
  lightAt?: (x: number, y: number) => number;
  /** How far anyone can see in this weather (fog, rain): a multiplier on sight range. */
  sightScale?: () => number;
  /** Is this tile burning? NPCs standing in fire run out of it. */
  onFire?: (tx: number, ty: number) => boolean;

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
    private relations: Relations,
    private bark: (e: Entity, kind: BarkKind) => void,
    /** Source of randomness (seedable for tests). */
    private rand: () => number = Math.random,
  ) {
    events.on('shot', (s) => this.noises.push({ x: s.x, y: s.y, source: s.shooter, radius: SHOT_HEARING }));
    events.on('explosion', (x) => this.noises.push({ x: x.x, y: x.y, source: x.owner ?? -1, radius: BLAST_HEARING }));
    events.on('hit', (h) => this.world && this.onHit(this.world, h.target, h.attacker, h.killed));
    events.on('death', (d) => this.world && this.onDeath(this.world, d.entity, d.killer));
  }

  update(world: World, dt: number): void {
    this.world = world;
    const map = this.map();
    if (!map) return;
    const npcs = [...world.query(Npc, Brain, Transform, Velocity, Combatant, Aim, Character, Health)];
    this.groupGrenadeIn -= dt;
    this.grenades = liveGrenades(world, this.content);
    for (const e of npcs) {
      if (world.req(e, Health).dead) continue;
      const b = world.req(e, Brain);
      b.grenadeIn -= dt;
      if (this.dodge(world, map, e, b, dt)) {
        this.move(world, map, e, b, dt);
        continue;
      }
      b.stateTime += dt;
      b.barkCooldown -= dt;
      b.repathIn -= dt;
      b.thinkIn -= dt;
      b.sinceSeen += dt;
      if (b.reaction > 0) b.reaction -= dt;
      if (b.thinkIn <= 0) {
        b.thinkIn = PERCEPTION_INTERVAL;
        this.perceive(world, map, e, b);
      }
      this.hear(world, map, e, b);
      this.behave(world, map, e, b, dt);
      this.move(world, map, e, b, dt);
    }
    this.separate(world, npcs);
    this.noises.length = 0;
  }

  // ---- perception -----------------------------------------------------------

  /** `anyDirection`: ignore the view cone (e.g. turning toward a gunshot). */
  private canSee(world: World, map: TileMap, e: Entity, o: Entity, anyDirection = false): { seen: boolean; dist: number } {
    const t = world.req(e, Transform);
    const ot = world.req(o, Transform);
    const dx = ot.x - t.x;
    const dy = ot.y - t.y;
    const dist = Math.hypot(dx, dy);
    let sight = SIGHT * (this.sightScale?.() ?? 1);
    // Burrowed creatures can't be seen at all; cloaked ones only up close.
    const cr = world.get(o, Creature);
    if (cr?.hidden) return { seen: false, dist };
    if (cr && cr.visibility < 0.5) sight = Math.min(sight, 70);
    if (dist > sight) return { seen: false, dist };
    // Darkness shortens sight: someone unlit is only made out close by.
    if (dist > CLOSE_SENSE && this.lightAt) {
      const lit = Math.max(0, Math.min(1, (this.lightAt(ot.x, ot.y - CHEST_HEIGHT * 0.5) - 0.12) / 0.55));
      if (dist > CLOSE_SENSE + (sight - CLOSE_SENSE) * lit) return { seen: false, dist };
    }
    if (dist > CLOSE_SENSE && !anyDirection) {
      const aim = world.get(e, Aim)?.dir;
      const facing = aim ?? dirOf(world.req(e, Character).facing);
      if ((dx * facing.x + dy * facing.y) / Math.max(1, dist) < FOV_COS) return { seen: false, dist };
    }
    return { seen: lineOfSight(map, t.x, t.y - CHEST_HEIGHT, ot.x, ot.y - CHEST_HEIGHT), dist };
  }

  private perceive(world: World, map: TileMap, e: Entity, b: Brain): void {
    const npc = world.req(e, Npc);
    // Keep track of the current target.
    if (b.target !== null) {
      if (!alive(world, b.target)) {
        b.target = null;
        b.targetVisible = false;
      } else {
        const { seen } = this.canSee(world, map, e, b.target);
        b.targetVisible = seen;
        if (seen) {
          const tt = world.req(b.target, Transform);
          b.lastSeenX = tt.x;
          b.lastSeenY = tt.y;
          b.sinceSeen = 0;
        }
      }
    }
    // Look for hostiles not yet noticed (or a better target when the current one is hidden).
    let best: Entity | null = null;
    let bestDist = Infinity;
    for (const o of world.query(Health, Transform, Faction)) {
      if (o === e || o === b.target || world.req(o, Health).dead) continue;
      if (!this.relations.hostile(world, e, o)) continue;
      const { seen, dist } = this.canSee(world, map, e, o);
      if (seen && dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    if (best === null || (b.target !== null && b.targetVisible)) {
      b.awareness = Math.max(0, b.awareness - 0.5 * PERCEPTION_INTERVAL);
      if (best === null) b.candidate = null;
      return;
    }
    if (b.candidate !== best) {
      b.candidate = best;
      b.awareness = Math.min(b.awareness, 0.3);
    }
    const ch = world.get(best, Character);
    const loud = ch?.sprinting || (world.get(best, Combatant)?.trigger ?? false) ? 1.6 : 1;
    const rate = (0.6 + npc.skill) * (1.5 - bestDist / SIGHT) * 1.3 * loud;
    // Already fighting someone: notice new threats immediately.
    b.awareness += (b.state === 'combat' ? 4 : rate) * PERCEPTION_INTERVAL;
    if (b.awareness >= 1) this.engage(world, e, b, best, true);
  }

  private hear(world: World, map: TileMap, e: Entity, b: Brain): void {
    if (!this.noises.length || b.state === 'combat' || b.state === 'retreat') return;
    const t = world.req(e, Transform);
    for (const n of this.noises) {
      if (n.source === e) continue;
      if (Math.hypot(n.x - t.x, n.y - t.y) > n.radius) continue;
      // A shot from an enemy that's close or in view: fight. Otherwise: go have a look.
      const hostile = alive(world, n.source) && this.relations.hostile(world, e, n.source);
      if (hostile && (Math.hypot(n.x - t.x, n.y - t.y) < 220 || this.canSee(world, map, e, n.source, true).seen)) {
        this.engage(world, e, b, n.source, false);
      } else {
        this.setState(b, 'investigate');
        b.interestX = n.x + (this.rand() - 0.5) * 64;
        b.interestY = n.y + (this.rand() - 0.5) * 64;
        b.goal = { x: b.interestX, y: b.interestY };
        b.repathIn = 0;
        if (this.rand() < 0.3) this.say(world, e, 'search');
      }
      return;
    }
  }

  /** Start fighting `target`; optionally tell nearby squadmates. */
  private engage(world: World, e: Entity, b: Brain, target: Entity, alertSquad: boolean, quiet = false): void {
    const wasFighting = b.state === 'combat' && b.target !== null;
    b.target = target;
    b.candidate = null;
    b.awareness = 1;
    const tt = world.req(target, Transform);
    b.lastSeenX = tt.x;
    b.lastSeenY = tt.y;
    b.sinceSeen = 0;
    b.targetVisible = true;
    if (!wasFighting) {
      const skill = world.req(e, Npc).skill;
      b.reaction = 0.25 + (1 - skill) * 0.6 + this.rand() * 0.25;
      this.setState(b, 'combat');
      if (!quiet) this.say(world, e, 'contact');
    }
    if (alertSquad) this.alertSquad(world, e, target);
  }

  private alertSquad(world: World, e: Entity, target: Entity): void {
    const camp = world.req(e, Npc).campId;
    const t = world.req(e, Transform);
    for (const m of world.query(Npc, Brain, Transform)) {
      if (m === e || world.req(m, Npc).campId !== camp || !alive(world, m)) continue;
      const mt = world.req(m, Transform);
      if (Math.hypot(mt.x - t.x, mt.y - t.y) > SQUAD_RADIUS) continue;
      const mb = world.req(m, Brain);
      if (mb.state === 'combat' && mb.target !== null) continue;
      this.engage(world, m, mb, target, false, this.rand() < 0.75); // not everyone shouts at once
      // They were told, not shown: they head for the spot and must see the target themselves.
      mb.targetVisible = false;
      mb.sinceSeen = 0.5;
    }
  }

  private onHit(world: World, target: Entity, attacker: Entity | null, killed: boolean): void {
    if (attacker === null || attacker === target || !world.isAlive(attacker)) return;
    const npc = world.get(target, Npc);
    if (!npc) return;
    // The player hurting a faction that isn't at war with them costs reputation (grudges don't excuse it).
    const victimFaction = world.get(target, Faction)?.id ?? '';
    if (world.get(attacker, Faction)?.id === PLAYER_FACTION && this.relations.playerAttitude(victimFaction) !== 'hostile') {
      this.relations.playerAggression(victimFaction, killed);
    }
    if (!this.relations.hostile(world, target, attacker)) {
      // Friendly fire or an unprovoked attack: the whole squad holds a grudge.
      for (const m of world.query(Npc)) if (world.req(m, Npc).campId === npc.campId) world.req(m, Npc).grudges.add(attacker);
      if (!killed) this.say(world, target, 'angry');
    } else if (!killed && this.rand() < 0.35) {
      this.say(world, target, 'hurt');
    }
    if (killed) return;
    const b = world.get(target, Brain);
    if (b && alive(world, attacker)) this.engage(world, target, b, attacker, true);
  }

  private onDeath(world: World, dead: Entity, killer: Entity | null): void {
    const npc = world.get(dead, Npc);
    if (!npc || killer === null || !world.isAlive(killer)) return;
    const t = world.req(dead, Transform);
    for (const m of world.query(Npc, Brain, Transform)) {
      if (m === dead || world.req(m, Npc).campId !== npc.campId || !alive(world, m)) continue;
      const mt = world.req(m, Transform);
      if (Math.hypot(mt.x - t.x, mt.y - t.y) <= SQUAD_RADIUS && this.relations.hostile(world, m, killer)) {
        this.engage(world, m, world.req(m, Brain), killer, false, this.rand() < 0.5);
      }
    }
  }

  // ---- grenades -------------------------------------------------------------------

  /**
   * Runs from a live grenade it can see (or one right at its feet), after a
   * short beat to react. Returns true while running (no shooting meanwhile).
   */
  private dodge(world: World, map: TileMap, e: Entity, b: Brain, dt: number): boolean {
    const t = world.req(e, Transform);
    // Standing in flames: out, now (no reaction delay, no shooting).
    if (b.dodging === null && this.onFire?.(Math.floor(t.x / TILE_PX), Math.floor((t.y - 2) / TILE_PX))) {
      if (!b.goal || this.onFire(Math.floor(b.goal.x / TILE_PX), Math.floor(b.goal.y / TILE_PX))) {
        b.goal = escapeFrom(map, t, { x: t.x, y: t.y }, TILE_PX * 1.6, this.avoid, b.goal ? this.rand : null);
        b.path = [];
        b.repathIn = 0;
      }
      world.req(e, Combatant).trigger = false;
      world.req(e, Character).sprinting = true;
      return true;
    }
    if (this.husk(world, e)) return false;
    let threat = b.dodging !== null ? this.grenades.find((g) => g.e === b.dodging) : undefined;
    if (!threat) {
      if (b.dodging !== null) {
        // It went off (or rolled away): back to business.
        b.dodging = null;
        b.goal = null;
        b.path = [];
        b.repathIn = 0;
        world.req(e, Character).sprinting = false;
      }
      // Anything that clatters down within reach gets noticed: seen, quicker; only heard, a beat later.
      threat = this.grenades.find((g) => Math.hypot(g.x - t.x, g.y - t.y) < g.radius + 20);
      if (!threat) return false;
      const seen = lineOfSight(map, t.x, t.y - CHEST_HEIGHT, threat.x, threat.y - 2);
      b.dodging = threat.e;
      b.dodgeIn = 0.2 + (1 - world.req(e, Npc).skill) * 0.4 + this.rand() * 0.2 + (seen ? 0 : 0.35);
    }
    world.req(e, Combatant).trigger = false;
    if (b.dodgeIn > 0) {
      b.dodgeIn -= dt;
      if (b.dodgeIn > 0) return true;
      this.say(world, e, 'grenade', 3);
      b.goal = escapeFrom(map, t, threat, threat.radius, this.avoid);
      b.path = [];
      b.repathIn = 0;
    } else if (!b.goal) {
      // The way out had no route (or it got there and the thing still hasn't gone off): another spot, at random.
      b.goal = escapeFrom(map, t, threat, threat.radius, this.avoid, this.rand);
      b.path = [];
      b.repathIn = 0;
    }
    world.req(e, Aim).dir = null;
    world.req(e, Character).sprinting = true;
    // Keep the escape route fixed (don't re-plan every tick).
    if (b.goal) b.repathIn = Math.max(b.repathIn, 0.5);
    return true;
  }

  /**
   * Rarely, a grenade to flush out an enemy who has gone to ground behind
   * cover: only when the target has been out of sight for a few seconds, at a
   * sensible range, onto a spot the NPC can actually lob it to, never near a
   * squadmate, and with long cooldowns (each NPC's own, and one shared by
   * everyone). It shouts first, so the target gets a warning.
   */
  private considerGrenade(world: World, map: TileMap, e: Entity, b: Brain): boolean {
    if (this.husk(world, e)) return false;
    if (b.grenadeIn > 0 || this.groupGrenadeIn > 0 || b.targetVisible || b.reaction > 0) return false;
    if (b.sinceSeen < 2.5 || b.sinceSeen > 9) return false;
    const inv = world.req(e, Inventory);
    const item = inv.find((it) => this.content.tryGet('explosive', it.defId)?.use === 'throw');
    const def = item && this.content.tryGet('explosive', item.defId);
    if (!def) return false;
    const t = world.req(e, Transform);
    const dist = Math.hypot(b.lastSeenX - t.x, b.lastSeenY - t.y);
    if (dist < TILE_PX * 4 || dist > def.range * TILE_PX * 0.9) return false;
    // Not every chance gets taken.
    b.grenadeIn = 3 + this.rand() * 3;
    if (this.rand() < 0.5) return false;
    const r = def.blast.radius * TILE_PX;
    const friends = [...world.query(Npc, Transform, Health)].filter((o) => !world.req(o, Health).dead && !this.relations.hostile(world, e, o));
    const spots: Point[] = [{ x: b.lastSeenX, y: b.lastSeenY }];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (const rr of [0.8, 1.5]) spots.push({ x: b.lastSeenX + Math.cos(a) * rr * TILE_PX, y: b.lastSeenY + Math.sin(a) * rr * TILE_PX });
    }
    const spot = spots.find(
      (p) =>
        !map.isSolid(Math.floor(p.x / TILE_PX), Math.floor(p.y / TILE_PX)) &&
        lineOfSight(map, t.x, t.y - 4, p.x, p.y - 4) &&
        segmentHitsSolid(map, p.x, p.y - 4, b.lastSeenX, b.lastSeenY - CHEST_HEIGHT * 0.5) === null &&
        friends.every((o) => {
          const ot = world.req(o, Transform);
          return Math.hypot(ot.x - p.x, ot.y - p.y) > r + TILE_PX;
        }),
    );
    if (!spot) return false;
    takeItem(inv, def.id, 1);
    this.say(world, e, 'grenadeOut', 2);
    throwGrenade(world, def, t.x, t.y - 2, spot.x, spot.y, e, world.get(e, Faction)?.id ?? null);
    this.events.emit('grenadeThrown', { thrower: e, x: t.x, y: t.y, defId: def.id });
    b.grenadeIn = OWN_GRENADE_COOLDOWN + this.rand() * 30;
    this.groupGrenadeIn = GROUP_GRENADE_COOLDOWN + this.rand() * 12;
    return true;
  }

  // ---- behaviour ---------------------------------------------------------------

  private setState(b: Brain, s: BrainState): void {
    if (b.state === s) return;
    b.state = s;
    b.stateTime = 0;
    b.goal = null;
    b.path = [];
    b.waitLeft = 0;
    b.lookAt = null;
  }

  private behave(world: World, map: TileMap, e: Entity, b: Brain, dt: number): void {
    const c = world.req(e, Combatant);
    c.trigger = false;
    switch (b.state) {
      case 'idle':
        return this.idle(world, map, e, b, dt);
      case 'patrol':
        return this.patrol(world, e, b, dt);
      case 'investigate':
        return this.investigate(world, e, b, dt);
      case 'combat':
        return this.combat(world, map, e, b, dt);
      case 'retreat':
        return this.retreat(world, map, e, b);
    }
  }

  private calmDown(b: Brain): void {
    this.setState(b, b.behavior === 'patrol' ? 'patrol' : 'idle');
    b.target = null;
    b.awareness = 0;
  }

  private idle(world: World, map: TileMap, e: Entity, b: Brain, dt: number): void {
    const t = world.req(e, Transform);
    world.req(e, Aim).dir = null;
    // Chat with a non-hostile player who walks up.
    for (const p of world.query(Health, Transform, Faction)) {
      if (world.req(p, Faction).id !== PLAYER_FACTION || world.req(p, Health).dead) continue;
      const pt = world.req(p, Transform);
      if (Math.hypot(pt.x - t.x, pt.y - t.y) < 64 && !this.relations.hostile(world, e, p)) {
        b.goal = null;
        b.path = [];
        b.lookAt = { x: pt.x, y: pt.y };
        b.waitLeft = Math.max(b.waitLeft, 1.5);
        if (b.barkCooldown <= 0) this.say(world, e, 'greet', 25);
        return;
      }
    }
    if (Math.hypot(t.x - b.homeX, t.y - b.homeY) > b.radius * 1.6 && !b.goal) {
      b.goal = { x: b.homeX, y: b.homeY };
      b.repathIn = 0;
      return;
    }
    if (b.goal) return;
    b.waitLeft -= dt;
    if (b.waitLeft > 0) return;
    b.waitLeft = 3 + this.rand() * 6;
    if (this.rand() < 0.6) {
      const a = this.rand() * Math.PI * 2;
      const r = this.rand() * b.radius;
      const gx = b.homeX + Math.cos(a) * r;
      const gy = b.homeY + Math.sin(a) * r;
      if (!map.isSolid(Math.floor(gx / TILE_PX), Math.floor(gy / TILE_PX))) {
        b.goal = { x: gx, y: gy };
        b.repathIn = 0;
      }
    } else {
      const a = this.rand() * Math.PI * 2;
      b.lookAt = { x: t.x + Math.cos(a) * 50, y: t.y + Math.sin(a) * 50 };
    }
  }

  private patrol(world: World, e: Entity, b: Brain, dt: number): void {
    world.req(e, Aim).dir = null;
    if (!b.waypoints.length) return this.setState(b, 'idle');
    if (b.goal) return;
    b.waitLeft -= dt;
    if (b.waitLeft > 0) return;
    // Squad members walk the same route with small offsets so they don't stack up.
    const idx = Number(world.req(e, Npc).id.split(':').pop()) || 0;
    const wp = b.waypoints[b.waypointIndex % b.waypoints.length]!;
    b.goal = { x: wp.x + ((idx % 3) - 1) * 22, y: wp.y + (Math.floor(idx / 3) - 0) * 22 };
    b.repathIn = 0;
    b.waypointIndex++;
    b.waitLeft = 2 + this.rand() * 2.5;
  }

  private investigate(world: World, e: Entity, b: Brain, dt: number): void {
    const t = world.req(e, Transform);
    world.req(e, Aim).dir = null;
    if (b.goal) {
      if (b.stateTime > 20) this.calmDown(b);
      return;
    }
    // Arrived: look around for a while.
    b.waitLeft -= dt;
    if (b.waitLeft <= 0) {
      b.waitLeft = 1.2;
      const a = this.rand() * Math.PI * 2;
      b.lookAt = { x: t.x + Math.cos(a) * 50, y: t.y + Math.sin(a) * 50 };
    }
    if (Math.hypot(t.x - b.interestX, t.y - b.interestY) < 48 && b.stateTime > 6) this.calmDown(b);
    else if (b.stateTime > 25) this.calmDown(b);
  }

  private combat(world: World, map: TileMap, e: Entity, b: Brain, dt: number): void {
    const t = world.req(e, Transform);
    const c = world.req(e, Combatant);
    const npc = world.req(e, Npc);
    const h = world.req(e, Health);
    const maxHp = world.get(e, Stats)?.get('max_health') ?? 100;
    const target = b.target;
    if (target === null || !alive(world, target)) {
      // Target dead or gone: keep looking for a bit, then stand down.
      if (b.stateTime > 2) this.calmDown(b);
      return;
    }
    if (b.sinceSeen > 10) {
      this.setState(b, 'investigate');
      b.interestX = b.lastSeenX;
      b.interestY = b.lastSeenY;
      b.goal = { x: b.lastSeenX, y: b.lastSeenY };
      this.say(world, e, 'search');
      return;
    }

    // Weapons: switch away from an empty gun, give up if nothing can fire.
    const weapon = this.activeWeapon(world, e);
    if (!weapon || !this.usable(world, e, weapon.def, weapon.item)) {
      const other = (['primary', 'sidearm'] as const).find((s) => {
        const it = world.req(e, Equipment)[s];
        const d = it && this.content.tryGet('weapon', it.defId);
        return d && it && s !== c.active && this.usable(world, e, d, it);
      });
      if (other) c.wantSwitch = other;
      else return this.startRetreat(world, map, e, b);
    }

    // Hurt: get out of sight and patch up (or flee if out of supplies).
    const husk = this.husk(world, e);
    const hpFrac = husk ? 1 : h.hp / maxHp;
    const hasMeds = !!pickQuickHeal(this.content, world.req(e, Inventory), hpFrac, h.bleed);
    if ((hpFrac < 0.35 && hasMeds) || (hpFrac < 0.2 && this.rand() < (1 - npc.skill) * dt * 2)) {
      return this.startRetreat(world, map, e, b);
    }

    // Aim at the target (or where it was last seen).
    const tt = world.req(target, Transform);
    const ax = b.targetVisible ? tt.x : b.lastSeenX;
    const ay = (b.targetVisible ? tt.y : b.lastSeenY) - aimHeight(world, target);
    const dx = ax - t.x;
    const dy = ay - (t.y - CHEST_HEIGHT);
    const dist = Math.hypot(dx, dy);
    const aim = world.req(e, Aim);
    // Inaccuracy: worse for low skill, at range and while moving; re-rolled per burst.
    const vel = world.req(e, Velocity);
    const moving = Math.hypot(vel.x, vel.y) > 5 ? 2.5 : 0;
    const errDeg = 1.5 + (1 - npc.skill) * 8 + dist / 70 + moving;
    if (b.burstLeft <= 0 && b.pauseLeft <= 0) b.strafeDir = this.rand() < 0.5 ? 1 : -1;
    const jitter = ((this.rand() - 0.5) * errDeg * Math.PI) / 180;
    const angle = Math.atan2(dy, dx) + (b.targetVisible ? jitter * 0.35 + (b.strafeDir * errDeg * 0.3 * Math.PI) / 180 : 0);
    aim.dir = { x: Math.cos(angle), y: Math.sin(angle) };
    world.req(e, Character).facing = toDirection({ x: dx, y: dy }, world.req(e, Character).facing);

    // Now and then, a grenade at someone hiding behind cover.
    if (this.considerGrenade(world, map, e, b)) return;

    // Positioning, re-thought every second or so.
    if (!b.goal && b.repathIn <= 0) {
      b.repathIn = 0.9 + this.rand() * 0.8;
      const range = weapon ? preferredRange(weapon.def) : 180;
      if (husk) {
        // Straight at you, stopping now and then to fire.
        b.goal = !b.targetVisible ? { x: b.lastSeenX, y: b.lastSeenY } : dist > range * 0.5 && this.rand() < 0.75 ? { x: t.x + (dx / dist) * 80, y: t.y + (dy / dist) * 80 } : null;
      } else if (c.reloadLeft > 0 && npc.skill > 0.35) {
        b.goal = hideSpot(map, t, tt) ?? null;
      } else if (!b.targetVisible) {
        b.goal = { x: b.lastSeenX, y: b.lastSeenY };
      } else if (dist < range * 0.55) {
        b.goal = stepAway(map, t, tt, 64);
      } else if (dist > range * 1.25) {
        b.goal = { x: t.x + (dx / dist) * Math.min(96, dist - range), y: t.y + (dy / dist) * Math.min(96, dist - range) };
      } else if (this.rand() < 0.7) {
        b.goal = strafe(map, t, dx / dist, dy / dist, b.strafeDir * (40 + this.rand() * 40));
      }
    }

    // Shooting.
    if (!weapon || !b.targetVisible || b.reaction > 0 || c.reloadLeft > 0 || c.switchLeft > 0) return;
    if ((weapon.item.loaded ?? 0) <= 0) {
      c.wantReload = true;
      if (this.squadNear(world, e)) this.say(world, e, 'reload', 6);
      return;
    }
    if (!this.lineOfFireClear(world, e, target)) {
      b.repathIn = 0; // reposition instead of shooting a friend
      return;
    }
    if (b.burstLeft > 0) {
      b.burstLeft -= dt;
      c.trigger = weapon.def.fireMode === 'auto' ? true : !c.triggerPrev;
      if (b.burstLeft <= 0) b.pauseLeft = (0.25 + this.rand() * 0.7) * (1.3 - npc.skill);
    } else if ((b.pauseLeft -= dt) <= 0) {
      b.burstLeft = weapon.def.fireMode === 'auto' ? 0.2 + this.rand() * 0.5 : 60 / weapon.def.fireRate + 0.05;
    }
  }

  private startRetreat(world: World, map: TileMap, e: Entity, b: Brain): void {
    const target = b.target;
    const t = world.req(e, Transform);
    this.setState(b, 'retreat');
    b.target = target;
    const from = target !== null && world.isAlive(target) ? world.req(target, Transform) : { x: b.lastSeenX, y: b.lastSeenY };
    b.goal = hideSpot(map, t, from) ?? stepAway(map, t, from, 160);
    b.repathIn = 0;
    this.say(world, e, 'retreat');
  }

  private retreat(world: World, map: TileMap, e: Entity, b: Brain): void {
    world.req(e, Aim).dir = null;
    world.req(e, Character).sprinting = !!b.goal;
    if (b.goal && b.stateTime < 6) return;
    world.req(e, Character).sprinting = false;
    // Safe(ish): heal up, then go back to the fight.
    const h = world.req(e, Health);
    const maxHp = world.get(e, Stats)?.get('max_health') ?? 100;
    const inv = world.req(e, Inventory);
    if (b.waitLeft <= 0) {
      const med = pickQuickHeal(this.content, inv, h.hp / maxHp, h.bleed);
      if (med) useConsumable(world, this.content, e, med);
      b.waitLeft = 1.5;
    }
    b.waitLeft -= PERCEPTION_INTERVAL / 4;
    const healthy = h.hp / maxHp > 0.6 || !pickQuickHeal(this.content, inv, h.hp / maxHp, h.bleed);
    if (healthy && b.stateTime > 4) {
      const target = b.target;
      if (target !== null && alive(world, target) && this.activeWeapon(world, e)) {
        this.setState(b, 'combat');
        b.target = target;
        b.reaction = 0.3;
      } else {
        this.calmDown(b);
      }
    } else if (b.stateTime > 30) {
      this.calmDown(b);
      b.goal = { x: b.homeX, y: b.homeY };
    }
    void map;
  }

  // ---- movement ----------------------------------------------------------------

  private move(world: World, map: TileMap, e: Entity, b: Brain, dt: number): void {
    const t = world.req(e, Transform);
    const vel = world.req(e, Velocity);
    const ch = world.req(e, Character);
    const speedStat = world.get(e, Stats)?.get('move_speed') ?? 70;
    vel.x = vel.y = 0;
    if (!b.goal) {
      if (b.lookAt) ch.facing = toDirection({ x: b.lookAt.x - t.x, y: b.lookAt.y - t.y }, ch.facing);
      ch.sprinting = false;
      return;
    }
    if (b.repathIn <= 0 || !b.path.length) {
      // Never head into an anomaly on purpose.
      if (this.avoid?.(Math.floor(b.goal.x / TILE_PX), Math.floor(b.goal.y / TILE_PX))) {
        b.goal = null;
        b.path = [];
        return;
      }
      const path = findPath(map, t, b.goal, b.state === 'combat' ? 1500 : 3000, this.avoid);
      b.repathIn = b.state === 'combat' ? 1.2 : 4;
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
    const dx = next.x - t.x;
    const dy = next.y - t.y;
    const d = Math.hypot(dx, dy);
    // Running from a grenade (or for cover) is flat out; walking about is easy.
    const husk = this.husk(world, e);
    if (husk) ch.sprinting = false;
    const pace = husk ? 0.5 : b.dodging !== null || b.state === 'retreat' ? 1 : b.state === 'combat' ? 0.85 : 0.55;
    const speed = speedStat * pace * (ch.sprinting ? world.get(e, Stats)?.get('sprint_multiplier') ?? 1.5 : 1);
    vel.x = (dx / d) * speed;
    vel.y = (dy / d) * speed;
    if (b.state !== 'combat') ch.facing = toDirection(vel, ch.facing);
    // Stuck against something for a while: give up on this goal.
    const moved = Math.hypot(t.x - t.prevX, t.y - t.prevY);
    b.stuckFor = moved < speed * dt * 0.2 ? b.stuckFor + dt : 0;
    if (b.stuckFor > 1.2) {
      b.goal = null;
      b.path = [];
      b.stuckFor = 0;
    }
  }

  /** Light push apart so NPCs don't stand inside each other. */
  private separate(world: World, npcs: Entity[]): void {
    for (let i = 0; i < npcs.length; i++) {
      const a = npcs[i]!;
      if (world.req(a, Health).dead) continue;
      const ta = world.req(a, Transform);
      const va = world.req(a, Velocity);
      for (const o of world.query(Character, Transform, Health)) {
        if (o === a || world.req(o, Health).dead) continue;
        const to = world.req(o, Transform);
        const dx = ta.x - to.x;
        const dy = ta.y - to.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01 && d < 14) {
          va.x += (dx / d) * (14 - d) * 6;
          va.y += (dy / d) * (14 - d) * 6;
        }
      }
    }
  }

  // ---- helpers ---------------------------------------------------------------

  /** Husks: burnt-out minds that shamble at you firing, never hide, heal or run. */
  private husk(world: World, e: Entity): boolean {
    const id = world.get(e, Npc)?.templateId;
    return !!id && this.content.tryGet('npcTemplate', id)?.mind === 'husk';
  }

  private activeWeapon(world: World, e: Entity) {
    const c = world.req(e, Combatant);
    const item = c.active ? world.req(e, Equipment)[c.active] : undefined;
    const def = item && this.content.tryGet('weapon', item.defId);
    return item && def ? { item, def } : null;
  }

  private usable(world: World, e: Entity, def: WeaponDef, item: { loaded?: number }): boolean {
    if ((item.loaded ?? 0) > 0 || world.req(e, Combatant).infiniteAmmo) return true;
    const inv = world.req(e, Inventory);
    return def.ammo.some((a) => countItem(inv, a) > 0);
  }

  /** No non-hostile character standing in front of the muzzle, on the way to the target. */
  private lineOfFireClear(world: World, e: Entity, target: Entity): boolean {
    const t = world.req(e, Transform);
    const tt = world.req(target, Transform);
    const x0 = t.x;
    const y0 = t.y - CHEST_HEIGHT;
    const dx = tt.x - x0;
    const dy = tt.y - CHEST_HEIGHT - y0;
    const len = Math.hypot(dx, dy) || 1;
    for (const o of world.query(Health, Transform)) {
      if (o === e || o === target || world.req(o, Health).dead) continue;
      if (this.relations.hostile(world, e, o)) continue;
      const ot = world.req(o, Transform);
      const px = ot.x - x0;
      const py = ot.y - CHEST_HEIGHT - y0;
      const along = (px * dx + py * dy) / len;
      if (along < 0 || along > len) continue;
      const off = Math.abs(px * dy - py * dx) / len;
      if (off < 11) return false;
    }
    return true;
  }

  private squadNear(world: World, e: Entity): boolean {
    const camp = world.req(e, Npc).campId;
    const t = world.req(e, Transform);
    for (const m of world.query(Npc, Transform)) {
      if (m !== e && world.req(m, Npc).campId === camp && alive(world, m)) {
        const mt = world.req(m, Transform);
        if (Math.hypot(mt.x - t.x, mt.y - t.y) < 300) return true;
      }
    }
    return false;
  }

  private say(world: World, e: Entity, kind: BarkKind, cooldown = 5): void {
    const b = world.req(e, Brain);
    // Warnings always get shouted.
    if (b.barkCooldown > 0 && kind !== 'contact' && kind !== 'angry' && kind !== 'grenade' && kind !== 'grenadeOut') return;
    b.barkCooldown = cooldown + this.rand() * 3;
    this.bark(e, kind);
  }
}

// ---- free helpers ---------------------------------------------------------------

function alive(world: World, e: Entity): boolean {
  return world.isAlive(e) && !(world.get(e, Health)?.dead ?? true);
}

function dirOf(facing: string): Point {
  return facing === 'up' ? { x: 0, y: -1 } : facing === 'left' ? { x: -1, y: 0 } : facing === 'right' ? { x: 1, y: 0 } : { x: 0, y: 1 };
}

/** Fighting distance that suits the weapon. */
export function preferredRange(def: WeaponDef): number {
  return Math.max(70, Math.min(320, def.range * 0.45));
}

function walkable(map: TileMap, x: number, y: number): boolean {
  return !map.isSolid(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX)) && !map.isSolid(Math.floor(x / TILE_PX), Math.floor((y - 8) / TILE_PX));
}

/** A nearby walkable spot the threat can't see. */
export function hideSpot(map: TileMap, from: Point, threat: Point): Point | null {
  let best: Point | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const r = TILE_PX * (2 + (i % 4) * 1.5);
    const x = from.x + Math.cos(a) * r;
    const y = from.y + Math.sin(a) * r;
    if (!walkable(map, x, y)) continue;
    if (lineOfSight(map, threat.x, threat.y - CHEST_HEIGHT, x, y - CHEST_HEIGHT)) continue;
    const score = -r * 0.5 + Math.hypot(x - threat.x, y - threat.y) * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

function stepAway(map: TileMap, from: Point, threat: Point, dist: number): Point | null {
  const dx = from.x - threat.x;
  const dy = from.y - threat.y;
  const d = Math.hypot(dx, dy) || 1;
  for (const turn of [0, 0.5, -0.5, 1, -1]) {
    const a = Math.atan2(dy, dx) + turn;
    const x = from.x + Math.cos(a) * dist;
    const y = from.y + Math.sin(a) * dist;
    if (walkable(map, x, y)) return { x, y };
  }
  void d;
  return null;
}

/**
 * Somewhere clear of a blast of `radius` around `threat`, off known hazards:
 * straight away if possible, else the nearest way out. With `rand`, any of the
 * open spots (for a second try when the first had no route).
 */
function escapeFrom(map: TileMap, from: Point, threat: Point, radius: number, avoid?: Avoid, rand?: (() => number) | null): Point | null {
  const away = Math.atan2(from.y - threat.y, from.x - threat.x);
  const spots: Point[] = [];
  for (const extra of [56, 28]) {
    for (const turn of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.7, -1.7, 2.3, -2.3, Math.PI]) {
      const a = away + turn;
      // Measured from the grenade, so the spot really is out of reach.
      const x = threat.x + Math.cos(a) * (radius + extra);
      const y = threat.y + Math.sin(a) * (radius + extra);
      if (walkable(map, x, y) && !avoid?.(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX))) spots.push({ x, y });
    }
  }
  if (!spots.length) return stepAway(map, from, threat, radius);
  return rand ? spots[Math.floor(rand() * spots.length)]! : spots[0]!;
}

function strafe(map: TileMap, from: Point, ux: number, uy: number, amount: number): Point | null {
  const x = from.x - uy * amount;
  const y = from.y + ux * amount;
  if (walkable(map, x, y)) return { x, y };
  const x2 = from.x + uy * amount;
  const y2 = from.y - ux * amount;
  return walkable(map, x2, y2) ? { x: x2, y: y2 } : null;
}
