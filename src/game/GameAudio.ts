import type { AudioEngine } from '../audio/AudioEngine';
import type { AnomalyDef } from '../content/types/anomaly';
import { decayRate } from './radiation';
import type { ContentRegistry } from '../content/Registry';
import type { EventBus } from '../core/EventBus';
import type { Entity, World } from '../ecs/World';
import type { CombatEvents } from './combatEvents';
import { Character, Combatant, Equipment, Faction, Transform } from './components';
import { TILE_PX, type TileMap } from './world/TileMap';

/** The sound for using a consumable: its own, or the use_item cue. */
export function playUseSound(audio: AudioEngine, content: ContentRegistry, defId: string): void {
  audio.play(content.tryGet('consumable', defId)?.sounds?.use, {}, 'use_item');
}

/** A pain sound plays for roughly this share of non-lethal hits (every hit would be a wall of grunts). */
const HURT_CHANCE = 0.45;

/**
 * Turns gameplay happenings into sounds. Picks the most specific sound content
 * offers (this weapon's shot, this ground's footstep, this race's pain) and
 * falls back to the engine cue.
 */
export class GameAudio {
  private heartbeatIn = 0;
  private idleIn = new Map<string, number>();
  private lastRads = 0;
  private radRate = 0;

  constructor(
    private audio: AudioEngine,
    private content: ContentRegistry,
    private world: World,
    private map: () => TileMap | null,
    private player: () => Entity,
  ) {}

  listen(events: EventBus<CombatEvents>): void {
    const a = this.audio;
    events.on('shot', (s) => a.play(this.weapon(s.weaponId)?.sounds?.shot, { x: s.x, y: s.y, volume: s.shooter === this.player() ? 1.1 : 1 }, 'shot'));
    events.on('dryFire', (d) => a.play(this.activeWeapon(d.shooter)?.sounds?.dry, this.at(d.shooter), 'dry_fire'));
    events.on('reloadStart', (r) => a.play(this.activeWeapon(r.shooter)?.sounds?.reload, this.at(r.shooter), 'reload'));
    events.on('reloadDone', (r) => a.play(this.activeWeapon(r.shooter)?.sounds?.reloadDone, this.at(r.shooter), 'reload_done'));
    events.on('weaponSwitch', (w) => a.play(this.activeWeapon(w.shooter)?.sounds?.equip, this.at(w.shooter), 'weapon_switch'));
    events.on('impact', (i) => {
      // The bullet stopped at a tile edge: look just past it for what it struck.
      const tile = this.tileAt(i.x + Math.cos(i.angle) * 3, i.y + Math.sin(i.angle) * 3);
      a.play(tile?.sounds?.impact, { x: i.x, y: i.y }, 'impact');
    });
    events.on('hit', (h) => {
      const pos = { x: h.x, y: h.y };
      // Mostly stopped by armor: a dull clank instead of a wet thud.
      a.play(undefined, pos, h.blocked > h.dealt ? 'hit_armor' : 'hit_flesh');
      if (!h.killed && h.dealt > 0 && (h.target === this.player() || Math.random() < HURT_CHANCE)) {
        a.play(this.race(h.target)?.sounds?.hurt, this.at(h.target), 'hit_flesh');
      }
      if (h.attacker === this.player() && h.target !== this.player()) a.playCue(h.killed ? 'kill_marker' : 'hit_marker');
    });
    events.on('death', (d) => {
      a.play(this.race(d.entity)?.sounds?.death, this.at(d.entity), 'death');
      if (d.entity === this.player()) a.playCue('player_death');
    });
    events.on('anomaly', (an) => {
      if (an.phase === 'burst') a.play(this.content.tryGet('anomaly', an.defId)?.sounds?.trigger, { x: an.x, y: an.y }, 'anomaly_burst');
    });
    events.on('boltThrown', (b) => a.playCue('bolt_throw', { x: b.x, y: b.y }));
    events.on('boltLanded', (b) => a.playCue('bolt_land', { x: b.x, y: b.y }));
    events.on('door', (d) => {
      const s = this.content.tryGet('tile', d.tile)?.sounds;
      const at = { x: d.x, y: d.y };
      if (d.result === 'opened') a.play(s?.open, at, 'door_open');
      else if (d.result === 'closed') a.play(s?.close, at, 'door_close');
      else if (d.result === 'locked') a.play(s?.locked, at, 'door_locked');
      else if (d.result === 'unlocked') {
        a.playCue('door_unlock');
        a.play(s?.open, at, 'door_open');
      }
    });
    const ex = (id: string) => this.content.tryGet('explosive', id)?.sounds;
    events.on('grenadeThrown', (g) => a.play(ex(g.defId)?.throw, { x: g.x, y: g.y }, 'grenade_throw'));
    events.on('grenadeBounce', (g) => a.playCue('grenade_bounce', { x: g.x, y: g.y }));
    events.on('explosive', (e) => a.play(e.phase === 'armed' ? ex(e.defId)?.arm : ex(e.defId)?.trigger, { x: e.x, y: e.y }, e.phase === 'armed' ? 'explosive_arm' : 'explosive_trigger'));
    events.on('explosion', (e) => a.play(ex(e.defId)?.explode, { x: e.x, y: e.y }, 'explosion'));
    events.on('broken', (b) => a.play(b.tile ? this.content.tryGet('tile', b.tile)?.sounds?.break : undefined, { x: b.x, y: b.y }, 'break'));
  }

