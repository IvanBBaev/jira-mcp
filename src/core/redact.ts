// The single secret-stripping choke point (ARCHITECTURE.md §Cross-cutting seams,
// THREAT-MODEL.md §Credentials). Everything that leaves the process — log lines,
// `JiraError` messages, plan-mode request captures, journal lines — passes
// through a {@link Redactor} before serialization, so a token cannot surface
// even through a bug at the call site.
//
// Two layers, in this order:
//
//  1. **Registered values** — the API token, the HTTP transport token and every
//     profile token are registered at startup (AUTH.md: exhaustive registration
//     is a requirement, not an optimisation). Each is matched not only raw but
//     also in its JSON-escaped and percent-encoded forms, because the sink that
//     matters is a JSON line and a URL query string: a secret containing a quote
//     or a `+` reaches stderr escaped, and a literal-only match would sail past
//     it.
//  2. **Credential shapes** — `Authorization` echoes, bare `Basic`/`Bearer`
//     credentials and token-bearing query parameters (`os_authType`, `token`,
//     `api_token`, …) are masked by SHAPE, with no registration at all. This is
//     the backstop for the credential nobody remembered to register.
//
// Scope is SECRETS, not PII: accountIds, display names and issue text are
// workspace data the model needs (THREAT-MODEL.md §Redaction scope). Minimising
// those is the shaping contract in TOOLS.md, a different concern with a
// different owner.
//
// The module never throws: it is the last thing that runs before bytes hit a
// sink, and a redactor that can fail is a redactor that gets bypassed.

import type { Redactor, RedactorConfig } from './types.js';

/** Default stand-in written over anything redacted. */
export const DEFAULT_PLACEHOLDER = '[REDACTED]';

/** Marker for a value already visited on the current path. */
const CIRCULAR = '[CIRCULAR]';

/** Marker for a structure deeper than {@link MAX_DEPTH}. */
const TOO_DEEP = '[MAX_DEPTH]';

/**
 * Structures deeper than this are denied wholesale rather than walked.
 *
 * The cap exists for STACK safety on hostile input — cycles are already caught
 * by the visited set, and total size is bounded elsewhere (`JIRA_MAX_RESULT_CHARS`
 * for results, the field set for logs). It must not be tuned as if this walker
 * only saw log fields: `mcp/result.ts` runs the redactor over every tool RESULT
 * and every planned body, where replacing a subtree with a marker is not
 * defence, it is data corruption. The deepest thing this server legitimately
 * carries is an ADF document (`api/adf.ts` §MAX_NODE_DEPTH = 64) nested under a
 * result envelope, so the bound is twice that and still far below any recursion
 * limit.
 */
export const MAX_DEPTH = 128;

/**
 * `Authorization: Basic …` / `"authorization": "Bearer …"` / `Cookie: …`
 * echoes. The header name and the auth scheme survive — knowing that a request
 * carried Basic auth is diagnostic, the credential after it never is.
 */
const AUTH_HEADER_RE =
  /\b(authorization|proxy-authorization|cookie|set-cookie)(["']?\s*[:=]\s*["']?)((?:basic|bearer|digest)\s+)?([^\s"',;]+)/gi;

/** A bare `Basic <blob>` / `Bearer <token>` anywhere, header name or not. */
const AUTH_SCHEME_RE = /\b(basic|bearer)(\s+)([A-Za-z0-9\-._~+/=]{8,})/gi;

/**
 * Query/form parameters whose value is a credential wherever it appears.
 * `os_authType`/`os_username`/`os_password` are Atlassian's own URL-auth
 * parameters, named explicitly in ARCHITECTURE.md. Jira's `key`/`id`/`jql`
 * parameters are deliberately absent: they are workspace data, not secrets.
 */
const SENSITIVE_PARAM_RE =
  /(^|[?&;\s])(os_authtype|os_username|os_password|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|token|secret|jwt|jsessionid)(=)([^&\s"'#]*)/gi;

/** Own `Error` properties handled explicitly (or dropped, for `stack`). */
const ERROR_INTRINSIC_KEYS: ReadonlySet<string> = new Set(['name', 'message', 'stack']);

/** Stand-in for a property whose getter threw while it was being read. */
const UNREADABLE = '[UNREADABLE]';

/**
 * Own enumerable entries, where reading a property can never throw. A getter
 * that throws is a real shape (proxies, ORM models, lazily-parsed bodies) and
 * this module runs on the way to a sink, where an exception would take down the
 * caller rather than the log line.
 */
function safeEntries(object: object): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const key of Object.keys(object)) {
    try {
      out.push([key, (object as Record<string, unknown>)[key]]);
    } catch {
      out.push([key, UNREADABLE]);
    }
  }
  return out;
}

