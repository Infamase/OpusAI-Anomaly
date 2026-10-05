import type { SaveBackend } from './backends';
import { migrateChunk, migrateSave } from './migrations';
import { SAVE_VERSION, type ChunkDeltaRecord, type PlayerSave, type SaveData, type SaveMeta, type WorldRecord } from './types';
import { WorldDeltas } from './WorldDeltas';

/** What the Load screen shows for one slot. `error` is set when the slot can't be read. */
export interface SlotSummary {
  meta: SaveMeta;
  player: PlayerSave;
  error?: string;
}

/** A parsed (not yet written) save file. */
export interface ImportPreview {
  data: SaveData;
  chunks: ChunkDeltaRecord[];
}

export interface NewGameOptions {
  slotId: string;
  name: string;
  player: PlayerSave;
  gameVersion: string;
  contentPacks: { id: string; version: string }[];
}

/**
 * Owns the active save slot: creating, loading (with migration), tracking which
 * worlds are loaded, and committing changes. Game code mutates `data` and the
 * WorldDeltas it gets from enterWorld(); save() persists whatever changed.
 */
export class SaveManager {
  private active: SaveData | null = null;
  private worlds = new Map<string, WorldDeltas>();
  private saving: Promise<void> | null = null;

  constructor(readonly backend: SaveBackend) {}

  get data(): SaveData {
    if (!this.active) throw new Error('No save loaded');
    return this.active;
  }

  get isLoaded(): boolean {
    return this.active !== null;
  }

