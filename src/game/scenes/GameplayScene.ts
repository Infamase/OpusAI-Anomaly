import { EventBus } from '../../core/EventBus';
import type { Game } from '../../core/Game';
import { GAME_VERSION } from '../../core/Game';
import { directionVector, lerp } from '../../core/math';
import { Rng } from '../../core/rng';
import type { Scene } from '../../core/Scene';
import { World, type Entity } from '../../ecs/World';
import type { CharacterView } from '../../render/CharacterView';
import { CombatFx } from '../../render/CombatFx';
import { Crosshair } from '../../render/Crosshair';
import type { ChannelColors } from '../../render/palette';
import { TileAtlas, TilemapRenderer } from '../../render/TilemapRenderer';
import { SaveManager } from '../../save/SaveManager';
import type { EquipmentSave } from '../../save/types';
import type { WorldDeltas } from '../../save/WorldDeltas';
import { DevTools, type DevHooks } from '../../ui/DevTools';
import { Hud, type HudState } from '../../ui/Hud';
import { addCombatComponents, prepareCharacterArt, resolveColors, setCharacterAppearance, spawnCharacter } from '../characters';
import { CHEST_HEIGHT, currentSpread } from '../combat';
import type { CombatEvents } from '../combatEvents';
import {
  Aim,
  Character,
  Combatant,
  Equipment,
  Health,
  Inventory,
  PlayerControlled,
  Projectile,
  ShooterAI,
  Stamina,
  Stats,
  Transform,
  Velocity,
  View,
} from '../components';
import {
  ARMOR_SLOTS,
  createItem,
  defaultActiveWeapon,
  equipArmor,
  prepareArmorArt,
  startingEquipment,
  startingInventory,
  unequipArmor,
  type ArmorSlot,
} from '../equipment';
import { addItem, countItem, createLoadedWeapon } from '../items';
import { generateStalker } from '../npcs';
import { AnimationSystem } from '../systems/AnimationSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { PlayerControlSystem } from '../systems/PlayerControlSystem';
import { ProjectileSystem } from '../systems/ProjectileSystem';
import { ShooterAISystem } from '../systems/ShooterAISystem';
import { VitalsSystem } from '../systems/VitalsSystem';
import { WeaponSystem } from '../systems/WeaponSystem';
import { getGenerator } from '../world/generators';
import { TILE_PX, TileMap } from '../world/TileMap';
import { TileSet } from '../world/TileSet';
import '../world/testRangeGenerator';
import { DeathScene } from './DeathScene';
import { PauseScene } from './PauseScene';

/** Where new characters start. Becomes the real starting location once planets exist. */
export const START_WORLD_ID = 'test_range';
const WORLD_ID = START_WORLD_ID;
const AUTOSAVE_SEC = 30;
const BUILD_WALL = 'metal_wall';
const BUILD_FLOOR = 'dirt';
/** Test bandits spawned on arrival (temporary until Module 10 populates the world). */
const BANDITS_ON_ENTER = 3;

export interface NewCharacter {
  name: string;
  raceId: string;
  colors: ChannelColors;
}

/** Creates a fresh save slot for a new character (with its race's starting kit) and starts playing it. */
export async function startNewGame(game: Game, who: NewCharacter): Promise<void> {
  const slotId = SaveManager.newSlotId();
  const race = game.content.get('race', who.raceId);
  const equipment = startingEquipment(game.content, race.id);
  game.saves.newGame({
    slotId,
    name: who.name,
    gameVersion: GAME_VERSION,
    contentPacks: game.contentReport.packs.map((p) => ({ id: p.id, version: p.version })),
    player: {
      name: who.name,
      raceId: race.id,
      colors: resolveColors(race, who.colors),
      worldId: START_WORLD_ID,
      x: NaN,
      y: NaN,
      facing: 'down',
      equipment,
      inventory: startingInventory(game.content, race.id),
      activeWeapon: defaultActiveWeapon(equipment),
    },
  });
  await game.saves.save();
  await game.scenes.change(new GameplayScene(game, slotId));
}

