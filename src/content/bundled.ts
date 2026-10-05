import type { RawContentFile } from './loader';

/**
 * All JSON under /content is bundled at build time. Dropping a new file into a
 * pack folder registers it automatically — no code changes needed.
 */
const modules = import.meta.glob<unknown>('/content/**/*.json', { eager: true, import: 'default' });

export const bundledContentFiles: RawContentFile[] = Object.entries(modules).map(([path, data]) => ({ path, data }));