  async listSlots(): Promise<SaveData['meta'][]> {
    return (await this.backend.listSlots()).map((s) => s.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every slot, newest first, upgraded to the current format for display. */
  async listSummaries(): Promise<SlotSummary[]> {
    const out: SlotSummary[] = [];
    for (const raw of await this.backend.listSlots()) {
      try {
        const data = migrateSave<SaveData>(raw);
        out.push({ meta: data.meta, player: data.player });
      } catch (e) {
        out.push({ meta: raw.meta, player: raw.player, error: (e as Error).message });
      }
    }
    return out.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
  }

  async slotExists(slotId: string): Promise<boolean> {
    return (await this.backend.loadSlot(slotId)) !== undefined;
  }

  static newSlotId(): string {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return `slot-${Date.now().toString(36)}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  /** Forgets a world's seed and changes; it regenerates fresh on the next visit. */
  async resetWorld(worldId: string): Promise<void> {
    delete this.data.worlds[worldId];
    this.worlds.delete(worldId);
    await this.backend.deleteWorldChunks(this.data.meta.slotId, worldId);
    await this.save();
  }

  newGame(opts: NewGameOptions): SaveData {
    const now = Date.now();
    this.worlds.clear();
    this.active = {
      version: SAVE_VERSION,
      meta: {
        slotId: opts.slotId,
        name: opts.name,
        createdAt: now,
        updatedAt: now,
        playTimeSec: 0,
        gameVersion: opts.gameVersion,
        contentPacks: opts.contentPacks,
      },
      player: opts.player,
      worlds: {},
      flags: {},
    };
    return this.active;
  }

  async load(slotId: string): Promise<SaveData | undefined> {
    const raw = await this.backend.loadSlot(slotId);
    if (!raw) return undefined;
    this.active = migrateSave<SaveData>(raw);
    this.worlds.clear();
    return this.active;
  }

  /** Gets or creates the recipe for a world. The seed is fixed forever once created. */
  ensureWorld(worldId: string, genId: string, seed: number, genVersion: number): WorldRecord {
    const now = Date.now();
    const existing = this.data.worlds[worldId];
    if (existing) {
      existing.lastVisitedAt = now;
      return existing;
    }
    const rec: WorldRecord = { worldId, genId, seed, genVersion, firstVisitedAt: now, lastVisitedAt: now };
    this.data.worlds[worldId] = rec;
    return rec;
  }

  /** Loads all saved changes for a world into memory. Call when the player arrives. */
  async enterWorld(worldId: string): Promise<WorldDeltas> {
    const cached = this.worlds.get(worldId);
    if (cached) return cached;
    const records = await this.backend.loadWorldChunks(this.data.meta.slotId, worldId);
    const deltas = new WorldDeltas(
      worldId,
      records.map((r) => [r.chunkKey, migrateChunk(r.delta, r.version)] as const),
    );
    this.worlds.set(worldId, deltas);
    return deltas;
  }

  /** Drops a world's deltas from memory (after saving). Keeps memory low when hopping planets. */
  async leaveWorld(worldId: string): Promise<void> {
    await this.save();
    this.worlds.delete(worldId);
  }

  /** Persists the slot and every changed chunk. Concurrent calls are coalesced. */
  save(playTimeDeltaSec = 0): Promise<void> {
    if (this.saving) return this.saving.then(() => this.save(playTimeDeltaSec));
    this.saving = this.doSave(playTimeDeltaSec).finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async doSave(playTimeDeltaSec: number): Promise<void> {
    const data = this.data;
    data.meta.updatedAt = Date.now();
    data.meta.playTimeSec += playTimeDeltaSec;
    const writes: ChunkDeltaRecord[] = [];
    const deletes: { worldId: string; chunkKey: string }[] = [];
    const taken: [WorldDeltas, string[]][] = [];
    for (const deltas of this.worlds.values()) {
      const dirty = deltas.takeDirty();
      taken.push([deltas, dirty.map((d) => d.key)]);
      for (const { key, delta } of dirty) {
        if (delta) {
          writes.push({ slotId: data.meta.slotId, worldId: deltas.worldId, chunkKey: key, version: SAVE_VERSION, delta });
        } else {
          deletes.push({ worldId: deltas.worldId, chunkKey: key });
        }
      }
    }
    try {
      await this.backend.commit(structuredClone(data), writes, deletes);
    } catch (e) {
      for (const [deltas, keys] of taken) deltas.restoreDirty(keys);
      throw e;
    }
  }

  async deleteSlot(slotId: string): Promise<void> {
    await this.backend.deleteSlot(slotId);
    if (this.active?.meta.slotId === slotId) {
      this.active = null;
      this.worlds.clear();
    }
  }

  /** Full slot as portable JSON — for backups and moving a save to another PC. */
  async exportSlot(slotId: string): Promise<string> {
    const data = await this.backend.loadSlot(slotId);
    if (!data) throw new Error(`No save "${slotId}"`);
    const chunks: ChunkDeltaRecord[] = [];
    for (const worldId of Object.keys(data.worlds)) chunks.push(...(await this.backend.loadWorldChunks(slotId, worldId)));
    return JSON.stringify({ format: 'sfa-save', data, chunks });
  }

  /** Parses and upgrades a save file without writing it (to show its name / check for conflicts). */
  previewImport(json: string): ImportPreview {
    let parsed: { format?: string; data?: SaveData; chunks?: ChunkDeltaRecord[] };
    try {
      parsed = JSON.parse(json) as typeof parsed;
    } catch {
      throw new Error('That file is not a save file (it is not valid JSON).');
    }
    if (parsed?.format !== 'sfa-save' || !parsed.data || !Array.isArray(parsed.chunks)) {
      throw new Error('That file is not a Stalker: Future Anomaly save.');
    }
    return { data: migrateSave<SaveData>(parsed.data), chunks: parsed.chunks };
  }

  /** Writes an exported save into storage (replacing `asSlotId` if it exists). Returns the slot id. */
  async importSlot(json: string, asSlotId?: string): Promise<string> {
    const { data, chunks: rawChunks } = this.previewImport(json);
    const slotId = asSlotId ?? data.meta.slotId;
    data.meta.slotId = slotId;
    const chunks = rawChunks.map((c) => ({
      ...c,
      slotId,
      delta: migrateChunk(c.delta, c.version),
      version: SAVE_VERSION,
    }));
    await this.backend.deleteSlot(slotId);
    await this.backend.commit(data, chunks, []);
    return slotId;
  }
}