/**
 * In-world play: a character on a generated, chunk-streamed map, with combat
 * against test bandits. Everything persists through "seed + changes" saves.
 * The world is still the Phase 0 test range until planets (Phase 2) exist.
 */
export class GameplayScene implements Scene, DevHooks {
  readonly id = 'gameplay';
  buildMode = false;

  private world = new World();
  private combatEvents = new EventBus<CombatEvents>();
  private map: TileMap | null = null;
  private tileRenderer: TilemapRenderer | null = null;
  private deltas: WorldDeltas | null = null;
  private playerEntity: Entity = 0;
  private dev: DevTools | null = null;
  private hud: Hud | null = null;
  private fx = new CombatFx();
  private crosshair = new Crosshair();
  /** Which weapon each character view currently shows, to know when to swap textures. */
  private shownWeapon = new Map<Entity, string | null>();
  private sinceSave = 0;
  private playTime = 0;
  private offEvents: (() => void)[] = [];
  private banditRng = new Rng(Date.now() >>> 0);
  /** Set once enter() completes; exit() only saves a fully loaded scene. */
  private ready = false;

  constructor(
    private game: Game,
    readonly slotId: string,
  ) {}

  /** True once the world and player exist (enter() is async; the loop may tick before it finishes). */
  get isReady(): boolean {
    return this.ready;
  }

  async enter(): Promise<void> {
    const g = this.game;
    if (!(await g.saves.load(this.slotId))) throw new Error(`Save "${this.slotId}" not found`);
    const save = g.saves.data;
    if (!g.content.has('race', save.player.raceId)) save.player.raceId = 'human'; // race removed from content
    g.setGameplayInput(true);

    // --- World: regenerate from seed, then layer saved changes on top.
    const genDef = g.content.get('worldGen', WORLD_ID);
    const generator = getGenerator(genDef.generator);
    const record = g.saves.ensureWorld(WORLD_ID, genDef.id, newSeed(), generator.version);
    this.deltas = await g.saves.enterWorld(WORLD_ID);
    const tiles = new TileSet(g.content.all('tile'));
    const params = generator.parseParams(genDef.params, tiles);
    this.map = new TileMap({
      tiles,
      generator,
      params,
      seed: record.seed,
      widthChunks: genDef.widthChunks,
      heightChunks: genDef.heightChunks,
      deltas: this.deltas,
    });
    this.tileRenderer = new TilemapRenderer(g.renderer.ground, this.map, new TileAtlas(tiles));
    g.renderer.overlay.addChild(this.fx.layer);
    g.renderer.screen.addChild(this.crosshair.g);

    // --- ECS: systems run in this order every tick.
    const map = () => this.map;
    this.world
      .addSystem(new PlayerControlSystem(g.input, g.camera, () => g.renderer.pixelRatio))
      .addSystem(new ShooterAISystem(g.content, map))
      .addSystem(new WeaponSystem(g.content, map, this.combatEvents))
      .addSystem(new MovementSystem(map))
      .addSystem(new ProjectileSystem(g.content, map, this.combatEvents))
      .addSystem(new VitalsSystem(this.combatEvents))
      .addSystem(new AnimationSystem());
    this.world.onDestroy = (e) => {
      this.world.get(e, View)?.destroy();
      this.shownWeapon.delete(e);
    };
    this.listenToCombat();

    // --- Art: every weapon is tiny, so prepare them all up front.
    await Promise.all(g.content.all('weapon').map((w) => g.weaponArt.prepare(w)));

    // --- Player.
    await prepareCharacterArt(g.content, g.sheets, save.player.raceId, save.player.equipment);
    let { x, y } = save.player;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const spawn = generator.spawnPoint(record.seed, params, this.map.widthTiles, this.map.heightTiles);
      x = (spawn.x + 0.5) * TILE_PX;
      y = (spawn.y + 0.5) * TILE_PX;
    }
    this.playerEntity = spawnCharacter(this.world, g.content, g.sheets, {
      raceId: save.player.raceId,
      colors: save.player.colors,
      equipment: save.player.equipment,
      x,
      y,
      facing: save.player.facing,
    });
    this.world.add(this.playerEntity, PlayerControlled, true);
    addCombatComponents(this.world, this.playerEntity, {
      faction: 'player',
      active: save.player.activeWeapon,
      inventory: save.player.inventory,
      hp: save.player.health,
    });
    g.renderer.entities.addChild(this.world.req(this.playerEntity, View).root);
    g.camera.snapTo({ x, y: y - CHEST_HEIGHT });

