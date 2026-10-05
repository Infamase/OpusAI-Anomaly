import type { EventBus } from '../../core/EventBus';
import type { ContentRegistry } from '../../content/Registry';
import type { System, World } from '../../ecs/World';
import type { WeaponDef } from '../../content/types';
import type { ItemInstance, WeaponSlotId } from '../../save/types';
import { CHEST_HEIGHT, currentSpread, muzzlePosition, segmentHitsSolid, WEAPON_WEAR_PER_SHOT } from '../combat';
import type { CombatEvents } from '../combatEvents';
import { Aim, Combatant, Equipment, Faction, Health, Inventory, Projectile, Stats, Transform, Velocity } from '../components';
import { addItem, countItem, createItem, takeItem } from '../items';
import type { TileMap } from '../world/TileMap';

const SWITCH_TIME = 0.35;

/**
 * Turns combat intents into gunfire: fire modes, rate of fire, spread and bloom,
 * reloading from the inventory, and switching between primary and sidearm.
 */
export class WeaponSystem implements System {
  readonly name = 'weapons';

  constructor(
    private content: ContentRegistry,
    private map: () => TileMap | null,
    private events: EventBus<CombatEvents>,
  ) {}

  update(world: World, dt: number): void {
    for (const e of world.query(Combatant, Equipment, Transform, Aim)) {
      const c = world.req(e, Combatant);
      if (world.get(e, Health)?.dead) {
        c.trigger = c.triggerPrev = false;
        continue;
      }
      const eq = world.req(e, Equipment);
      // Cooldown may go slightly negative so the leftover carries into the next shot:
      // sustained fire then matches the weapon's rate exactly instead of rounding to whole ticks.
      c.cooldown -= dt;
      c.switchLeft = Math.max(0, c.switchLeft - dt);

      // --- Switching weapons cancels a reload in progress.
      if (c.wantSwitch) {
        const target = c.wantSwitch === 'next' ? this.otherSlot(eq, c.active) : c.wantSwitch;
        if (target && eq[target] && target !== c.active) {
          c.active = target;
          c.switchLeft = SWITCH_TIME;
          c.reloadLeft = 0;
          c.burstLeft = 0;
          this.events.emit('weaponSwitch', { shooter: e });
        }
        c.wantSwitch = null;
      }

      const item = c.active ? eq[c.active] : undefined;
      const def = item && this.content.tryGet('weapon', item.defId);
      if (!item || !def) {
        c.triggerPrev = c.trigger;
        continue;
      }
      c.bloom = Math.max(0, c.bloom - def.bloomRecovery * dt);
      const inv = world.get(e, Inventory) ?? [];

      // --- Reloading.
      if (c.reloadLeft > 0) {
        c.reloadLeft -= dt;
        if (c.reloadLeft <= 0) {
          c.reloadLeft = 0;
          if (this.finishReload(c, item, def, inv)) this.events.emit('reloadDone', { shooter: e });
        }
      } else if (c.wantReload) {
        this.startReload(e, c, item, def, inv);
      }
      c.wantReload = false;

      // --- Firing.
      const pressed = c.trigger && !c.triggerPrev;
      if (def.fireMode === 'burst' && pressed && c.burstLeft === 0) c.burstLeft = def.burstCount;
      const wantsShot = def.fireMode === 'auto' ? c.trigger : def.fireMode === 'semi' ? pressed : c.burstLeft > 0;
      let shot = false;
      if (wantsShot && c.cooldown <= 1e-9 && c.switchLeft <= 0 && c.reloadLeft <= 0) {
        if ((item.loaded ?? 0) <= 0) {
          c.burstLeft = 0;
          if (pressed) {
            this.events.emit('dryFire', { shooter: e });
            this.startReload(e, c, item, def, inv);
          }
        } else {
          this.fire(world, e, c, item, def);
          shot = true;
          if (c.burstLeft > 0) c.burstLeft--;
        }
      }
      if (!shot && c.cooldown < 0) c.cooldown = 0;
      c.triggerPrev = c.trigger;
    }
  }

  private otherSlot(eq: Partial<Record<WeaponSlotId, unknown>>, active: WeaponSlotId | null): WeaponSlotId | null {
    const order: WeaponSlotId[] = ['primary', 'sidearm'];
    const start = active ? order.indexOf(active) : -1;
    for (let i = 1; i <= order.length; i++) {
      const s = order[(start + i) % order.length]!;
      if (eq[s]) return s;
    }
    return null;
  }

