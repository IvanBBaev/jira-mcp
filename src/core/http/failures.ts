// How the wire tier raises: one redacting error constructor, the abort/timeout
// errors an attempt guard rejects with, and the shared remediation texts (D515).

import { JiraError } from '../types.js';
import type { JiraErrorKind, Redactor } from '../types.js';

/** Bound on the body snippet carried on `JiraError.detail` (CC-15). */
export const MAX_DETAIL_CHARS = 200;

/** A cancelled unsafe write whose outcome is unknown: bytes may have landed. */
export const WRITE_OUTCOME_UNKNOWN =
  'The write may or may not have been applied — verify the current state before sending it again.';

/**
 * A cancelled unsafe write that never reached Jira, or that Jira refused with
 * a 429: nothing to verify (CC-417).
 */
export const WRITE_NOT_APPLIED =
  'The write was not applied. Send it again if it is still needed.';

export function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

export function timeoutError(): Error {
  const err = new Error('The request timed out');
  err.name = 'TimeoutError';
  return err;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

/**
 * The fields a failure raised by this module carries.
 *
 * `remediation` is required rather than optional: a `JiraError` from the wire
 * tier that does not name the next action is a gap the compiler should catch,
 * not a runtime possibility.
 */
export interface FailInit {
  kind: JiraErrorKind;
  message: string;
  httpStatus?: number;
  jiraMessages?: readonly string[];
  retryable?: boolean;
  remediation: string;
  detail?: string;
  cause?: unknown;
}

/** The redacting error constructor {@link makeFail} returns. */
export type Fail = (init: FailInit) => JiraError;

/**
 * Bind a redactor to an error constructor, once.
 *
 * Both primitives raise through the result, and that is the point: every string
 * a `JiraError` carries out of the wire tier — message, remediation, detail, the
 * Jira messages — passes through one place that strips secrets. A second
 * construction site that reached for `new JiraError` directly would work
 * perfectly and leak the first token someone pasted into a URL.
 */
export function makeFail(redactor: Redactor | undefined): Fail {
  const clean = (text: string): string => redactor?.redactString(text) ?? text;
  return (init: FailInit): JiraError =>
    new JiraError({
      ...init,
      message: clean(init.message),
      remediation: clean(init.remediation),
      // Redact the whole body, THEN cut: a cut through a secret leaves a
      // prefix no needle matches any more (CC-238, as CC-158 in errors.ts).
      detail:
        init.detail === undefined
          ? undefined
          : clean(init.detail).slice(0, MAX_DETAIL_CHARS),
      jiraMessages: init.jiraMessages?.map((entry) => clean(entry)),
    });
}

/**
 * The one place `fetch` is taken off `globalThis`, and it is taken per hop
 * rather than per module — that late read is exactly what makes `withFetch` a
 * seam instead of a hope.
 */
export function requireFetch(fail: Fail): typeof globalThis.fetch {
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw fail({
      kind: 'config',
      message: 'This runtime has no global fetch.',
      remediation: 'Run the server on Node 22 or newer.',
    });
  }
  return fetchFn;
}
