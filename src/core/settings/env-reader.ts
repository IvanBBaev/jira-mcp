// The typed knob readers every section uses (D516). Each one reads a single
// variable, reports a malformed value as an ERROR finding and substitutes the
// documented default so `Settings` stays complete for the report path.

import type { Add } from './report.js';

/** Truthy/falsy spellings accepted for boolean knobs. */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** The knob readers over one environment, reporting into one sink. */
export interface EnvReader {
  /** The trimmed value, or `undefined` when unset or blank. */
  readonly str: (key: string) => string | undefined;
  /** A comma list, lower-cased, empty parts dropped. */
  readonly csv: (key: string) => readonly string[];
  readonly int: (key: string, def: number, min: number, max: number) => number;
  readonly enumOf: <T extends string>(key: string, allowed: readonly T[], def: T) => T;
  readonly bool: (key: string, def: boolean) => boolean;
  readonly httpsOrigin: (key: string, def: string) => string;
}

/**
 * An https origin and nothing else: scheme, host, optional port. Returns the
 * normalised origin, or `undefined` when the value is not one.
 *
 * Rejecting a path, query, fragment or embedded credentials is not pedantry.
 * These two variables are where the OAuth flow sends the client secret and
 * where it fetches tokens from, so a value that carries anything beyond an
 * origin is either a typo or somebody's redirect target; `URL` would happily
 * accept it and the extra part would be silently dropped when the flow
 * concatenates its own paths. `https` only, for the same reason.
 */
function parseHttpsOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  return url.origin;
}

/** The hostname of an already-validated origin, for the egress allowlist. */
export function originHost(origin: string): string {
  return new URL(origin).hostname;
}

/** Build the {@link EnvReader} for `env`, reporting into `add`. */
export function createEnvReader(env: NodeJS.ProcessEnv, add: Add): EnvReader {
  const str = (key: string): string | undefined => {
    const value = env[key];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const csv = (key: string): readonly string[] => {
    const raw = str(key);
    if (raw === undefined) return [];
    return raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
  };

  /**
   * Integer knob. An unparseable or out-of-range value is an ERROR finding, not
   * a silent fallback: a typo in a timeout must fail startup, not quietly
   * change behaviour. The default is still substituted so `Settings` stays
   * complete for the report path.
   */
  const int = (key: string, def: number, min: number, max: number): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    // Plain decimal digits only: `Number` would also take `0x0D06`, `3e4` and
    // `4.0`, none of which the documentation promises (CC-141).
    const parsed = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      add({
        severity: 'error',
        code: 'invalid_number',
        message: `${key} must be an integer in [${String(min)}, ${String(max)}]; got ${JSON.stringify(raw)}. Startup uses the documented default ${String(def)} only to finish the report.`,
        field: key,
      });
      return def;
    }
    return parsed;
  };

  const enumOf = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const raw = str(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase();
    const match = allowed.find((candidate) => candidate === lower);
    if (match === undefined) {
      add({
        severity: 'error',
        code: 'invalid_enum',
        message: `${key} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(raw)}. Using the documented default ${def}.`,
        field: key,
      });
      return def;
    }
    return match;
  };

  const bool = (key: string, def: boolean): boolean => {
    const raw = str(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase();
    if (TRUE_VALUES.has(lower)) return true;
    if (FALSE_VALUES.has(lower)) return false;
    add({
      severity: 'error',
      code: 'invalid_boolean',
      message: `${key} must be one of 1|true|yes|on|0|false|no|off; got ${JSON.stringify(raw)}. Using the default ${String(def)}.`,
      field: key,
    });
    return def;
  };

  /**
   * An https origin knob. Same contract as {@link int}: a bad value is an ERROR
   * finding and the documented default is substituted so the report can finish.
   */
  const httpsOrigin = (key: string, def: string): string => {
    const raw = str(key);
    if (raw === undefined) return def;
    const parsed = parseHttpsOrigin(raw);
    if (parsed === undefined) {
      add({
        severity: 'error',
        code: 'invalid_origin',
        // The value is echoed with any userinfo masked: a password pasted into
        // the origin must not reach the report (CC-140). The mask runs to the
        // LAST `@` before any query or fragment, because a password may itself
        // hold an `@` or a `/` (CC-185). It is anchored at the start rather than
        // at `//`: `https:u:pw@h`, `https:/u:pw@h` and `https:\\u:pw@h` are just
        // as bad an origin, and only an http(s) scheme is kept in the echo
        // (CC-408).
        message: `${key} must be an https origin with no path, query, fragment or credentials (e.g. ${def}); got ${JSON.stringify(raw.replace(/^((?:https?:)?[\\/]*)[^?#]*@/i, '$1***@'))}. Using the documented default ${def}.`,
        field: key,
      });
      return def;
    }
    return parsed;
  };

  return { str, csv, int, enumOf, bool, httpsOrigin };
}
