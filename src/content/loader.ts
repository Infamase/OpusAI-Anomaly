import type { ContentRegistry } from './Registry';
import { v, parseOrThrow, type Infer } from './schema';

/**
 * Loads content packs into the registry.
 *
 * Layout:  content/<packId>/pack.json      <- manifest
 *          content/<packId>/**\/*.json      <- defs (one object with "type", or an array of them)
 *
 * Packs load in dependency order. A later pack can override any def by reusing
 * its type + id — that's how expansions or mods rebalance base content without
 * editing it.
 */
export interface RawContentFile {
  path: string;
  data: unknown;
}

const manifestSchema = v.object({
  id: v.id(),
  name: v.string({ nonEmpty: true }),
  version: v.string({ nonEmpty: true }),
  dependencies: v.optional(v.array(v.id()), []),
  /** Tie-breaker for packs with no dependency relation; lower loads first. */
  priority: v.optional(v.number(), 0),
});
export type PackManifest = Infer<typeof manifestSchema>;

export interface LoadReport {
  packs: PackManifest[];
  defCount: number;
  errors: string[];
  overrides: readonly string[];
}

const PATH_RE = /(?:^|\/)content\/([^/]+)\/(.+\.json)$/;

export function loadContent(registry: ContentRegistry, files: RawContentFile[]): LoadReport {
  const errors: string[] = [];
  const manifests = new Map<string, PackManifest>();
  const filesByPack = new Map<string, RawContentFile[]>();

  for (const file of files) {
    const m = PATH_RE.exec(file.path);
    if (!m) {
      errors.push(`${file.path}: not inside content/<pack>/`);
      continue;
    }
    const [, packDir, rel] = m as unknown as [string, string, string];
    if (rel === 'pack.json') {
      try {
        const manifest = parseOrThrow(manifestSchema, file.data, file.path);
        if (manifest.id !== packDir) errors.push(`${file.path}: pack id "${manifest.id}" must match folder "${packDir}"`);
        manifests.set(packDir, manifest);
      } catch (e) {
        errors.push((e as Error).message);
      }
    } else {
      if (!filesByPack.has(packDir)) filesByPack.set(packDir, []);
      filesByPack.get(packDir)!.push(file);
    }
  }

  for (const packDir of filesByPack.keys()) {
    if (!manifests.has(packDir)) errors.push(`content/${packDir}: missing pack.json`);
  }

  const order = sortPacks([...manifests.values()], errors);
  let defCount = 0;

  for (const pack of order) {
    const packFiles = (filesByPack.get(pack.id) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    for (const file of packFiles) {
      const items = Array.isArray(file.data) ? file.data : [file.data];
      items.forEach((item, i) => {
        const where = items.length > 1 ? `${file.path}[${i}]` : file.path;
        if (typeof item !== 'object' || item === null || typeof (item as { type?: unknown }).type !== 'string') {
          errors.push(`${where}: each def needs a string "type" field`);
          return;
        }
        const { type, ...rest } = item as { type: string };
        try {
          registry.registerRaw(type, rest, { pack: pack.id, file: where });
          defCount++;
        } catch (e) {
          errors.push((e as Error).message);
        }
      });
    }
  }

  errors.push(...registry.crossCheck());
  return { packs: order, defCount, errors, overrides: registry.overrideLog };
}

/** Topological sort by dependencies, then priority, then id (deterministic). */
function sortPacks(packs: PackManifest[], errors: string[]): PackManifest[] {
  const byId = new Map(packs.map((p) => [p.id, p]));
  const result: PackManifest[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const sorted = packs.slice().sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const visit = (p: PackManifest, chain: string[]) => {
    const s = state.get(p.id);
    if (s === 'done') return;
    if (s === 'visiting') {
      errors.push(`content pack dependency cycle: ${[...chain, p.id].join(' -> ')}`);
      return;
    }
    state.set(p.id, 'visiting');
    for (const dep of p.dependencies) {
      const d = byId.get(dep);
      if (!d) errors.push(`content pack "${p.id}" depends on missing pack "${dep}"`);
      else visit(d, [...chain, p.id]);
    }
    state.set(p.id, 'done');
    result.push(p);
  };

  for (const p of sorted) visit(p, []);
  return result;
}