/** Read a string-ish property defensively; a throwing getter yields `''`. */
function safeString(object: object, key: string): string {
  try {
    const value: unknown = (object as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return UNREADABLE;
  }
}

/**
 * Mask credential SHAPES in free text without any registered secret. Exported
 * because `core/errors.ts` needs a floor of protection for the case where no
 * redactor was injected — a missing seam must degrade to less redaction, never
 * to none.
 *
 * Idempotent: the placeholder is not itself a credential shape, so re-running
 * this over its own output changes nothing.
 */
export function stripCredentialShapes(
  text: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): string {
  return text
    .replace(
      AUTH_HEADER_RE,
      (_match, name: string, separator: string, scheme: string | undefined) =>
        `${name}${separator}${scheme ?? ''}${placeholder}`,
    )
    .replace(
      AUTH_SCHEME_RE,
      (_match, scheme: string, gap: string) => `${scheme}${gap}${placeholder}`,
    )
    .replace(
      SENSITIVE_PARAM_RE,
      (_match, prefix: string, name: string, eq: string) =>
        `${prefix}${name}${eq}${placeholder}`,
    );
}

/**
 * Every literal form a secret can take on the way to a sink: raw, JSON-escaped
 * (what `JSON.stringify` writes into a log line) and percent-encoded (what a
 * query string carries). Duplicates are dropped, so an ASCII-only token costs
 * exactly one comparison.
 */
function literalVariants(secret: string): string[] {
  const variants = [secret];
  const jsonBody = JSON.stringify(secret).slice(1, -1);
  if (jsonBody !== secret) variants.push(jsonBody);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret && !variants.includes(encoded)) variants.push(encoded);
  return variants;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Create the redaction choke point.
 *
 * `secrets` are the values known at startup; `addSecret` registers the ones
 * discovered later (a profile token resolved on first use). An empty string is
 * ignored — it would match between every character and blank the output, which
 * is a broken log, not a safe one.
 */
export function createRedactor(config: RedactorConfig = {}): Redactor {
  const placeholder = config.placeholder ?? DEFAULT_PLACEHOLDER;
  const registered = new Set<string>();
  /** Literal needles, longest first: a longer secret must win over its prefix. */
  let needles: string[] = [];

  const rebuild = (): void => {
    const all = new Set<string>();
    for (const secret of registered) {
      for (const variant of literalVariants(secret)) all.add(variant);
    }
    needles = [...all].sort((a, b) => b.length - a.length);
  };

  const addSecret = (value: string): void => {
    if (value === '' || registered.has(value)) return;
    registered.add(value);
    rebuild();
  };

  for (const secret of config.secrets ?? []) addSecret(secret);

  // `replaceAll` with a STRING pattern is a literal replace: no escaping, and a
  // secret full of regex metacharacters cannot turn into a pattern that eats the
  // rest of the line.
  const scrub = (text: string): string => {
    let out = text;
    for (const needle of needles) out = out.replaceAll(needle, placeholder);
    return stripCredentialShapes(out, placeholder);
  };

  const walk = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (value === null || value === undefined) return value;

    switch (typeof value) {
      case 'string':
        return scrub(value);
      case 'number':
      case 'boolean':
        return value;
      case 'bigint':
        // JSON.stringify throws on a bigint; a log line must not be the place
        // that discovers it.
        return value.toString();
      case 'object':
        break;
      default:
        // function / symbol — never serializable, never useful in a log line.
        return placeholder;
    }

    const object: object = value;
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    if (seen.has(object)) return CIRCULAR;

    if (object instanceof Date) return new Date(object.getTime());

    seen.add(object);
    try {
      if (Array.isArray(object)) {
        return (object as unknown[]).map((item) => walk(item, depth + 1, seen));
      }

      if (object instanceof Error) {
        const out: Record<string, unknown> = {
          name: scrub(safeString(object, 'name')),
          message: scrub(safeString(object, 'message')),
        };
        // Own enumerable extras carry the `JiraError` fields (kind, httpStatus,
        // remediation…). `stack` is dropped on purpose: it is file paths and
        // internals, and log events are metadata-only (OBSERVABILITY.md).
        for (const [key, item] of safeEntries(object)) {
          if (ERROR_INTRINSIC_KEYS.has(key)) continue;
          out[scrub(key)] = walk(item, depth + 1, seen);
        }
        return out;
      }

      if (!isPlainObject(object)) {
        // Maps, Sets, buffers, streams, class instances: not guaranteed
        // serializable and not guaranteed free of credentials. Denied whole.
        return placeholder;
      }

      const out: Record<string, unknown> = {};
      for (const [key, item] of safeEntries(object)) {
        // The KEY is scrubbed too — a secret used as a property name leaks
        // exactly as loudly as one used as a value.
        out[scrub(key)] = walk(item, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(object);
    }
  };

  return {
    redact: (value: unknown): unknown => walk(value, 0, new Set<object>()),
    redactString: (text: string): string => scrub(text),
    addSecret,
  };
}
