/**
 * Tiny runtime validator for content files. Each validator checks a value,
 * pushes readable errors (with the JSON path) and returns the typed result.
 * `Infer<typeof schema>` gives the TypeScript type, so the data file format and
 * the code type can never drift apart.
 */
export type Validator<T> = (value: unknown, path: string, errors: string[]) => T;
export type Infer<V> = V extends Validator<infer T> ? T : never;

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export const v = {
  string(opts: { nonEmpty?: boolean; pattern?: RegExp } = {}): Validator<string> {
    return (val, path, errors) => {
      if (typeof val !== 'string') {
        errors.push(`${path}: expected string, got ${typeName(val)}`);
        return '';
      }
      if (opts.nonEmpty && val.length === 0) errors.push(`${path}: must not be empty`);
      if (opts.pattern && !opts.pattern.test(val)) errors.push(`${path}: "${val}" does not match ${opts.pattern}`);
      return val;
    };
  },

  /** Content ids: lowercase snake_case, e.g. "lizardman", "metal_floor". */
  id(): Validator<string> {
    return v.string({ pattern: /^[a-z][a-z0-9_]*$/ });
  },

  number(opts: { min?: number; max?: number; int?: boolean } = {}): Validator<number> {
    return (val, path, errors) => {
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        errors.push(`${path}: expected number, got ${typeName(val)}`);
        return 0;
      }
      if (opts.int && !Number.isInteger(val)) errors.push(`${path}: expected integer, got ${val}`);
      if (opts.min !== undefined && val < opts.min) errors.push(`${path}: ${val} < min ${opts.min}`);
      if (opts.max !== undefined && val > opts.max) errors.push(`${path}: ${val} > max ${opts.max}`);
      return val;
    };
  },

  boolean(): Validator<boolean> {
    return (val, path, errors) => {
      if (typeof val !== 'boolean') {
        errors.push(`${path}: expected boolean, got ${typeName(val)}`);
        return false;
      }
      return val;
    };
  },

  /** "#rrggbb" hex color. */
  color(): Validator<string> {
    return v.string({ pattern: /^#[0-9a-fA-F]{6}$/ });
  },

  literal<const T extends string>(...options: T[]): Validator<T> {
    return (val, path, errors) => {
      if (typeof val !== 'string' || !(options as string[]).includes(val)) {
        errors.push(`${path}: expected one of ${options.join(' | ')}, got ${JSON.stringify(val)}`);
        return options[0]!;
      }
      return val as T;
    };
  },

  optional<T, D extends T | undefined = undefined>(inner: Validator<T>, fallback?: D): Validator<T | D> {
    return (val, path, errors) => (val === undefined ? (fallback as D) : inner(val, path, errors));
  },

  array<T>(item: Validator<T>, opts: { min?: number } = {}): Validator<T[]> {
    return (val, path, errors) => {
      if (!Array.isArray(val)) {
        errors.push(`${path}: expected array, got ${typeName(val)}`);
        return [];
      }
      if (opts.min !== undefined && val.length < opts.min) errors.push(`${path}: needs at least ${opts.min} entries`);
      return val.map((x, i) => item(x, `${path}[${i}]`, errors));
    };
  },

  tuple2<A, B>(a: Validator<A>, b: Validator<B>): Validator<[A, B]> {
    return (val, path, errors) => {
      if (!Array.isArray(val) || val.length !== 2) {
        errors.push(`${path}: expected [a, b]`);
        return [a(undefined, path, []), b(undefined, path, [])];
      }
      return [a(val[0], `${path}[0]`, errors), b(val[1], `${path}[1]`, errors)];
    };
  },

  record<T>(item: Validator<T>): Validator<Record<string, T>> {
    return (val, path, errors) => {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        errors.push(`${path}: expected object, got ${typeName(val)}`);
        return {};
      }
      const out: Record<string, T> = {};
      for (const [k, x] of Object.entries(val)) out[k] = item(x, `${path}.${k}`, errors);
      return out;
    };
  },

  /** Free-form JSON passed through untouched (validated later by its consumer). */
  any(): Validator<unknown> {
    return (val) => val;
  },

  object<S extends Record<string, Validator<unknown>>>(
    shape: S,
    opts: { allowUnknown?: boolean } = {},
  ): Validator<{ [K in keyof S]: Infer<S[K]> }> {
    return (val, path, errors) => {
      const out = {} as { [K in keyof S]: Infer<S[K]> };
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        errors.push(`${path}: expected object, got ${typeName(val)}`);
        return out;
      }
      const obj = val as Record<string, unknown>;
      for (const key of Object.keys(shape) as (keyof S & string)[]) {
        out[key] = shape[key]!(obj[key], `${path}.${key}`, errors) as Infer<S[typeof key]>;
      }
      if (!opts.allowUnknown) {
        for (const key of Object.keys(obj)) {
          if (!(key in shape)) errors.push(`${path}: unknown field "${key}" (typo?)`);
        }
      }
      return out;
    };
  },
};

/** Runs a validator and throws one error listing every problem found. */
export function parseOrThrow<T>(validator: Validator<T>, value: unknown, label: string): T {
  const errors: string[] = [];
  const result = validator(value, label, errors);
  if (errors.length) throw new Error(`Invalid ${label}:\n  ${errors.join('\n  ')}`);
  return result;
}