    for (let i = 0; i < BANDITS_ON_ENTER; i++) await this.spawnBandit();

    this.hud = new Hud(g.root);
    this.dev = new DevTools(g, this);
    this.offEvents.push(
      g.events.on('app:hidden', () => {
        void this.save();
        if (g.scenes.current === this) this.openPauseMenu();
      }),
    );
    this.ready = true;
    await this.save();
  }

  async exit(): Promise<void> {
    if (this.ready) await this.save();
    this.ready = false;
    this.game.setGameplayInput(false);
    this.game.renderer.canvas.classList.remove('aiming');
    for (const off of this.offEvents) off();
    this.combatEvents.clear();
    this.dev?.destroy();
    this.hud?.destroy();
    this.tileRenderer?.destroy();
    this.fx.destroy();
    this.crosshair.g.destroy();
    for (const e of this.world.query(View)) this.world.destroy(e);
    for (const e of this.world.query(Projectile)) this.world.destroy(e);
    this.world.flushDestroyed();
  }

  update(dt: number): void {
    if (!this.ready) return;
    const input = this.game.input;
    if (this.game.scenes.current === this && input.justPressed('pause')) {
      this.openPauseMenu();
      return;
    }
    this.world.update(dt);
    if (this.buildMode && input.justPressed('interact')) this.toggleTileInFront();

    this.playTime += dt;
    this.sinceSave += dt;
    if (this.sinceSave >= AUTOSAVE_SEC) void this.save();
  }

  render(alpha: number, frameDt: number): void {
    if (!this.ready) return;
    const g = this.game;
    let px = 0;
    let py = 0;
    const bars: { x: number; y: number; frac: number }[] = [];
    for (const e of this.world.query(Transform, View, Character)) {
      const t = this.world.req(e, Transform);
      const ch = this.world.req(e, Character);
      const view = this.world.req(e, View);
      const x = lerp(t.prevX, t.x, alpha);
      const y = lerp(t.prevY, t.y, alpha);
      view.setPosition(x, y);
      view.tick(frameDt);
      const layout = g.content.get('spriteLayout', g.content.get('race', ch.raceId).spriteLayout);
      const anim = layout.animations.find((a) => a.id === ch.anim) ?? layout.animations[0]!;
      view.setFrame(anim.id, ch.facing, Math.floor(ch.animTime * anim.fps));
      this.syncWeaponView(e, view, ch.facing);
      const h = this.world.get(e, Health);
      if (e === this.playerEntity) {
        px = x;
        py = y;
      } else if (h && !h.dead && h.sinceHit < 4) {
        bars.push({ x, y, frac: h.hp / (this.world.get(e, Stats)?.get('max_health') ?? 100) });
      }
    }

    // Camera leads slightly toward the aim direction, Stalker-style.
    const aim = this.world.get(this.playerEntity, Aim)?.dir;
    g.camera.follow({ x: px, y: py - CHEST_HEIGHT }, aim ? { x: aim.x * 28, y: aim.y * 20 } : { x: 0, y: 0 });
    g.camera.update(frameDt);
    g.camera.apply(g.renderer.world);
    this.tileRenderer?.update(g.camera.bounds);

    const tracers: { x: number; y: number; vx: number; vy: number }[] = [];
    for (const p of this.world.query(Projectile, Transform)) {
      const t = this.world.req(p, Transform);
      const pr = this.world.req(p, Projectile);
      tracers.push({ x: lerp(t.prevX, t.x, alpha), y: lerp(t.prevY, t.y, alpha), vx: pr.vx, vy: pr.vy });
    }
    this.fx.render(frameDt, tracers, bars);
    this.renderCrosshair(frameDt, px, py);
    this.hud?.update(this.hudState(), frameDt);
    this.dev?.update(performance.now());
  }

  // ---- combat wiring ----------------------------------------------------------

  private listenToCombat(): void {
    const ev = this.combatEvents;
    const cam = this.game.camera;
    ev.on('shot', (s) => {
      this.fx.muzzle(s.x, s.y, s.angle);
      if (s.shooter === this.playerEntity) cam.kick(-Math.cos(s.angle) * s.recoil, -Math.sin(s.angle) * s.recoil);
    });
    ev.on('impact', (i) => this.fx.sparks(i.x, i.y, i.angle));
    ev.on('hit', (h) => {
      this.fx.blood(h.x, h.y, h.angle, h.dealt);
      this.world.get(h.target, View)?.flash();
      if (h.attacker === this.playerEntity) this.crosshair.hit(h.killed);
      if (h.target === this.playerEntity) {
        this.hud?.damage(h.dealt);
        cam.kick(Math.cos(h.angle) * 2, Math.sin(h.angle) * 2);
      }
    });
    ev.on('death', (d) => {
      this.world.get(d.entity, View)?.setDead(true);
      if (d.entity === this.playerEntity) this.onPlayerDeath(d.killer);
    });
  }

  private onPlayerDeath(killer: Entity | null): void {
    const g = this.game;
    const by = killer !== null ? this.world.get(killer, Equipment) : undefined;
    const weaponId = killer !== null ? by?.[this.world.get(killer, Combatant)?.active ?? 'primary']?.defId : undefined;
    const cause =
      killer === null ? 'You bled out.' : `Killed by a bandit${weaponId ? ` with a ${g.content.tryGet('weapon', weaponId)?.name}` : ''}.`;
    // No save here: dying sends you back to your last save.
    void g.scenes.push(new DeathScene(g, cause, () => g.scenes.change(new GameplayScene(g, this.slotId))));
  }

  /** Swaps the held-weapon texture when the active weapon changes, and points it along the aim. */
  private syncWeaponView(e: Entity, view: CharacterView, facing: string): void {
    const c = this.world.get(e, Combatant);
    const item = c?.active ? this.world.get(e, Equipment)?.[c.active] : undefined;
    const id = item?.defId ?? null;
    if (this.shownWeapon.get(e) !== id) {
      this.shownWeapon.set(e, id);
      const art = id ? this.game.weaponArt.get(id) : undefined;
      view.setWeapon(art?.texture ?? null, art?.grip);
    }
    const dir = this.world.get(e, Aim)?.dir ?? directionVector(facing as 'down');
    const sprinting = this.world.get(e, Character)?.sprinting;
    // While sprinting the gun is lowered toward the ground.
    view.setAim(sprinting ? Math.PI / 2 - Math.sign(dir.x || 1) * 0.6 : Math.atan2(dir.y, dir.x), facing);
  }

  private renderCrosshair(dt: number, px: number, py: number): void {
    const g = this.game;
    const canvas = g.renderer.canvas;
    const active = g.scenes.current === this && g.input.enabled;
    canvas.classList.toggle('aiming', active && g.input.device === 'keyboardMouse');
    const zoom = g.camera.zoom;
    let sx: number | null = null;
    let sy = 0;
    let worldDist = 90;
    const a = g.input.aim;
    if (active && a.kind === 'point') {
      sx = a.screen.x * g.renderer.pixelRatio;
      sy = a.screen.y * g.renderer.pixelRatio;
      const w = g.camera.screenToWorld(sx, sy);
      worldDist = Math.hypot(w.x - px, w.y - (py - CHEST_HEIGHT));
    } else if (active && a.kind === 'direction') {
      const s = g.camera.worldToScreen(px + a.dir.x * 90, py - CHEST_HEIGHT + a.dir.y * 90);
      sx = s.x;
      sy = s.y;
    }
    const c = this.world.get(this.playerEntity, Combatant);
    const item = c?.active ? this.world.get(this.playerEntity, Equipment)?.[c.active] : undefined;
    const def = item && g.content.tryGet('weapon', item.defId);
    let gap = 3 * zoom;
    if (def && item && c) {
      const v = this.world.req(this.playerEntity, Velocity);
      const moving = Math.hypot(v.x, v.y) / Math.max(1, this.world.req(this.playerEntity, Stats).get('move_speed'));
      const spread = (currentSpread(def, item, c.bloom, moving) * Math.PI) / 180;
      gap = Math.tan(spread / 2) * worldDist * zoom;
    }
    const dead = this.world.get(this.playerEntity, Health)?.dead;
    this.crosshair.render(dt, dead ? null : sx, sy, gap, zoom, (c?.reloadLeft ?? 0) > 0);
  }

  private hudState(): HudState {
    const g = this.game;
    const e = this.playerEntity;
    const h = this.world.req(e, Health);
    const stats = this.world.req(e, Stats);
    const st = this.world.req(e, Stamina);
    const c = this.world.req(e, Combatant);
    const eq = this.world.req(e, Equipment);
    const inv = this.world.req(e, Inventory);
    const item = c.active ? eq[c.active] : undefined;
    const def = item && g.content.tryGet('weapon', item.defId);
    const ammoId = item?.loadedAmmo ?? def?.ammo[0];
    return {
      hp: h.hp,
      maxHp: stats.get('max_health'),
      bleed: h.bleed,
      stamina: st.current,
      maxStamina: stats.get('max_stamina'),
      exhausted: st.exhausted,
      weapon:
        def && item && c.active
          ? {
              name: def.name,
              slot: c.active,
              loaded: item.loaded ?? 0,
              magazine: def.magazine,
              reserve: def.ammo.reduce((n, a) => n + countItem(inv, a), 0),
              caliber: (ammoId && g.content.tryGet('ammo', ammoId)?.caliber) || '—',
              fireMode: def.fireMode,
              condition: item.condition,
              reload: c.reloadLeft > 0 ? 1 - c.reloadLeft / c.reloadTotal : null,
            }
          : null,
      armor: ARMOR_SLOTS.flatMap((slot) => {
        const it = eq[slot];
        const d = it && g.content.tryGet('armor', it.defId);
        return it && d ? [{ slot, name: d.name, condition: it.condition }] : [];
      }),
    };
  }

  /** Spawns a hostile test Stalker somewhere 9–20 tiles from the player. */
  async spawnBandit(): Promise<void> {
    const g = this.game;
    const map = this.map;
    if (!map) return;
    const look = generateStalker(g.content, this.banditRng);
    await prepareCharacterArt(g.content, g.sheets, look.raceId, look.equipment);
    const pt = this.world.req(this.playerEntity, Transform);
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = this.banditRng.range(0, Math.PI * 2);
      const dist = this.banditRng.range(9, 20) * TILE_PX;
      const x = pt.x + Math.cos(ang) * dist;
      const y = pt.y + Math.sin(ang) * dist;
      const tx = Math.floor(x / TILE_PX);
      const ty = Math.floor(y / TILE_PX);
      if (map.isSolid(tx, ty) || map.isSolid(tx, ty - 1)) continue;
      const e = spawnCharacter(this.world, g.content, g.sheets, { ...look, x, y, facing: 'down' });
      addCombatComponents(this.world, e, { faction: 'bandit', infiniteAmmo: true });
      this.world.add(e, ShooterAI, {
        target: null,
        lastSeenX: x,
        lastSeenY: y,
        sinceSeen: 99,
        scanTimer: this.banditRng.range(0, 0.25),
        reaction: 0,
        burstTimer: 0,
        firing: false,
        strafeDir: 1,
        strafeTimer: 0,
        homeX: x,
        homeY: y,
      });
      g.renderer.entities.addChild(this.world.req(e, View).root);
      return;
    }
  }

  // ---- DevHooks -------------------------------------------------------------

  player(): ReturnType<DevHooks['player']> {
    if (!this.world.isAlive(this.playerEntity)) return null;
    const ch = this.world.req(this.playerEntity, Character);
    const t = this.world.req(this.playerEntity, Transform);
    return {
      raceId: ch.raceId,
      colors: ch.colors,
      stats: this.world.req(this.playerEntity, Stats).all(),
      tile: { x: Math.floor(t.x / TILE_PX), y: Math.floor(t.y / TILE_PX) },
    };
  }

  async setAppearance(raceId: string, colors: ChannelColors): Promise<string[]> {
    const g = this.game;
    await prepareCharacterArt(g.content, g.sheets, raceId, this.world.req(this.playerEntity, Equipment));
    const removed = setCharacterAppearance(this.world, g.content, g.sheets, this.playerEntity, raceId, colors);
    // Armor that no longer fits goes into the backpack.
    const inv = this.world.req(this.playerEntity, Inventory);
    for (const item of removed) addItem(g.content, inv, item);
    this.syncPlayerSave();
    return removed.map((item) => g.content.tryGet('armor', item.defId)?.name ?? item.defId);
  }

  equipment(): EquipmentSave {
    return this.world.req(this.playerEntity, Equipment);
  }

  async equip(slot: ArmorSlot, armorId: string | null): Promise<string | null> {
    const g = this.game;
    if (!armorId) {
      unequipArmor(this.world, g.content, g.sheets, this.playerEntity, slot);
    } else {
      await prepareArmorArt(g.content, g.sheets, armorId);
      const result = equipArmor(this.world, g.content, g.sheets, this.playerEntity, createItem(armorId));
      if (!result.ok) return result.reason;
    }
    this.syncPlayerSave();
    return null;
  }

  /** Dev: the race's starting kit again (armor, loaded weapons, ammo). */
  async resetGear(): Promise<void> {
    const g = this.game;
    const e = this.playerEntity;
    const raceId = this.world.req(e, Character).raceId;
    const kit = startingEquipment(g.content, raceId);
    for (const slot of ARMOR_SLOTS) await this.equip(slot, kit[slot]?.defId ?? null);
    const eq = this.world.req(e, Equipment);
    eq.primary = kit.primary;
    eq.sidearm = kit.sidearm;
    if (!eq.primary) delete eq.primary;
    if (!eq.sidearm) delete eq.sidearm;
    this.world.req(e, Combatant).active = defaultActiveWeapon(eq);
    const inv = this.world.req(e, Inventory);
    for (const it of startingInventory(g.content, raceId)) addItem(g.content, inv, it);
    this.syncPlayerSave();
  }

  listWeapons(): { id: string; name: string; slot: string }[] {
    return this.game.content.all('weapon').map((w) => ({ id: w.id, name: w.name, slot: w.slot }));
  }

  /** Dev: hand the player any weapon, loaded, plus 3 magazines of its ammo. */
  giveWeapon(id: string): void {
    const g = this.game;
    const def = g.content.get('weapon', id);
    const eq = this.world.req(this.playerEntity, Equipment);
    eq[def.slot] = createLoadedWeapon(g.content, id);
    const c = this.world.req(this.playerEntity, Combatant);
    c.active = def.slot;
    c.reloadLeft = 0;
    addItem(g.content, this.world.req(this.playerEntity, Inventory), createItem(def.ammo[0]!, def.magazine * 3));
    this.syncPlayerSave();
  }

  get godMode(): boolean {
    return !!this.world.get(this.playerEntity, Health)?.god;
  }

  set godMode(on: boolean) {
    const h = this.world.get(this.playerEntity, Health);
    if (h) h.god = on;
  }

  heal(): void {
    const h = this.world.req(this.playerEntity, Health);
    if (h.dead) return;
    h.hp = this.world.req(this.playerEntity, Stats).get('max_health');
    h.bleed = 0;
  }

  clearBandits(): void {
    for (const e of this.world.query(ShooterAI)) this.world.destroy(e);
  }

  async saveNow(): Promise<void> {
    await this.save(true);
  }

  /** Dev: throws away this world's seed and edits, then re-enters a freshly generated one. */
  async newWorld(): Promise<void> {
    const g = this.game;
    this.world.req(this.playerEntity, Transform).x = NaN; // respawn at the new world's spawn point
    this.syncPlayerSave();
    await g.saves.resetWorld(WORLD_ID);
    await g.scenes.change(new GameplayScene(g, this.slotId));
  }

  info(): Record<string, string | number> {
    const p = this.player();
    let bandits = 0;
    for (const e of this.world.query(ShooterAI)) if (!this.world.get(e, Health)?.dead) bandits++;
    return {
      Seed: this.map?.seed ?? '—',
      Tile: p ? `${p.tile.x}, ${p.tile.y}` : '—',
      'Chunks (data/drawn)': `${this.map?.loadedChunkCount ?? 0} / ${this.tileRenderer?.viewCount ?? 0}`,
      'Changed chunks': this.deltas?.changedChunkCount ?? 0,
      Entities: this.world.entityCount,
      'Bandits alive': bandits,
      Sheets: this.game.sheets.cachedCount,
    };
  }

  // ---- internals ------------------------------------------------------------

  private openPauseMenu(): void {
    const g = this.game;
    if (this.world.get(this.playerEntity, Health)?.dead) return;
    void g.scenes.push(new PauseScene(g, () => g.goToMainMenu()));
  }

  /** Copies the live player entity into the save data. */
  private syncPlayerSave(): void {
    const g = this.game;
    const e = this.playerEntity;
    if (!g.saves.isLoaded || !this.world.isAlive(e)) return;
    const t = this.world.req(e, Transform);
    const ch = this.world.req(e, Character);
    Object.assign(g.saves.data.player, {
      x: t.x,
      y: t.y,
      facing: ch.facing,
      raceId: ch.raceId,
      colors: ch.colors,
      equipment: structuredClone(this.world.req(e, Equipment)),
      inventory: structuredClone(this.world.req(e, Inventory)),
      activeWeapon: this.world.req(e, Combatant).active,
      health: this.world.req(e, Health).hp,
    });
  }

  private toggleTileInFront(): void {
    const map = this.map;
    if (!map) return;
    const t = this.world.req(this.playerEntity, Transform);
    const ch = this.world.req(this.playerEntity, Character);
    const d = directionVector(ch.facing);
    // Target the tile one step ahead of the character's body.
    const tx = Math.floor((t.x + d.x * 24) / TILE_PX);
    const ty = Math.floor((t.y - 6 + d.y * 24) / TILE_PX);
    const onBorder = tx < 2 || ty < 2 || tx >= map.widthTiles - 2 || ty >= map.heightTiles - 2;
    if (onBorder) return;
    map.setTile(tx, ty, map.isSolid(tx, ty) ? BUILD_FLOOR : BUILD_WALL);
  }

  private async save(manual = false): Promise<void> {
    const g = this.game;
    if (!g.saves.isLoaded) return;
    // Dead characters don't save: dying returns you to your last save.
    if (this.world.get(this.playerEntity, Health)?.dead) return;
    this.sinceSave = 0;
    this.syncPlayerSave();
    const played = this.playTime;
    this.playTime = 0;
    try {
      await g.saves.save(played);
      g.events.emit('save:done', { ok: true });
    } catch (e) {
      this.playTime += played;
      g.events.emit('save:done', { ok: false, error: (e as Error).message });
      if (manual) throw e;
      console.error('[save] autosave failed', e);
    }
  }
}

function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}
