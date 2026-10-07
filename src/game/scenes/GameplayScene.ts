import { EventBus } from '../../core/EventBus';
import type { Game } from '../../core/Game';
import { GAME_VERSION } from '../../core/Game';
import { directionVector, lerp } from '../../core/math';
import { deriveSeed, hashString, Rng } from '../../core/rng';
import type { Scene } from '../../core/Scene';
import { Texture } from 'pixi.js';
import { World, type Entity } from '../../ecs/World';
import { CharacterView } from '../../render/CharacterView';
import { CombatFx } from '../../render/CombatFx';
import { PropView } from '../../render/PropView';
import { drawCrate } from '../../render/placeholder/items';
import { Crosshair } from '../../render/Crosshair';
import type { ChannelColors } from '../../render/palette';
import { TileAtlas, TilemapRenderer } from '../../render/TilemapRenderer';
import { SaveManager } from '../../save/SaveManager';
import type { EquipmentSave, ItemInstance } from '../../save/types';
import { chunkKey, type WorldDeltas } from '../../save/WorldDeltas';
import { DevTools, type DevHooks } from '../../ui/DevTools';
import { Hud, type HudState } from '../../ui/Hud';
import type { RGB } from '../../render/palette';
import type { WorldGenDef } from '../../content/types';
import { Exploration } from '../exploration';
import { MapScene, type MapHost } from './MapScene';
import type { Landmark, WorldGenerator } from '../world/generators';
import { minimapColor, MINIMAP_RADIUS, type Blip } from '../../ui/Minimap';
import { WorldLabels } from '../../ui/WorldLabels';
import { NpcBrainSystem, type BarkKind } from '../ai/NpcBrainSystem';
import { addCombatComponents, prepareCharacterArt, resolveColors, setCharacterAppearance, spawnCharacter } from '../characters';
import { CHEST_HEIGHT, currentSpread, lineOfSight } from '../combat';
import { GameAudio, playUseSound } from '../GameAudio';
import type { CombatEvents } from '../combatEvents';
import {
  Aim,
  Brain,
  Character,
  Combatant,
  Container,
  Encumbrance,
  Equipment,
  Faction,
  Health,
  Inventory,
  Npc,
  PlayerControlled,
  Projectile,
  PropView as PropViewC,
  Stamina,
  Stats,
  Transform,
  Velocity,
  View,
  WorldItem,
} from '../components';
import { pickQuickHeal, useConsumable } from '../consumables';
import { findItem } from '../../content/items';
import { rollLoot } from '../loot';
import { EncumbranceSystem, refreshEncumbrance } from '../systems/EncumbranceSystem';
import { InventoryScene, type InventoryHost } from './InventoryScene';
import {
  ARMOR_SLOTS,
  createItem,
  refreshArmorLayers,
  defaultActiveWeapon,
  equipArmor,
  prepareArmorArt,
  startingEquipment,
  startingInventory,
  unequipArmor,
  type ArmorSlot,
} from '../equipment';
import { defaultStanding, PLAYER_FACTION, Relations, type PlayerStanding } from '../factions';
import { addItem, countItem, countOf, createLoadedWeapon } from '../items';
import { Population } from '../population';
import { AnimationSystem } from '../systems/AnimationSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { PlayerControlSystem } from '../systems/PlayerControlSystem';
import { ProjectileSystem } from '../systems/ProjectileSystem';
import { VitalsSystem } from '../systems/VitalsSystem';
import { WeaponSystem } from '../systems/WeaponSystem';
import { getGenerator } from '../world/generators';
import { TILE_PX, TileMap } from '../world/TileMap';
import { TileSet } from '../world/TileSet';
import '../world/testRangeGenerator';
import '../world/planetGenerator';
import { DeathScene } from './DeathScene';
import { PauseScene } from './PauseScene';

/** Where new characters start. Becomes the real starting location once planets exist. */
export const START_WORLD_ID = 'zone_north';
/** The player uncovers the map this far around them (px). */
const REVEAL_RADIUS = TILE_PX * 22;
const AUTOSAVE_SEC = 30;
/** People this close show on the minimap even without line of sight (you'd hear them). */
const SENSE_RADIUS = TILE_PX * 6;
const BUILD_WALL = 'metal_wall';
const BUILD_FLOOR = 'dirt';
/** Lines used when a faction has none of its own for a situation. */
const GENERIC_BARKS: Record<BarkKind, string[]> = {
  greet: ['Hey.', 'Good hunting.'],
  contact: ['Contact!', 'Hostiles!'],
  hurt: ['Argh!', "I'm hit!"],
  reload: ['Reloading!'],
  retreat: ['Falling back!'],
  angry: ['Watch your fire!', 'Hey!'],
  search: ['Where did they go?', 'Check over there.'],
};
const ATTITUDE_COLOR = { hostile: '#e0573f', neutral: '#d9c47a', friendly: '#7fcf6a' } as const;

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
 * In-world play: a character on a generated, chunk-streamed map, populated by
 * faction camps. Everything persists through "seed + changes" saves.
 * The world is still the Phase 0 test range until planets (Phase 2) exist.
 */
