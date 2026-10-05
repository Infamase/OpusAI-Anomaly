import { SAVE_VERSION, type ChunkDelta } from './types';

/**
 * One step upgrades data from version `from` to `from + 1`.
 * Example for a future v2 that adds a "credits" field:
 *
 *   { from: 1, save: (d) => ({ ...d, player: { ...d.player, credits: 0 } }) }
 */
export interface Migration {
  from: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  save?: (data: any) => any;
  chunk?: (delta: ChunkDelta) => ChunkDelta;
}

export const MIGRATIONS: Migration[] = [
  // v2 (Module 6): worn armor. Older characters start with nothing equipped.
  { from: 1, save: (d) => ({ ...d, player: { equipment: {}, ...d.player } }) },
  // v3 (Module 8): weapons, inventory, health.
  { from: 2, save: (d) => ({ ...d, player: { inventory: [], activeWeapon: null, ...d.player } }) },
];

export class SaveVersionError extends Error {}

function steps(fromVersion: number, migrations: Migration[], target: number): Migration[] {
  if (!Number.isInteger(fromVersion) || fromVersion < 1) throw new SaveVersionError(`Invalid save version ${fromVersion}`);
  if (fromVersion > target) {
    throw new SaveVersionError(`Save is from a newer game version (v${fromVersion}, this build reads up to v${target})`);
  }
  const out: Migration[] = [];
  for (let v = fromVersion; v < target; v++) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new SaveVersionError(`No migration from save v${v} to v${v + 1}`);
    out.push(step);
  }
  return out;
}

export function migrateSave<T extends { version: number }>(
  raw: { version: number },
  migrations = MIGRATIONS,
  target = SAVE_VERSION,
): T {
  let data: { version: number } = structuredClone(raw);
  for (const step of steps(raw.version, migrations, target)) {
    if (step.save) data = step.save(data);
    data.version = step.from + 1;
  }
  return data as T;
}

export function migrateChunk(
  delta: ChunkDelta,
  version: number,
  migrations = MIGRATIONS,
  target = SAVE_VERSION,
): ChunkDelta {
  let d = delta;
  for (const step of steps(version, migrations, target)) if (step.chunk) d = step.chunk(d);
  return d;
}
