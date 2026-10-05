import { parseOrThrow, type Validator } from './schema';

/**
 * Maps content type name -> definition type. Each content type module adds
 * itself here via declaration merging:
 *
 *   declare module '../Registry' { interface ContentMap { race: RaceDef } }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ContentMap {}
export type ContentType = keyof ContentMap & string;

export interface ContentOrigin {
  pack: string;
  file: string;
}

export interface CrossCheckContext {
  registry: ContentRegistry;
  /** Reports an error if `id` is not a registered def of `type`. */
  ref(type: ContentType, id: string, where: string): void;
  error(message: string): void;
}

export interface ContentTypeSpec<K extends ContentType = ContentType> {
  type: K;
  /** Validates one def (the JSON object minus its "type" field). */
  schema: Validator<ContentMap[K]>;
  /** Checks references to other content after everything is loaded. */
  crossCheck?(def: ContentMap[K], ctx: CrossCheckContext): void;
}

interface Entry {
  def: { id: string };
  origin: ContentOrigin;
}

export class ContentRegistry {
  private specs = new Map<string, ContentTypeSpec>();
  private entries = new Map<string, Map<string, Entry>>();
  private overrides: string[] = [];

  defineType<K extends ContentType>(spec: ContentTypeSpec<K>): void {
    if (this.specs.has(spec.type)) throw new Error(`Content type "${spec.type}" defined twice`);
    this.specs.set(spec.type, spec as unknown as ContentTypeSpec);
    this.entries.set(spec.type, new Map());
  }

  get types(): string[] {
    return [...this.specs.keys()];
  }

  hasType(type: string): boolean {
    return this.specs.has(type);
  }

  /** Validates and registers raw JSON. A later pack may override an earlier def with the same id. */
  registerRaw(type: string, raw: unknown, origin: ContentOrigin): void {
    const spec = this.specs.get(type);
    if (!spec) throw new Error(`${origin.file}: unknown content type "${type}"`);
    const label = `${origin.file} (${type})`;
    const def = parseOrThrow(spec.schema, raw, label) as { id: string };
    const bucket = this.entries.get(type)!;
    const existing = bucket.get(def.id);
    if (existing) {
      if (existing.origin.pack === origin.pack) {
        throw new Error(`${origin.file}: duplicate ${type} "${def.id}" (also in ${existing.origin.file})`);
      }
      this.overrides.push(`${type}:${def.id} from pack "${existing.origin.pack}" overridden by "${origin.pack}"`);
    }
    bucket.set(def.id, { def, origin });
  }

  register<K extends ContentType>(type: K, def: ContentMap[K], origin: ContentOrigin): void {
    this.registerRaw(type, def, origin);
  }

  get<K extends ContentType>(type: K, id: string): ContentMap[K] {
    const entry = this.entries.get(type)?.get(id);
    if (!entry) throw new Error(`Unknown ${type} "${id}"`);
    return entry.def as ContentMap[K];
  }

  tryGet<K extends ContentType>(type: K, id: string): ContentMap[K] | undefined {
    return this.entries.get(type)?.get(id)?.def as ContentMap[K] | undefined;
  }

  has(type: ContentType, id: string): boolean {
    return this.entries.get(type)?.has(id) ?? false;
  }

  all<K extends ContentType>(type: K): ContentMap[K][] {
    return [...(this.entries.get(type)?.values() ?? [])].map((e) => e.def as ContentMap[K]);
  }

  ids(type: ContentType): string[] {
    return [...(this.entries.get(type)?.keys() ?? [])];
  }

  origin(type: ContentType, id: string): ContentOrigin | undefined {
    return this.entries.get(type)?.get(id)?.origin;
  }

  get overrideLog(): readonly string[] {
    return this.overrides;
  }

  /** Runs every type's crossCheck. Returns all problems (empty = healthy). */
  crossCheck(): string[] {
    const errors: string[] = [];
    for (const [type, spec] of this.specs) {
      if (!spec.crossCheck) continue;
      for (const { def, origin } of this.entries.get(type)!.values()) {
        const prefix = `${origin.file} (${type} "${def.id}")`;
        const ctx: CrossCheckContext = {
          registry: this,
          ref: (refType, id, where) => {
            if (!this.has(refType, id)) errors.push(`${prefix}: ${where} references unknown ${refType} "${id}"`);
          },
          error: (message) => errors.push(`${prefix}: ${message}`),
        };
        spec.crossCheck(def as never, ctx);
      }
    }
    return errors;
  }
}