export class GameplayScene implements Scene, DevHooks, InventoryHost, MapHost {
  readonly id = 'gameplay';
  buildMode = false;

  readonly world = new World();
  private combatEvents = new EventBus<CombatEvents>();
  private map: TileMap | null = null;
  private tileRenderer: TilemapRenderer | null = null;
  private deltas: WorldDeltas | null = null;
  private playerEntity: Entity = 0;
  private dev: DevTools | null = null;
  private hud: Hud | null = null;
  private labels: WorldLabels | null = null;
  private relations!: Relations;
  private population: Population | null = null;
  private devSquads = 0;
  private fx = new CombatFx();
  private sound!: GameAudio;
  private worldId = START_WORLD_ID;
  private genDef!: WorldGenDef;
  private generator!: WorldGenerator<unknown>;
  private genParams: unknown;
  private seed = 0;
  private places: Landmark[] = [];
  private exploration!: Exploration;
  readonly mapCanvas = document.createElement('canvas');
  private mapColors: RGB[] = [];
  private placeIn: Landmark | null = null;
  private biomeName = '';
  private locationIn = 0;
  private revealIn = 0;
  private minimapIn = 0;
  private crosshair = new Crosshair();
  /** Which weapon each character view currently shows, to know when to swap textures. */
  private shownWeapon = new Map<Entity, string | null>();
  private sinceSave = 0;
  private playTime = 0;
  private offEvents: (() => void)[] = [];
  private rng = new Rng(Date.now() >>> 0);
  /** World objects (crates, dropped items) spawned per visible chunk. */
  private chunkObjects = new Map<string, Entity[]>();
  private crateTextures: Partial<Record<'supply' | 'military', Texture>> = {};
  /** The crate / item / body that E would interact with right now. */
  private focus: Entity | null = null;
  /** Set once enter() completes; exit() only saves a fully loaded scene. */
  private ready = false;

  constructor(
    private game: Game,
    readonly slotId: string,
  ) {}

  get playerId(): Entity {
    return this.playerEntity;
  }

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
    const standing = (save.flags.standing ??= defaultStanding()) as PlayerStanding;
    this.relations = new Relations(g.content, standing);
    this.relations.onAttitudeChange = (faction, attitude) => {
      const name = g.content.tryGet('faction', faction)?.name ?? faction;
      this.message(attitude === 'hostile' ? `${name} now consider you an enemy.` : `${name} now regard you as ${attitude}.`);
    };

    // --- World: regenerate from seed, then layer saved changes on top.
    // Each character remembers which world they're in (worlds removed from content fall back to the start).
    this.worldId = g.content.has('worldGen', save.player.worldId) ? save.player.worldId : START_WORLD_ID;
    save.player.worldId = this.worldId;
    const genDef = (this.genDef = g.content.get('worldGen', this.worldId));
    const generator = (this.generator = getGenerator(genDef.generator));
    const record = g.saves.ensureWorld(this.worldId, genDef.id, newSeed(), generator.version);
    this.seed = record.seed;
    this.deltas = await g.saves.enterWorld(this.worldId);
    const tiles = new TileSet(g.content.all('tile'));
    const params = (this.genParams = generator.parseParams(genDef.params, tiles, g.content));
    this.map = new TileMap({
      tiles,
      generator,
      params,
      seed: record.seed,
      widthChunks: genDef.widthChunks,
      heightChunks: genDef.heightChunks,
      deltas: this.deltas,
    });
    this.tileRenderer = new TilemapRenderer(g.renderer.ground, this.map, new TileAtlas(tiles), g.renderer.entities);
    g.renderer.overlay.addChild(this.fx.layer);
    g.renderer.screen.addChild(this.crosshair.g);

    // --- ECS: systems run in this order every tick.
    const map = () => this.map;
    this.world
      .addSystem(new PlayerControlSystem(g.input, g.camera, () => g.renderer.pixelRatio))
      .addSystem(new NpcBrainSystem(g.content, map, this.combatEvents, this.relations, (e, kind) => this.bark(e, kind)))
      .addSystem(new WeaponSystem(g.content, map, this.combatEvents))
      .addSystem(new MovementSystem(map))
      .addSystem(new ProjectileSystem(g.content, map, this.combatEvents))
      .addSystem(new VitalsSystem(this.combatEvents))
      .addSystem(new EncumbranceSystem(g.content))
      .addSystem(new AnimationSystem());
    this.world.onDestroy = (e) => {
      this.world.get(e, View)?.destroy();
      this.world.get(e, PropViewC)?.destroy();
      this.shownWeapon.delete(e);
    };
    this.tileRenderer.onChunkShown = (cx, cy) => this.spawnChunkObjects(cx, cy);
    this.tileRenderer.onChunkHidden = (cx, cy) => this.despawnChunkObjects(cx, cy);
    this.listenToCombat();
    this.sound = new GameAudio(g.audio, g.content, this.world, map, () => this.playerEntity);
    this.sound.listen(this.combatEvents);