  /** Ammo to load next: what's loaded now if any is left, else the first accepted type in the inventory. */
  private nextAmmo(c: Combatant, item: ItemInstance, ammoTypes: string[], inv: ItemInstance[]): string | null {
    if (c.infiniteAmmo) return item.loadedAmmo ?? ammoTypes[0]!;
    if (item.loadedAmmo && ammoTypes.includes(item.loadedAmmo) && countItem(inv, item.loadedAmmo) > 0) return item.loadedAmmo;
    return ammoTypes.find((a) => countItem(inv, a) > 0) ?? null;
  }

  private startReload(e: number, c: Combatant, item: ItemInstance, def: WeaponDef, inv: ItemInstance[]): void {
    if ((item.loaded ?? 0) >= def.magazine && item.loadedAmmo && def.ammo.includes(item.loadedAmmo)) return;
    if (!this.nextAmmo(c, item, def.ammo, inv)) return;
    c.reloadLeft = c.reloadTotal = def.reloadTime;
    c.burstLeft = 0;
    this.events.emit('reloadStart', { shooter: e, time: def.reloadTime });
  }

  private finishReload(c: Combatant, item: ItemInstance, def: WeaponDef, inv: ItemInstance[]): boolean {
    const ammo = this.nextAmmo(c, item, def.ammo, inv);
    if (!ammo) return false;
    // Switching ammo type: unload the old rounds back into the inventory first.
    if (item.loadedAmmo && item.loadedAmmo !== ammo && (item.loaded ?? 0) > 0) {
      if (!c.infiniteAmmo) addItem(this.content, inv, createItem(item.loadedAmmo, item.loaded!));
      item.loaded = 0;
    }
    const need = def.magazine - (item.loaded ?? 0);
    const got = c.infiniteAmmo ? need : takeItem(inv, ammo, need);
    item.loaded = (item.loaded ?? 0) + got;
    item.loadedAmmo = ammo;
    return true;
  }

  private fire(world: World, e: number, c: Combatant, item: ItemInstance, def: WeaponDef): void {
    const t = world.req(e, Transform);
    const dir = world.req(e, Aim).dir;
    if (!dir) return;
    const angle = Math.atan2(dir.y, dir.x);
    const ammo = this.content.tryGet('ammo', item.loadedAmmo ?? def.ammo[0]!);
    const vel = world.get(e, Velocity);
    const speed = world.get(e, Stats)?.get('move_speed') ?? 80;
    const moving = vel ? Math.hypot(vel.x, vel.y) / Math.max(1, speed) : 0;
    const spread = (currentSpread(def, item, c.bloom, moving) * Math.PI) / 180;

    // Spawn at the muzzle, unless the barrel pokes through a wall (then the bullet starts at the chest).
    const map = this.map();
    let origin = muzzlePosition(def, t.x, t.y, angle);
    if (map && segmentHitsSolid(map, t.x, t.y - CHEST_HEIGHT, origin.x, origin.y) !== null) origin = { x: t.x, y: t.y - CHEST_HEIGHT };

    const faction = world.get(e, Faction)?.id ?? 'none';
    for (let i = 0; i < def.pellets; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const p = world.create();
      world.add(p, Transform, { x: origin.x, y: origin.y, prevX: origin.x, prevY: origin.y });
      world.add(p, Projectile, {
        owner: e,
        faction,
        damage: def.damage * (ammo?.damageMult ?? 1),
        ap: Math.max(0, def.armorPiercing + (ammo?.apBonus ?? 0)),
        type: def.damageType,
        vx: Math.cos(a) * def.projectileSpeed,
        vy: Math.sin(a) * def.projectileSpeed,
        travelled: 0,
        range: def.range,
      });
    }
    item.loaded = (item.loaded ?? 0) - 1;
    item.condition = Math.max(0, item.condition - WEAPON_WEAR_PER_SHOT);
    c.cooldown = Math.max(c.cooldown, -1 / 60) + 60 / def.fireRate;
    c.bloom = Math.min(def.bloomMax, c.bloom + def.bloomPerShot);
    this.events.emit('shot', { shooter: e, x: origin.x, y: origin.y, angle, weaponId: def.id, recoil: def.recoil });
  }
}
