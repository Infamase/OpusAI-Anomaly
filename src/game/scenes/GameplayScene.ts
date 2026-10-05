import type { Game } from '../../core/Game';
import { GAME_VERSION } from '../../core/Game';
import { directionVector, lerp } from '../../core/math';
import type { Scene } from '../../core/Scene';
import { World, type Entity } from '../../ecs/World';
import type { ChannelColors } from '../../render/palette';
import { TileAtlas, TilemapRenderer } from '../../render/TilemapRenderer';
import { SaveManager } from '../../save/SaveManager';
import type { EquipmentSave } from '../../save/types';
import type { WorldDeltas } from '../../save/WorldDeltas';
import { DevTools, type DevHooks } from '../../ui/DevTools';
import { prepareCharacterArt, resolveColors, setCharacterAppearance, spawnCharacter } from '../characters';
import { Aim, Character, Equipment, PlayerControlled, Stats, Transform, View } from '../components';
import { createItem, equipArmor, prepareArmorArt, startingEquipment, unequipArmor, type ArmorSlot } from '../equipment';
import { AnimationSystem } from '../systems/AnimationSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { PlayerControlSystem } from '../systems/PlayerControlSystem';
import { getGenerator } from '../world/generators';
import { TILE_PX, TileMap } from '../world/TileMap';
import { TileSet } from '../world/TileSet';
import '../world/testRangeGenerator';
import { PauseScene } from './PauseScene';

/** Where new characters start. Becomes the real starting location once planets exist. */
export const START_WORLD_ID = 'test_range';
const WORLD_ID = START_WORLD_ID;
const AUTOSAVE_SEC = 30;
const BUILD_WALL = 'metal_wall';
const BUILD_FLOOR = 'dirt';

export interface NewCharacter {
  name: string;
  raceId: string;
  colors: ChannelColors;
}

/** Creates a fresh save slot for a new character (with its race's starting gear) and starts playing it. */
export async function startNewGame(game: Game, who: NewCharacter): Promise<void> {
  const slotId = SaveManager.newSlotId();
  const race = game.content.get('race', who.raceId);
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
      equipment: startingEquipment(game.content, race.id),
    },
  });
  await game.saves.save();
  await game.scenes.change(new GameplayScene(game, slotId));
}

/**
 * In-world play: walk the character around a generated, chunk-streamed map on
 * PC or iPad. Everything persists through "seed + changes" saves. The world is
 * still the Phase 0 test range until planets (Phase 2) exist.
 */
export class GameplayScene implements Scene, DevHooks {
  readonly id = 'gameplay';
  buildMode = false;

  private world = new World();
  private map: TileMap | null = null;
  private tileRenderer: TilemapRenderer | null = null;
  private deltas: WorldDeltas | null = null;
  private playerEntity: Entity = 0;
  private dev: DevTools | null = null;
  private sinceSave = 0;
  private playTime = 0;
  private offEvents: (() => void)[] = [];
  /** Set once enter() completes; exit() only saves a fully loaded scene. */
  private ready = false;

  constructor(
    private game: Game,
    readonly slotId: string,
  ) {}

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

    // --- ECS: systems run in this order every tick.
    this.world
      .addSystem(new PlayerControlSystem(g.input, g.camera, () => g.renderer.pixelRatio))
      .addSystem(new MovementSystem(() => this.map))
      .addSystem(new AnimationSystem());
    this.world.onDestroy = (e) => this.world.get(e, View)?.destroy();

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
    g.renderer.entities.addChild(this.world.req(this.playerEntity, View).root);
    g.camera.snapTo({ x, y: y - 16 });

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
    for (const off of this.offEvents) off();
    this.dev?.destroy();
    this.tileRenderer?.destroy();
    for (const e of this.world.query(View)) this.world.destroy(e);
    this.world.flushDestroyed();
  }

  /** True once the world and player exist (enter() is async; the loop may tick before it finishes). */
  get isReady(): boolean {
    return this.ready;
  }

  update(dt: number): void {
    if (!this.ready) return;
    const input = this.game.input;
    if (input.justPressed('pause')) {
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
    for (const e of this.world.query(Transform, View, Character)) {
      const t = this.world.req(e, Transform);
      const ch = this.world.req(e, Character);
      const view = this.world.req(e, View);
      const x = lerp(t.prevX, t.x, alpha);
      const y = lerp(t.prevY, t.y, alpha);
      view.setPosition(x, y);
      const layout = g.content.get('spriteLayout', g.content.get('race', ch.raceId).spriteLayout);
      const anim = layout.animations.find((a) => a.id === ch.anim) ?? layout.animations[0]!;
      view.setFrame(anim.id, ch.facing, Math.floor(ch.animTime * anim.fps));
      if (e === this.playerEntity) {
        px = x;
        py = y;
      }
    }

    // Camera leads slightly toward the aim direction, Stalker-style.
    const aim = this.world.get(this.playerEntity, Aim)?.dir;
    g.camera.follow({ x: px, y: py - 16 }, aim ? { x: aim.x * 28, y: aim.y * 20 } : { x: 0, y: 0 });
    g.camera.update(frameDt);
    g.camera.apply(g.renderer.world);
    this.tileRenderer?.update(g.camera.bounds);
    this.dev?.update(performance.now());
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

  /** Dev: gives the character their race's starting kit again. */
  async resetGear(): Promise<void> {
    const g = this.game;
    const raceId = this.world.req(this.playerEntity, Character).raceId;
    for (const [slot, item] of Object.entries(startingEquipment(g.content, raceId))) {
      await this.equip(slot as ArmorSlot, item.defId);
    }
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
    return {
      Seed: this.map?.seed ?? '—',
      Tile: p ? `${p.tile.x}, ${p.tile.y}` : '—',
      'Chunks (data/drawn)': `${this.map?.loadedChunkCount ?? 0} / ${this.tileRenderer?.viewCount ?? 0}`,
      'Changed chunks': this.deltas?.changedChunkCount ?? 0,
      Entities: this.world.entityCount,
      Sheets: this.game.sheets.cachedCount,
    };
  }

  // ---- internals ------------------------------------------------------------

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

  private openPauseMenu(): void {
    const g = this.game;
    void g.scenes.push(new PauseScene(g, () => g.goToMainMenu()));
  }

  /** Copies the live player entity into the save data. */
  private syncPlayerSave(): void {
    const g = this.game;
    if (!g.saves.isLoaded || !this.world.isAlive(this.playerEntity)) return;
    const t = this.world.req(this.playerEntity, Transform);
    const ch = this.world.req(this.playerEntity, Character);
    Object.assign(g.saves.data.player, {
      x: t.x,
      y: t.y,
      facing: ch.facing,
      raceId: ch.raceId,
      colors: ch.colors,
      equipment: structuredClone(this.world.req(this.playerEntity, Equipment)),
    });
  }

  private async save(manual = false): Promise<void> {
    const g = this.game;
    if (!g.saves.isLoaded) return;
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