    // --- Art: weapons and item icons are tiny, so prepare them all up front.
    await Promise.all([...g.content.all('weapon').map((w) => g.weaponArt.prepare(w)), g.icons.prepareAll()]);

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
      faction: PLAYER_FACTION,
      active: save.player.activeWeapon,
      inventory: save.player.inventory,
      hp: save.player.health,
    });
    g.renderer.entities.addChild(this.world.req(this.playerEntity, View).root);
    refreshEncumbrance(this.world, g.content, this.playerEntity);
    g.camera.snapTo({ x, y: y - CHEST_HEIGHT });

    // --- People: the world's camps (minus the dead) and the bodies they left.
    this.population = new Population(this.world, g.content, g.sheets, this.deltas, this.map, (e) =>
      g.renderer.entities.addChild(this.world.req(e, View).root),
    );
    await this.population.restoreBodies();
    const camps = generator.population?.(record.seed, params, this.map.widthTiles, this.map.heightTiles, (tx, ty) => !this.map!.isSolid(tx, ty));
    if (camps) await this.population.spawnCamps(camps, record.seed);

    this.hud = new Hud(g.root);
    this.labels = new WorldLabels(g.root);
    this.dev = new DevTools(g, this);
    this.offEvents.push(
      g.events.on('app:hidden', () => {
        void this.save();
        if (g.scenes.current === this) this.openPauseMenu();
      }),
    );
    // --- Map: named places, explored area, the PDA map image.
    this.places = generator.landmarks?.(record.seed, params, this.map.widthTiles, this.map.heightTiles) ?? [];
    this.exploration = new Exploration(save.flags, this.worldId, this.map.widthChunks, this.map.heightChunks);
    this.initMapCanvas();
    this.updateLocation(true);
    this.ready = true;
    await this.save();
  }

  async exit(): Promise<void> {
    if (this.ready) await this.save();
    this.ready = false;
    this.game.setGameplayInput(false);
    this.game.audio.setAmbient([]);
    this.game.renderer.canvas.classList.remove('aiming');
    for (const off of this.offEvents) off();
    this.combatEvents.clear();
    this.dev?.destroy();
    this.hud?.destroy();
    this.labels?.destroy();
    this.tileRenderer?.destroy();
    this.fx.destroy();
    this.crosshair.g.destroy();
    for (const e of this.world.query(View)) this.world.destroy(e);
    for (const e of this.world.query(PropViewC)) this.world.destroy(e);
    for (const e of this.world.query(Projectile)) this.world.destroy(e);
    this.world.flushDestroyed();
    this.chunkObjects.clear();
  }

  update(dt: number): void {
    if (!this.ready) return;
    const input = this.game.input;
    if (this.game.scenes.current === this && input.justPressed('pause')) {
      this.openPauseMenu();
      return;
    }
    this.world.update(dt);
    const alive = !this.world.get(this.playerEntity, Health)?.dead;
    this.focus = alive && !this.buildMode ? this.findInteractable() : null;
    if (this.buildMode && input.justPressed('interact')) this.toggleTileInFront();
    else if (alive && input.justPressed('interact') && this.focus !== null) this.interact(this.focus);
    else if (alive && input.justPressed('inventory')) void this.game.scenes.push(new InventoryScene(this.game, this));
    if (alive && input.justPressed('quickHeal')) this.quickHeal();
    if (alive && this.game.scenes.current === this && input.justPressed('map')) void this.game.scenes.push(new MapScene(this.game, this));
    this.revealIn -= dt;
    if (this.revealIn <= 0) {
      this.revealIn = 0.25;
      const t = this.world.req(this.playerEntity, Transform);
      const S = this.map!.chunkSize;
      for (const c of this.exploration.reveal(t.x, t.y, REVEAL_RADIUS, S * TILE_PX)) this.paintMapChunk(c.cx, c.cy);
    }
    this.locationIn -= dt;
    if (this.locationIn <= 0) {
      this.locationIn = 1;
      this.updateLocation(false);
    }
    const hp = this.world.get(this.playerEntity, Health);
    this.sound.update(dt, hp ? hp.hp / this.world.req(this.playerEntity, Stats).get('max_health') : 1, alive);

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
      this.syncWeaponView(e, view);
      const vel = this.world.get(e, Velocity);
      const aimDir = this.world.get(e, Aim)?.dir;
      const c = this.world.get(e, Combatant);
      const stepped = view.update(frameDt, {
        facing: ch.facing,
        speed: vel ? Math.hypot(vel.x, vel.y) : 0,
        walkSpeed: this.world.get(e, Stats)?.get('move_speed') ?? 70,
        sprint: ch.sprinting,
        aim: aimDir ? Math.atan2(aimDir.y, aimDir.x) : null,
        reload: c && c.reloadLeft > 0 ? 1 - c.reloadLeft / Math.max(0.01, c.reloadTotal) : null,
      });
      if (stepped) this.sound.footstep(e, x, y, ch.sprinting);
      const h = this.world.get(e, Health);
      if (e === this.playerEntity) {
        px = x;
        py = y;
      } else if (h && !h.dead && h.sinceHit < 4) {
        bars.push({ x, y, frac: h.hp / (this.world.get(e, Stats)?.get('max_health') ?? 100) });
      }
    }

    g.audio.setListener(px, py);

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
    for (const e of this.world.query(PropViewC)) this.world.req(e, PropViewC).setHighlight(e === this.focus);
    this.hud?.prompt(this.focus !== null && this.game.scenes.current === this ? this.promptFor(this.focus) : null);
    const chest = g.camera.worldToScreen(px, py - CHEST_HEIGHT);
    this.hud?.update(this.hudState(), frameDt, { x: chest.x / g.renderer.pixelRatio, y: chest.y / g.renderer.pixelRatio });
    this.minimapIn -= frameDt;
    if (this.minimapIn <= 0) {
      this.minimapIn = 0.1;
      this.drawMinimap(px, py);
    }
    this.updateLabels(frameDt, alpha);
    this.dev?.update(performance.now());
  }

  // ---- combat wiring ----------------------------------------------------------

  private listenToCombat(): void {
    const ev = this.combatEvents;
    const cam = this.game.camera;
    ev.on('shot', (s) => {
      this.fx.muzzle(s.x, s.y, s.angle);
      this.world.get(s.shooter, View)?.fire();
      if (s.shooter === this.playerEntity) cam.kick(-Math.cos(s.angle) * s.recoil, -Math.sin(s.angle) * s.recoil);
    });
    ev.on('impact', (i) => this.fx.sparks(i.x, i.y, i.angle));
    ev.on('hit', (h) => {
      this.fx.blood(h.x, h.y, h.angle, h.dealt);
      this.world.get(h.target, View)?.flash();
      if (h.attacker === this.playerEntity) this.crosshair.hit(h.killed);
      if (h.target === this.playerEntity) {
        // The arc points back along the bullet's path, toward the shooter.
        this.hud?.damage(h.dealt, h.angle + Math.PI);
        cam.kick(Math.cos(h.angle) * 2, Math.sin(h.angle) * 2);
      }
    });
    ev.on('death', (d) => {
      this.world.get(d.entity, View)?.setDead(true);
      this.labels?.forget(d.entity);
      if (d.entity === this.playerEntity) this.onPlayerDeath(d.killer);
      else {
        if (d.killer === this.playerEntity) this.announceKill(d.entity);
        this.population?.onNpcDeath(d.entity);
      }
    });
  }

  /** Kill feed line, in the victim's faction color. */
  private announceKill(e: Entity): void {
    const npc = this.world.get(e, Npc);
    const faction = this.game.content.tryGet('faction', this.world.get(e, Faction)?.id ?? '');
    const template = npc && this.game.content.tryGet('npcTemplate', npc.templateId);
    this.message(`Killed ${npc?.name ?? 'stalker'}${template ? ` (${template.name})` : ''}`, faction?.color);
  }

  private onPlayerDeath(killer: Entity | null): void {
    const g = this.game;
    const alive = killer !== null && this.world.isAlive(killer);
    const by = alive ? this.world.get(killer, Equipment) : undefined;
    const weaponId = alive ? by?.[this.world.get(killer, Combatant)?.active ?? 'primary']?.defId : undefined;
    const npc = alive ? this.world.get(killer, Npc) : undefined;
    const who = npc ? `${npc.name} (${g.content.tryGet('npcTemplate', npc.templateId)?.name ?? 'stalker'})` : 'a stalker';
    const cause =
      killer === null ? 'You bled out.' : `Killed by ${who}${weaponId ? ` with ${withArticle(g.content.tryGet('weapon', weaponId)?.name ?? weaponId)}` : ''}.`;
    // No save here: dying sends you back to your last save.
    void g.scenes.push(new DeathScene(g, cause, () => g.scenes.change(new GameplayScene(g, this.slotId))));
  }

  /** Swaps the held-weapon texture when the active weapon changes. */
  private syncWeaponView(e: Entity, view: CharacterView): void {
    const c = this.world.get(e, Combatant);
    const item = c?.active ? this.world.get(e, Equipment)?.[c.active] : undefined;
    const id = item?.defId ?? null;
    if (this.shownWeapon.get(e) !== id) {
      this.shownWeapon.set(e, id);
      const art = id ? this.game.weaponArt.get(id) : undefined;
      view.setWeapon(art?.texture ?? null, art?.grip, art?.muzzle);
    }
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
    const load = this.world.get(e, Encumbrance);
    const item = c.active ? eq[c.active] : undefined;
    const def = item && g.content.tryGet('weapon', item.defId);
    const ammoId = item?.loadedAmmo ?? def?.ammo[0];
    const otherSlot = c.active === 'sidearm' ? 'primary' : 'sidearm';
    const other = eq[otherSlot];
    const otherDef = other && g.content.tryGet('weapon', other.defId);
    return {
      hp: h.hp,
      maxHp: stats.get('max_health'),
      bleed: h.bleed,
      healing: h.regen.some((r) => r.left > 0),
      stamina: st.current,
      maxStamina: stats.get('max_stamina'),
      exhausted: st.exhausted,
      load: { weight: load?.weight ?? 0, limit: load?.limit ?? 1, level: load?.level ?? 0 },
      meds: inv.reduce((n, it) => n + (g.content.tryGet('consumable', it.defId)?.category === 'medical' ? countOf(it) : 0), 0),
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
      holstered: otherDef && other ? { slot: otherSlot, name: otherDef.name, loaded: other.loaded ?? 0 } : null,
      armor: ARMOR_SLOTS.flatMap((slot) => {
        const it = eq[slot];
        const d = it && g.content.tryGet('armor', it.defId);
        return it && d ? [{ slot, name: d.name, condition: it.condition }] : [];
      }),
    };
  }

  /** Terrain around the player plus the people, containers and items they could know about. */
  private drawMinimap(px: number, py: number): void {
    const map = this.map;
    const hud = this.hud;
    if (!map || !hud) return;
    const range = MINIMAP_RADIUS * TILE_PX;
    const blips: Blip[] = [];
    for (const e of this.world.query(Transform)) {
      if (e === this.playerEntity) continue;
      const t = this.world.req(e, Transform);
      const dx = t.x - px;
      const dy = t.y - py;
      if (Math.abs(dx) > range || Math.abs(dy) > range) continue;
      if (this.world.has(e, Npc) && !this.world.get(e, Health)?.dead) {
        // People show when close or in plain sight.
        if (Math.hypot(dx, dy) > SENSE_RADIUS && !lineOfSight(map, px, py - CHEST_HEIGHT, t.x, t.y - CHEST_HEIGHT)) continue;
        blips.push({ x: t.x, y: t.y, kind: this.relations.attitude(this.world, e, this.playerEntity) });
      } else if (this.world.has(e, Container)) {
        blips.push({ x: t.x, y: t.y, kind: this.world.req(e, Container).kind === 'body' ? 'body' : 'crate' });
      } else if (this.world.has(e, WorldItem)) {
        blips.push({ x: t.x, y: t.y, kind: 'item' });
      }
    }
    const aim = this.world.get(this.playerEntity, Aim)?.dir;
    hud.minimap.draw(map, px, py, aim ? Math.atan2(aim.y, aim.x) : null, blips);
  }

  // ---- map & location ------------------------------------------------------

  get worldName(): string {
    return this.genDef.name;
  }

  playerOnMap(): { x: number; y: number; aim: number | null } {
    const t = this.world.req(this.playerEntity, Transform);
    const aim = this.world.get(this.playerEntity, Aim)?.dir;
    return { x: t.x / TILE_PX, y: t.y / TILE_PX, aim: aim ? Math.atan2(aim.y, aim.x) : null };
  }

  /** Places show on the map once the chunk at their center has been seen. */
  knownPlaces(): Landmark[] {
    const S = this.map!.chunkSize;
    return this.places.filter((p) => this.exploration.isExplored(Math.floor(p.x / S), Math.floor(p.y / S)));
  }

  exploredShare(): number {
    return this.exploration.exploredCount / (this.map!.widthChunks * this.map!.heightChunks);
  }

  locationName(): string {
    return this.placeIn?.name ?? this.biomeName ?? '';
  }

  private initMapCanvas(): void {
    const map = this.map!;
    this.mapCanvas.width = map.widthTiles;
    this.mapCanvas.height = map.heightTiles;
    this.mapColors = map.tiles.defs.map(minimapColor);
    const ctx = this.mapCanvas.getContext('2d');
    if (!ctx) return;
    // Fog: dark, with a faint chunk grid like graph paper.
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, map.widthTiles, map.heightTiles);
    ctx.fillStyle = '#161a1f';
    for (let x = 0; x < map.widthTiles; x += map.chunkSize) ctx.fillRect(x, 0, 1, map.heightTiles);
    for (let y = 0; y < map.heightTiles; y += map.chunkSize) ctx.fillRect(0, y, map.widthTiles, 1);
    for (let cy = 0; cy < map.heightChunks; cy++) for (let cx = 0; cx < map.widthChunks; cx++) if (this.exploration.isExplored(cx, cy)) this.paintMapChunk(cx, cy);
  }

  private paintMapChunk(cx: number, cy: number): void {
    const map = this.map!;
    const ctx = this.mapCanvas.getContext('2d');
    const chunk = map.chunk(cx, cy);
    if (!ctx || !chunk) return;
    const S = map.chunkSize;
    const img = ctx.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const c = this.mapColors[chunk.tiles[i]!]!;
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, cx * S, cy * S);
  }

  /** Which place / biome the player is in: HUD label, arrival notices and the biome's ambience. */
  private updateLocation(first: boolean): void {
    const g = this.game;
    const t = this.world.req(this.playerEntity, Transform);
    const tx = Math.floor(t.x / TILE_PX);
    const ty = Math.floor(t.y / TILE_PX);
    const place = this.places.find((p) => Math.abs(tx + 0.5 - p.x) <= p.w / 2 + 3 && Math.abs(ty + 0.5 - p.y) <= p.h / 2 + 3) ?? null;
    if (place !== this.placeIn) {
      if (place && !first) this.message(`Entering ${place.name}`, '#e2c060');
      this.placeIn = place;
    }
    const biome = this.generator.biomeAt?.(this.seed, this.genParams as never, this.map!.widthTiles, this.map!.heightTiles, tx, ty);
    this.biomeName = biome?.name ?? this.genDef.name;
    this.hud?.location(this.locationName());
    const ambientCue = g.audio.cue('ambient');
    const base = this.genDef.ambient ?? (ambientCue ? [ambientCue] : []);
    g.audio.setAmbient([...new Set([...base, ...(biome?.ambient ?? [])])]);
  }

  // ---- DevHooks: worlds --------------------------------------------------------

  listWorlds(): { id: string; name: string; current: boolean }[] {
    return this.game.content.all('worldGen').map((w) => ({ id: w.id, name: w.name, current: w.id === this.worldId }));
  }

  /** Dev: moves the character to another world (arriving at its spawn point). */
  async travel(worldId: string): Promise<void> {
    const g = this.game;
    if (worldId === this.worldId || !g.content.has('worldGen', worldId)) return;
    this.world.req(this.playerEntity, Transform).x = NaN;
    this.syncPlayerSave();
    g.saves.data.player.worldId = worldId;
    await g.scenes.change(new GameplayScene(g, this.slotId));
  }

  // ---- NPC labels & barks ------------------------------------------------------

  /** An NPC says something fitting for its faction. */
  private bark(e: Entity, kind: BarkKind): void {
    const faction = this.game.content.tryGet('faction', this.world.get(e, Faction)?.id ?? '');
    const lines = faction?.barks[kind]?.length ? faction.barks[kind] : GENERIC_BARKS[kind];
    if (!lines.length) return;
    // Only bother showing lines said near the player.
    const t = this.world.req(e, Transform);
    const pt = this.world.req(this.playerEntity, Transform);
    if (Math.hypot(t.x - pt.x, t.y - pt.y) > 520) return;
    this.labels?.say(e, this.rng.pick(lines), faction?.color ?? '#ccc');
    this.sound.bark(e);
  }

  /** Name tag for the NPC under the cursor, and positions for floating text. */
  private updateLabels(dt: number, alpha: number): void {
    const g = this.game;
    const labels = this.labels;
    if (!labels) return;
    const px = g.renderer.pixelRatio;
    const project = (e: Entity) => {
      if (!this.world.isAlive(e)) return null;
      const t = this.world.get(e, Transform);
      if (!t) return null;
      const x = lerp(t.prevX, t.x, alpha);
      const y = lerp(t.prevY, t.y, alpha);
      const head = g.camera.worldToScreen(x, y - 46);
      const feet = g.camera.worldToScreen(x, y + 2);
      return { x: head.x / px, head: head.y / px, feet: feet.y / px };
    };
    let hovered: Entity | null = null;
    const aim = g.input.aim;
    if (g.scenes.current === this && aim.kind === 'point') {
      const w = g.camera.screenToWorld(aim.screen.x * px, aim.screen.y * px);
      let best = Infinity;
      for (const e of this.world.query(Npc, Transform, Health)) {
        if (this.world.req(e, Health).dead) continue;
        const t = this.world.req(e, Transform);
        // Roughly the character's sprite box.
        if (Math.abs(w.x - t.x) > 14 || w.y < t.y - 48 || w.y > t.y + 6) continue;
        const d = Math.hypot(w.x - t.x, w.y - (t.y - 20));
        if (d < best) {
          best = d;
          hovered = e;
        }
      }
    }
    if (hovered === null) labels.target(null);
    else {
      const npc = this.world.req(hovered, Npc);
      const fid = this.world.get(hovered, Faction)?.id ?? '';
      const faction = g.content.tryGet('faction', fid);
      const attitude = this.relations.attitude(this.world, hovered, this.playerEntity);
      const rank = g.content.tryGet('npcTemplate', npc.templateId)?.name;
      labels.target(hovered, npc.name, `${faction?.name ?? fid}${rank ? ` · ${rank}` : ''} · ${attitude}`, ATTITUDE_COLOR[attitude]);
    }
    labels.update(dt, project);
  }

  // ---- world objects & looting ----------------------------------------------

  /** Spawns a chunk's crates (with any saved contents) and the items dropped there. */
  private spawnChunkObjects(cx: number, cy: number): void {
    const map = this.map;
    const deltas = this.deltas;
    if (!map || !deltas) return;
    const key = chunkKey(cx, cy);
    const list: Entity[] = [];
    for (const obj of map.objects(cx, cy)) {
      const saved = deltas.entity(key, obj.id);
      const e = this.world.create();
      this.world.add(e, Transform, { x: obj.x, y: obj.y, prevX: obj.x, prevY: obj.y });
      this.world.add(e, Container, {
        id: obj.id,
        label: obj.variant === 'military' ? 'Military case' : 'Supply crate',
        kind: 'crate',
        chunkKey: key,
        lootTable: obj.lootTable,
        items: saved ? structuredClone(saved.data as ItemInstance[]) : null,
      });
      this.addProp(e, this.crateTexture(obj.variant), obj.x, obj.y, 13);
      list.push(e);
    }
    for (const { key: k, record } of deltas.entitiesOfKind('item')) {
      if (k === key) list.push(this.spawnWorldItem(record.data as ItemInstance, record.x, record.y, key, record.id));
    }
    this.chunkObjects.set(key, list);
  }

  private despawnChunkObjects(cx: number, cy: number): void {
    const key = chunkKey(cx, cy);
    for (const e of this.chunkObjects.get(key) ?? []) if (this.world.isAlive(e)) this.world.destroy(e);
    this.chunkObjects.delete(key);
  }

  private spawnWorldItem(item: ItemInstance, x: number, y: number, key: string, recordId: string): Entity {
    const e = this.world.create();
    this.world.add(e, Transform, { x, y, prevX: x, prevY: y });
    this.world.add(e, WorldItem, { item, recordId, chunkKey: key });
    this.addProp(e, this.game.icons.texture(item.defId), x, y);
    return e;
  }

  private addProp(e: Entity, texture: Texture, x: number, y: number, shadow?: number): void {
    const view = new PropView(texture, { shadow });
    view.setPosition(x, y);
    this.world.add(e, PropViewC, view);
    this.game.renderer.entities.addChild(view.root);
  }

  private crateTexture(variant: 'supply' | 'military'): Texture {
    return (this.crateTextures[variant] ??= Texture.from(drawCrate(variant).toCanvas(), true));
  }

  /** Nearest item, crate or body within reach of the player's feet. */
  private findInteractable(): Entity | null {
    const pt = this.world.req(this.playerEntity, Transform);
    let best: Entity | null = null;
    let bestD = 30;
    const consider = (e: Entity) => {
      const t = this.world.req(e, Transform);
      const d = Math.hypot(t.x - pt.x, t.y - pt.y);
      if (d < bestD) {
        best = e;
        bestD = d;
      }
    };
    for (const e of this.world.query(WorldItem, Transform)) consider(e);
    for (const e of this.world.query(Container, Transform)) if (e !== this.playerEntity) consider(e);
    return best;
  }

  private promptFor(e: Entity): string {
    const wi = this.world.get(e, WorldItem);
    if (wi) {
      const name = findItem(this.game.content, wi.item.defId)?.def.name ?? wi.item.defId;
      return `E  Pick up ${name}${countOf(wi.item) > 1 ? ` ×${countOf(wi.item)}` : ''}`;
    }
    const c = this.world.get(e, Container);
    if (!c) return '';
    const empty = c.items !== null && c.items.length === 0;
    return `E  ${c.kind === 'body' ? 'Search' : 'Open'} ${c.label}${empty ? ' (empty)' : ''}`;
  }

  private interact(e: Entity): void {
    const g = this.game;
    const wi = this.world.get(e, WorldItem);
    if (wi) {
      addItem(g.content, this.world.req(this.playerEntity, Inventory), wi.item);
      this.deltas?.removeEntity(wi.chunkKey, wi.recordId);
      this.world.destroy(e);
      refreshEncumbrance(this.world, g.content, this.playerEntity);
      const name = findItem(g.content, wi.item.defId)?.def.name ?? wi.item.defId;
      g.audio.playCue('pickup');
      this.message(`Picked up ${name}${countOf(wi.item) > 1 ? ` ×${countOf(wi.item)}` : ''}`);
      return;
    }
    const c = this.world.get(e, Container);
    if (!c) return;
    if (c.items === null) {
      // First look inside: roll the contents from the seed, so they're the same every time until changed.
      const seed = this.map ? deriveSeed(this.map.seed, 'crate', hashString(c.id)) : 1;
      c.items = c.lootTable ? rollLoot(g.content, c.lootTable, new Rng(seed)) : [];
    }
    void g.scenes.push(new InventoryScene(g, this, e));
  }

  // ---- InventoryHost -------------------------------------------------------

  dropItem(item: ItemInstance): void {
    const t = this.world.req(this.playerEntity, Transform);
    const x = t.x + this.rng.range(-10, 10);
    const y = t.y + this.rng.range(2, 10);
    const S = this.map?.chunkSize ?? 16;
    const key = chunkKey(Math.floor(x / TILE_PX / S), Math.floor(y / TILE_PX / S));
    this.deltas?.putEntity(key, { id: item.uid, kind: 'item', x, y, data: item });
    const e = this.spawnWorldItem(item, x, y, key, item.uid);
    if (!this.chunkObjects.has(key)) this.chunkObjects.set(key, []);
    this.chunkObjects.get(key)!.push(e);
    refreshEncumbrance(this.world, this.game.content, this.playerEntity);
  }

  containerChanged(e: Entity): void {
    const c = this.world.get(e, Container);
    if (!c || !c.items) return;
    if (c.kind === 'crate' && c.chunkKey && this.deltas) {
      const t = this.world.req(e, Transform);
      this.deltas.putEntity(c.chunkKey, { id: c.id, kind: 'container', x: t.x, y: t.y, data: structuredClone(c.items) });
    }
    if (c.kind === 'body') {
      // Gear taken off a body disappears from it.
      const eq = this.world.get(e, Equipment);
      if (eq) {
        for (const [slot, it] of Object.entries(eq)) if (it && !c.items.includes(it)) delete eq[slot as keyof typeof eq];
        refreshArmorLayers(this.world, this.game.content, this.game.sheets, e);
      }
      this.population?.saveBody(e);
    }
  }

  message(text: string, color?: string): void {
    this.hud?.message(text, color);
  }

  private quickHeal(): void {
    const g = this.game;
    const e = this.playerEntity;
    const h = this.world.req(e, Health);
    const inv = this.world.req(e, Inventory);
    const item = pickQuickHeal(g.content, inv, h.hp / this.world.req(e, Stats).get('max_health'), h.bleed);
    if (!item) {
      this.message(inv.some((i) => g.content.tryGet('consumable', i.defId)?.category === 'medical') ? 'No need to heal.' : 'No medical supplies.');
      return;
    }
    const defId = item.defId;
    const msg = useConsumable(this.world, g.content, e, item);
    if (msg) playUseSound(g.audio, g.content, defId);
    if (msg) this.message(msg);
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

  listNpcTemplates(): { id: string; name: string; faction: string }[] {
    return this.game.content.all('npcTemplate').map((t) => ({ id: t.id, name: t.name, faction: t.faction }));
  }

  /** Dev: a squad from one template, 7–11 tiles from the player, guarding where it lands. */
  async spawnSquad(templateId: string, count: number): Promise<void> {
    const pop = this.population;
    if (!pop) return;
    const pt = this.world.req(this.playerEntity, Transform);
    const a = this.rng.range(0, Math.PI * 2);
    const d = this.rng.range(7, 11) * TILE_PX;
    const center = pop.spotNear(pt.x + Math.cos(a) * d, pt.y + Math.sin(a) * d, TILE_PX * 2, this.rng);
    if (!center) return;
    const squad = `dev${++this.devSquads}-${Date.now().toString(36)}`;
    for (let i = 0; i < count; i++) {
      const spot = pop.spotNear(center.x, center.y, TILE_PX * 2, this.rng) ?? center;
      await pop.spawnNpc({ id: `${squad}:${i}`, campId: squad, templateId, ...spot, homeX: center.x, homeY: center.y, behavior: 'guard', radius: TILE_PX * 3, rng: this.rng });
    }
  }

  clearNpcs(): void {
    for (const e of this.world.query(Npc, Health)) {
      if (this.world.req(e, Health).dead) continue;
      this.labels?.forget(e);
      this.world.destroy(e);
    }
  }

  resetReputation(): void {
    this.relations.standing.reputation = {};
    for (const e of this.world.query(Npc)) this.world.req(e, Npc).grudges.clear();
    this.message('Reputation reset.');
  }

  async saveNow(): Promise<void> {
    await this.save(true);
  }

  /** Dev: throws away this world's seed and edits, then re-enters a freshly generated one. */
  async newWorld(): Promise<void> {
    const g = this.game;
    this.world.req(this.playerEntity, Transform).x = NaN; // respawn at the new world's spawn point
    this.syncPlayerSave();
    await g.saves.resetWorld(this.worldId);
    delete g.saves.data.flags[`explored:${this.worldId}`];
    await g.scenes.change(new GameplayScene(g, this.slotId));
  }

  info(): Record<string, string | number> {
    const p = this.player();
    let alive = 0;
    let bodies = 0;
    let fighting = 0;
    for (const e of this.world.query(Npc, Health)) {
      if (this.world.req(e, Health).dead) bodies++;
      else {
        alive++;
        if (this.world.get(e, Brain)?.state === 'combat') fighting++;
      }
    }
    const st = this.relations.standing;
    const rep = this.game.content
      .all('faction')
      .map((f) => `${f.id} ${st.reputation[f.id] ?? 0} (${this.relations.playerAttitude(f.id)[0]})`)
      .join(', ');
    return {
      Seed: this.map?.seed ?? '—',
      Tile: p ? `${p.tile.x}, ${p.tile.y}` : '—',
      'Chunks (data/drawn)': `${this.map?.loadedChunkCount ?? 0} / ${this.tileRenderer?.viewCount ?? 0}`,
      'Changed chunks': this.deltas?.changedChunkCount ?? 0,
      Entities: this.world.entityCount,
      'NPCs (alive/fighting/dead)': `${alive} / ${fighting} / ${bodies}`,
      Reputation: rep,
      Sheets: this.game.sheets.cachedCount,
      'Puppet redraws': CharacterView.redraws,
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

/** "an AKR-5", "a VZ-9". */
function withArticle(name: string): string {
  return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
}

function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}
