import type { Game } from '../../core/Game';
import { GAME_VERSION } from '../../core/Game';
import { directionVector, lerp } from '../../core/math';
import type { Scene } from '../../core/Scene';
import { World, type Entity } from '../../ecs/World';
import type { ChannelColors } from '../../render/palette';
import { TileAtlas, TilemapRenderer } from '../../render/TilemapRenderer';
import type { WorldDeltas } from '../../save/WorldDeltas';
import { DevTools, type DevHooks } from '../../ui/DevTools';
import { prepareRaceArt, resolveColors, setCharacterAppearance, spawnCharacter } from '../characters';
import { Aim, Character, PlayerControlled, Stats, Transform, View } from '../components';
import { AnimationSystem } from '../systems/AnimationSystem';
import { MovementSystem } from '../systems/MovementSystem';
import { PlayerControlSystem } from '../systems/PlayerControlSystem';
import { getGenerator } from '../world/generators';
import { TILE_PX, TileMap } from '../world/TileMap';
import { TileSet } from '../world/TileSet';
import '../world/testRangeGenerator';
import { PauseScene } from './PauseScene';

const SLOT_ID = 'autosave';
const WORLD_ID = 'test_range';
const AUTOSAVE_SEC = 30;
const BUILD_WALL = 'metal_wall';
const BUILD_FLOOR = 'dirt';

/**
 * Phase 0 milestone scene: walk a character around a generated, chunk-streamed
 * map on PC or iPad, change race/colors, edit tiles, and have it all persist
 * through reloads via "seed + changes" saves.
 */
export class TestRangeScene implements Scene, DevHooks {
  readonly id = 'test-range';
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

  constructor(private game: Game) {}

  async enter(): Promise<void> {
    const g = this.game;

    // --- Save slot: continue if one exists, else start fresh.
    if (!(await g.saves.load(SLOT_ID))) {
      const human = g.content.get('race', 'human');
      g.saves.newGame({
        slotId: SLOT_ID,
        name: 'Autosave',
        gameVersion: GAME_VERSION,
        contentPacks: this.game.contentReport.packs.map((p) => ({ id: p.id, version: p.version })),
        player: { name: 'Stalker', raceId: human.id, colors: resolveColors(human), worldId: WORLD_ID, x: NaN, y: NaN, facing: 'down' },
      });
    }
    const save = g.saves.data;
    if (!g.content.has('race', save.player.raceId)) save.player.raceId = 'human'; // race removed from content

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
    await prepareRaceArt(g.content, g.sheets, save.player.raceId);
    let { x, y } = save.player;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const spawn = generator.spawnPoint(record.seed, params, this.map.widthTiles, this.map.heightTiles);
      x = (spawn.x + 0.5) * TILE_PX;
      y = (spawn.y + 0.5) * TILE_PX;
    }
    this.playerEntity = spawnCharacter(this.world, g.content, g.sheets, {
      raceId: save.player.raceId,
      colors: save.player.colors,
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
        if (g.scenes.current === this) void g.scenes.push(new PauseScene(g));
      }),
    );
    await this.save();
  }

  async exit(): Promise<void> {
    await this.save();
    for (const off of this.offEvents) off();
    this.dev?.destroy();
    this.tileRenderer?.destroy();
    for (const e of this.world.query(View)) this.world.destroy(e);
    this.world.flushDestroyed();
  }

  update(dt: number): void {
    const input = this.game.input;
    if (input.justPressed('pause')) {
      void this.game.scenes.push(new PauseScene(this.game));
      return;
    }
    this.world.update(dt);
    if (this.buildMode && input.justPressed('interact')) this.toggleTileInFront();

    this.playTime += dt;
    this.sinceSave += dt;
    if (this.sinceSave >= AUTOSAVE_SEC) void this.save();
  }

  render(alpha: number, frameDt: number): void {
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

  async setAppearance(raceId: string, colors: ChannelColors): Promise<void> {
    const g = this.game;
    await prepareRaceArt(g.content, g.sheets, raceId);
    setCharacterAppearance(this.world, g.content, g.sheets, this.playerEntity, raceId, colors);
    const ch = this.world.req(this.playerEntity, Character);
    g.saves.data.player.raceId = ch.raceId;
    g.saves.data.player.colors = ch.colors;
  }

  async saveNow(): Promise<void> {
    await this.save(true);
  }

  async newWorld(): Promise<void> {
    await this.game.saves.deleteSlot(SLOT_ID);
    location.reload();
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

  private async save(manual = false): Promise<void> {
    const g = this.game;
    if (!g.saves.isLoaded) return;
    this.sinceSave = 0;
    if (this.world.isAlive(this.playerEntity)) {
      const t = this.world.req(this.playerEntity, Transform);
      const ch = this.world.req(this.playerEntity, Character);
      Object.assign(g.saves.data.player, { x: t.x, y: t.y, facing: ch.facing, raceId: ch.raceId, colors: ch.colors });
    }
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
