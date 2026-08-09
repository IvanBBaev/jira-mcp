// The structured stderr logger — implementation of the normative log-event
// table (OBSERVABILITY.md §Log-event table).
//
// Four invariants this module owns:
//
//  1. **stderr only.** stdout is the MCP stdio protocol; one stray byte corrupts
//     the session. The sole sink here is `process.stderr`, there is no option to
//     point it elsewhere, and `no-console` [eslint] closes the other door.
//  2. **The table decides the level.** `emit` takes no level: it reads
//     `LOG_EVENT_LEVEL`, so no call site can log `server_start` at `error` or
//     downgrade `ambiguous_write` to debug.
//  3. **Redacted at the choke point.** Fields are deep-redacted BEFORE
//     serialization and the finished line is scrubbed again afterwards — the
//     second pass is what catches a secret that JSON escaping would otherwise
//     smuggle past a literal match (a token containing a quote or a backslash).
//  4. **Logging never fails its caller.** An unserializable field set degrades
//     to a `log_error` marker and a broken stderr pipe is swallowed.
//
// The correlation id lives in `AsyncLocalStorage`, so every event emitted
// anywhere inside one MCP tool call carries the same `cid` without threading a
// parameter through four rings. OBSERVABILITY.md files that storage under
// `core/request-context.ts` (the same seam as profile resolution); it lives here
// until that module exists, and moving it is a re-export, not a rewrite.

import { AsyncLocalStorage } from 'node:async_hooks';

import { systemClock } from './clock.js';
import { createRedactor } from './redact.js';
import { LOG_EVENT_LEVEL, LOG_LEVELS } from './types.js';
import type {
  Clock,
  LogEventName,
  LogFields,
  LogLevel,
  Logger,
  Redactor,
  Rng,
} from './types.js';

/** `JIRA_LOG_LEVEL` default (CONFIGURATION.md). Passed in, never read from env. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** The `cid` of events outside a tool call: startup, shutdown, doctor probes. */
export const NO_CID = '-';

/**
 * Key order of a rendered line, most-scanned first. A stable order is what makes
 * `grep`, `sort` and a support transcript diff usable at all; a test asserts it.
 */
export const LOG_LINE_KEYS = ['ts', 'level', 'event', 'cid', 'fields'] as const;

/** Marker replacing a field set that could not be serialized. */
const LOG_FIELDS_DROPPED = 'log_fields_dropped';

/** Severity rank, derived from the frozen vocabulary rather than duplicated. */
function rank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

const cidStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `cid` bound as the ambient correlation id. Every event a logger
 * emits inside — http, retry, journal, result — carries it, including from code
 * that never saw the logger that started the call.
 */
export function runWithCid<T>(cid: string, fn: () => T): T {
  return cidStore.run(cid, fn);
}

/** The ambient correlation id, or `undefined` outside a tool call. */
export function currentCid(): string | undefined {
  return cidStore.getStore();
}

/**
 * Mint a `c-4f9a01`-shaped correlation id from the injected RNG
 * (OBSERVABILITY.md §Correlation id). Six hex digits: enough to disambiguate the
 * handful of calls in one transcript, short enough to read out loud in a bug
 * report. Not a security token — the seam exists for determinism, not entropy.
 */
export function newCorrelationId(rng: Rng): string {
  const raw = rng();
  // Clamp: an out-of-contract rng returning 1 (or NaN) must not widen the id.
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON) : 0;
  return `c-${Math.floor(unit * 0x100_0000)
    .toString(16)
    .padStart(6, '0')}`;
}

export interface LoggerOptions {
  /** Minimum severity to emit; `JIRA_LOG_LEVEL`, defaulting to `info`. */
  readonly level?: LogLevel;
  /** Time source for `ts`. Defaults to the system clock. */
  readonly clock?: Clock;
  /**
   * Redaction choke point. Defaults to an EMPTY redactor, which still masks
   * credential shapes — a forgotten seam degrades to less redaction, never to a
   * pass-through.
   */
  readonly redactor?: Redactor;
  /**
   * Correlation id bound to the root logger. When omitted the logger resolves
   * the ambient id from {@link runWithCid} at emit time, falling back to
   * {@link NO_CID}. An explicit id always wins over the ambient one.
   */
  readonly cid?: string;
}

/**
 * A broken stderr pipe (`EPIPE` after the parent closed the handle) must never
 * take the server down: the line is simply lost.
 */
function writeStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    return;
  }
}

function render(
  event: LogEventName,
  level: LogLevel,
  cid: string,
  ts: number,
  fields: LogFields | undefined,
  redactor: Redactor,
): string {
  try {
    const record: Record<string, unknown> = {
      ts,
      level,
      event,
      cid: redactor.redactString(cid),
    };
    if (fields && Object.keys(fields).length > 0) {
      record.fields = redactor.redact(fields);
    }
    // The finished line goes through the redactor a second time: `redact` sees
    // the values, this sees their SERIALIZED form, which is where a secret
    // carrying a quote or a backslash would otherwise reappear unmatched.
    return redactor.redactString(JSON.stringify(record));
  } catch {
    // Circular getters, throwing accessors, an unserializable field: keep the
    // event, drop the payload. A log call never fails its caller.
    return JSON.stringify({
      ts,
      level,
      event,
      cid,
      fields: { log_error: LOG_FIELDS_DROPPED },
    });
  }
}

/**
 * Create the stderr logger.
 *
 * Every event is filtered by `LOG_EVENT_LEVEL[event]` against `options.level`,
 * stamped with the injected clock, redacted, and written as one JSON line to
 * stderr — `{"ts","level","event","cid","fields"}`, in that order, `fields`
 * omitted when empty.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minLevel = options.level ?? DEFAULT_LOG_LEVEL;
  const clock = options.clock ?? systemClock;
  const redactor = options.redactor ?? createRedactor();

  const build = (boundCid: string | undefined): Logger => ({
    emit: (event: LogEventName, fields?: LogFields): void => {
      const level = LOG_EVENT_LEVEL[event];
      if (rank(level) < rank(minLevel)) return;
      const cid = boundCid ?? currentCid() ?? NO_CID;
      writeStderr(render(event, level, cid, clock.now(), fields, redactor));
    },
    withCid: (cid: string): Logger => build(cid),
  });

  return build(options.cid);
}
