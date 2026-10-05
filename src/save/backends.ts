import type { ChunkDeltaRecord, SaveData } from './types';

/**
 * Where saves physically live. The game only talks to this interface, so the
 * storage can change (IndexedDB today; cloud sync or file export later).
 */
export interface SaveBackend {
  readonly name: string;
  listSlots(): Promise<SaveData[]>;
  loadSlot(slotId: string): Promise<SaveData | undefined>;
  /** Writes the slot and changed chunks in one transaction; null delta = delete that chunk. */
  commit(data: SaveData, chunks: ChunkDeltaRecord[], deletedChunks: { worldId: string; chunkKey: string }[]): Promise<void>;
  loadWorldChunks(slotId: string, worldId: string): Promise<ChunkDeltaRecord[]>;
  deleteWorldChunks(slotId: string, worldId: string): Promise<void>;
  deleteSlot(slotId: string): Promise<void>;
}

const chunkId = (slotId: string, worldId: string, chunkKey: string) => `${slotId}\u0000${worldId}\u0000${chunkKey}`;

/** In-memory backend for tests and as a fallback when IndexedDB is unavailable (e.g. some private modes). */
export class MemoryBackend implements SaveBackend {
  readonly name = 'memory';
  private slots = new Map<string, SaveData>();
  private chunks = new Map<string, ChunkDeltaRecord>();

  async listSlots(): Promise<SaveData[]> {
    return [...this.slots.values()].map((s) => structuredClone(s));
  }

  async loadSlot(slotId: string): Promise<SaveData | undefined> {
    const s = this.slots.get(slotId);
    return s && structuredClone(s);
  }

  async commit(data: SaveData, chunks: ChunkDeltaRecord[], deleted: { worldId: string; chunkKey: string }[]): Promise<void> {
    this.slots.set(data.meta.slotId, structuredClone(data));
    for (const c of chunks) this.chunks.set(chunkId(c.slotId, c.worldId, c.chunkKey), structuredClone(c));
    for (const d of deleted) this.chunks.delete(chunkId(data.meta.slotId, d.worldId, d.chunkKey));
  }

  async loadWorldChunks(slotId: string, worldId: string): Promise<ChunkDeltaRecord[]> {
    return [...this.chunks.values()]
      .filter((c) => c.slotId === slotId && c.worldId === worldId)
      .map((c) => structuredClone(c));
  }

  async deleteWorldChunks(slotId: string, worldId: string): Promise<void> {
    for (const [k, c] of this.chunks) if (c.slotId === slotId && c.worldId === worldId) this.chunks.delete(k);
  }

  async deleteSlot(slotId: string): Promise<void> {
    this.slots.delete(slotId);
    for (const [k, c] of this.chunks) if (c.slotId === slotId) this.chunks.delete(k);
  }
}

const DB_NAME = 'stalker-future-anomaly';
const DB_VERSION = 1;
const SLOTS = 'slots';
const CHUNKS = 'chunks';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * IndexedDB layout:
 *   slots  — key: meta.slotId          value: SaveData (small: player, world recipes, flags)
 *   chunks — key: [slotId, worldId, chunkKey]  value: ChunkDeltaRecord
 * Chunks are separate so autosaving only rewrites what changed, and a world's
 * deltas can be fetched with one key-range query when the player lands there.
 */
export class IndexedDbBackend implements SaveBackend {
  readonly name = 'indexeddb';

  private constructor(private db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, dbName = DB_NAME): Promise<IndexedDbBackend> {
    const open = factory.open(dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SLOTS)) db.createObjectStore(SLOTS, { keyPath: 'meta.slotId' });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['slotId', 'worldId', 'chunkKey'] });
    };
    return new IndexedDbBackend(await req(open));
  }

  async listSlots(): Promise<SaveData[]> {
    const tx = this.db.transaction(SLOTS, 'readonly');
    return req(tx.objectStore(SLOTS).getAll() as IDBRequest<SaveData[]>);
  }

  async loadSlot(slotId: string): Promise<SaveData | undefined> {
    const tx = this.db.transaction(SLOTS, 'readonly');
    return req(tx.objectStore(SLOTS).get(slotId) as IDBRequest<SaveData | undefined>);
  }

  async commit(data: SaveData, chunks: ChunkDeltaRecord[], deleted: { worldId: string; chunkKey: string }[]): Promise<void> {
    const tx = this.db.transaction([SLOTS, CHUNKS], 'readwrite');
    tx.objectStore(SLOTS).put(data);
    const store = tx.objectStore(CHUNKS);
    for (const c of chunks) store.put(c);
    for (const d of deleted) store.delete([data.meta.slotId, d.worldId, d.chunkKey]);
    await done(tx);
  }

  async loadWorldChunks(slotId: string, worldId: string): Promise<ChunkDeltaRecord[]> {
    const tx = this.db.transaction(CHUNKS, 'readonly');
    const range = IDBKeyRange.bound([slotId, worldId, ''], [slotId, worldId, '￿']);
    return req(tx.objectStore(CHUNKS).getAll(range) as IDBRequest<ChunkDeltaRecord[]>);
  }

  async deleteWorldChunks(slotId: string, worldId: string): Promise<void> {
    const tx = this.db.transaction(CHUNKS, 'readwrite');
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([slotId, worldId, ''], [slotId, worldId, '\uffff']));
    await done(tx);
  }

  async deleteSlot(slotId: string): Promise<void> {
    const tx = this.db.transaction([SLOTS, CHUNKS], 'readwrite');
    tx.objectStore(SLOTS).delete(slotId);
    tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([slotId, '', ''], [slotId, '￿', '￿']));
    await done(tx);
  }
}

/** Prefers IndexedDB; falls back to memory (saves won't survive a reload) and says so. */
export async function openBestBackend(): Promise<{ backend: SaveBackend; warning?: string }> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB not available');
    return { backend: await IndexedDbBackend.open() };
  } catch (e) {
    return { backend: new MemoryBackend(), warning: `Saving disabled (${(e as Error).message}); progress will be lost on reload.` };
  }
}
