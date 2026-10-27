// MCP progress notifications (D151).
//
// A client that sends `_meta.progressToken` on `tools/call` asks for
// `notifications/progress` while the call runs. This module turns that token
// into a throttled, monotonic {@link ProgressSink}, and counts a tool call's
// Jira requests into it — every page of a `searchPages`/`fetchAll` walk, every
// GET of a delete plan, every attachment download goes through `ctx.jira`, so
// one seam reports all of them without a parameter threaded through the api
// ring (no AsyncLocalStorage either: the sink is injected per call, D106).
//
// Layering: mcp ring. Time comes only from the injected `Clock`.

import type { Clock, JiraRequestFn } from '../core/types.js';
import type { ProgressSink, ProgressUpdate } from './types.js';

/** A `notifications/progress` message as the SDK's `sendNotification` takes it. */
export interface ProgressNotification {
  readonly method: 'notifications/progress';
  readonly params: {
    readonly progressToken: string | number;
    readonly progress: number;
    readonly total?: number;
    readonly message?: string;
  };
}

/**
 * Minimum gap between two notifications of one call. A long page walk would
 * otherwise send one message per page — noise for the client and the
 * transport.
 */
export const PROGRESS_MIN_INTERVAL_MS = 250;

export interface ThrottledProgress {
  readonly sink: ProgressSink;
  /** Send the newest update the throttle held back, if any (end of the call). */
  flush(): void;
}

/**
 * Turn a call's `progressToken` into a throttled sink.
 *
 * - Progress must increase (MCP spec): a value not above the last one sent or
 *   held is dropped, so a report can never go backwards.
 * - At most one notification per `minIntervalMs`; an update that completes
 *   the work (`progress >= total`) is sent at once. The newest update held
 *   back is sent by `flush()`, which the server calls when the call returns.
 * - A failing send never fails the tool call.
 */
export function createProgressSink(
  progressToken: string | number,
  send: (notification: ProgressNotification) => Promise<void>,
  clock: Pick<Clock, 'now'>,
  minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
): ThrottledProgress {
  let last = Number.NEGATIVE_INFINITY;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: ProgressUpdate | undefined;

  const emit = (update: ProgressUpdate): void => {
    lastSentAt = clock.now();
    pending = undefined;
    const notification: ProgressNotification = {
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: update.progress,
        ...(update.total === undefined ? {} : { total: update.total }),
        ...(update.message === undefined || update.message === ''
          ? {}
          : { message: update.message }),
      },
    };
    try {
      send(notification).catch(() => undefined);
    } catch {
      // A transport that throws synchronously is ignored the same way.
    }
  };

  return {
    sink: (update) => {
      if (!Number.isFinite(update.progress) || update.progress <= last) return;
      last = update.progress;
      const complete = update.total !== undefined && update.progress >= update.total;
      if (complete || clock.now() - lastSentAt >= minIntervalMs) emit(update);
      else pending = update;
    },
    flush: () => {
      if (pending !== undefined) emit(pending);
    },
  };
}

/**
 * Wrap a call's Jira seam so every settled request — answered or failed —
 * reports one more unit of progress. There is no `total`: how many pages a
 * walk takes is known only when it ends.
 */
export function countRequests(
  jira: JiraRequestFn,
  progress: ProgressSink,
): JiraRequestFn {
  let settled = 0;
  return async (req) => {
    try {
      return await jira(req);
    } finally {
      settled += 1;
      progress({
        progress: settled,
        message: `${String(settled)} Jira request(s) completed`,
      });
    }
  };
}