  /** Idle hum, crackle and bubbling of anomalies near the player, each on its own rhythm. */
  anomalies(dt: number, near: Iterable<{ x: number; y: number; def: AnomalyDef }>): void {
    for (const n of near) {
      const id = n.def.sounds?.idle;
      if (!id) continue;
      const key = `${Math.round(n.x)},${Math.round(n.y)}`;
      const left = (this.idleIn.get(key) ?? Math.random()) - dt;
      if (left > 0) {
        this.idleIn.set(key, left);
        continue;
      }
      this.idleIn.set(key, 1.2 + Math.random() * 1.5);
      this.audio.play(id, { x: n.x, y: n.y });
    }
    if (this.idleIn.size > 400) this.idleIn.clear();
  }

  /** A foot came down. */
  footstep(e: Entity, x: number, y: number, sprinting: boolean): void {
    const tile = this.tileAt(x, y);
    this.audio.play(tile?.sounds?.step, { x, y, volume: (sprinting ? 1.35 : 1) * (e === this.player() ? 1 : 0.9) }, 'footstep');
  }

  /** An NPC shouted something. */
  bark(e: Entity): void {
    const faction = this.content.tryGet('faction', this.world.get(e, Faction)?.id ?? '');
    this.audio.play(faction?.sounds?.bark, this.at(e), 'bark');
  }

  /** Low-health heartbeat, quicker the closer to death. */
  update(dt: number, hpFrac: number, alive: boolean, rads = 0): void {
    this.geiger(dt, alive ? rads : 0);
    if (!alive || hpFrac >= 0.3) {
      this.heartbeatIn = 0;
      return;
    }
    this.heartbeatIn -= dt;
    if (this.heartbeatIn <= 0) {
      this.audio.playCue('heartbeat', { volume: 0.6 + (0.3 - hpFrac) * 2 });
      this.heartbeatIn = 0.55 + hpFrac * 2;
    }
  }

  /**
   * Geiger counter: clicks at a rate that follows how fast the player is
   * taking in radiation (the dose rising), from a few a second to a buzz.
   */
  private geiger(dt: number, rads: number): void {
    if (dt <= 0) return;
    // Intake = change in dose + what the body cleared meanwhile; a small floor ignores the trickle from artifacts.
    const rising = Math.max(0, (rads - this.lastRads) / dt + decayRate(rads) - 2);
    this.lastRads = rads;
    this.radRate += (rising - this.radRate) * Math.min(1, dt * 3);
    if (this.radRate < 0.3) return;
    const clicksPerSec = Math.min(30, this.radRate * 1.2);
    let n = clicksPerSec * dt;
    while (n > 0) {
      if (Math.random() < Math.min(1, n)) this.audio.playCue('geiger', { volume: 0.6 + Math.random() * 0.4 });
      n -= 1;
    }
  }

  private at(e: Entity): { x?: number; y?: number } {
    const t = this.world.get(e, Transform);
    return t ? { x: t.x, y: t.y } : {};
  }

  private weapon(id: string) {
    return this.content.tryGet('weapon', id);
  }

  private activeWeapon(e: Entity) {
    const c = this.world.get(e, Combatant);
    const item = c?.active ? this.world.get(e, Equipment)?.[c.active] : undefined;
    return item ? this.weapon(item.defId) : undefined;
  }

  private race(e: Entity) {
    const id = this.world.get(e, Character)?.raceId;
    return id ? this.content.tryGet('race', id) : undefined;
  }

  private tileAt(x: number, y: number) {
    const map = this.map();
    return map ? map.tiles.defs[map.getTile(Math.floor(x / TILE_PX), Math.floor(y / TILE_PX))] : undefined;
  }
}
