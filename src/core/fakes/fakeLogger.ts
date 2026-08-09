// Recording {@link Logger} (test-only).
//
// Captures the structured events a unit emits instead of writing to stderr, so
// a test can assert the OBSERVABILITY.md contract directly: that a retry emits
// `http_retry`, that an ambiguous write emits `ambiguous_write` at error level,
// that no event carries a body or a header value.
//
// The level is not a parameter anywhere: it comes from `LOG_EVENT_LEVEL`, so a
// recorded event's level is the table's level by construction.

import { LOG_EVENT_LEVEL } from '../types.js';
import type { Clock, LogEvent, LogEventName, LogFields, Logger } from '../types.js';

/** A {@link Logger} that records every event it is given. */
export interface FakeLogger extends Logger {
  /** Events emitted through this logger AND its `withCid` children, in order. */
  readonly events: readonly LogEvent[];
  /** Just the events with this name. */
  eventsOf(name: LogEventName): readonly LogEvent[];
  /** Was this event emitted at least once? */
  has(name: LogEventName): boolean;
  /** Drop all recorded events. */
  clear(): void;
}

export interface FakeLoggerOptions {
  /** Correlation id for the root logger; defaults to `-`, as at startup. */
  readonly cid?: string;
  /**
   * Source of `LogEvent.ts`. Optional because most assertions are about names
   * and fields; without it every event is stamped `ts: 0` rather than reaching
   * for the wall clock (which is banned outside `core/clock.ts` [eslint]).
   */
  readonly clock?: Clock;
}

/**
 * Create a recording logger. Children created with `withCid` share the parent's
 * event array, so one assertion sees the whole call — the per-call child logger
 * is exactly what the code under test uses.
 */
export function createFakeLogger(options: FakeLoggerOptions = {}): FakeLogger {
  const events: LogEvent[] = [];
  const { clock } = options;

  const build = (cid: string): FakeLogger => ({
    events,
    emit: (event: LogEventName, fields?: LogFields): void => {
      events.push({
        event,
        level: LOG_EVENT_LEVEL[event],
        cid,
        ts: clock ? clock.now() : 0,
        fields,
      });
    },
    withCid: (nextCid: string): Logger => build(nextCid),
    eventsOf: (name: LogEventName): readonly LogEvent[] =>
      events.filter((e) => e.event === name),
    has: (name: LogEventName): boolean => events.some((e) => e.event === name),
    clear: (): void => {
      events.length = 0;
    },
  });

  return build(options.cid ?? '-');
}
