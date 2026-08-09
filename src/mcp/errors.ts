// ---------------------------------------------------------------------------
// `JiraError` → `ErrorRecord` → error envelope (TOOLS.md §Error-kind catalog,
// ARCHITECTURE.md §Error model, CC-15).
//
// One error type crosses the layers (`core/types.ts`'s `JiraError`), and exactly
// one function projects it into the model-facing envelope. The projection is
// mechanical on purpose: the 13 kinds are a CLOSED vocabulary the model can
// learn, and `retryable` travels with the error rather than being re-derived at
// the call site, so "can I try again?" has one answer per error and not one per
// reader.
//
// TRUST BOUNDARY. Nothing upstream is interpolated into `message`. Jira's own
// texts are kept verbatim in `jiraMessages` (a separate array the client can
// render) and a bounded body snippet lives in `detail` — already redacted at
// construction time (CC-15). An unexpected throw carries NO detail at all: a
// stack-trace string is exactly the kind of value that smuggles a token or a URL
// into the transcript, and the real diagnosis belongs in a stderr log event
// keyed by cid, which WP-24's catch site emits.
//
// Layering: `core ← api ← mcp ← tools`.
// ---------------------------------------------------------------------------

import { isJiraError, toErrorRecord as projectJiraError } from '../core/errors.js';
import { JIRA_ERROR_KINDS, JiraError } from '../core/types.js';
import type { ErrorRecord, JiraErrorKind } from '../core/types.js';
import { err } from './result.js';
import type { EnvelopeOptions } from './result.js';
import type { ToolResult } from './types.js';

/**
 * Kind assigned to a throw that is not a `JiraError`. The catalog has no
 * `internal` kind, and `unexpected_shape` is the nearest true statement: the
 * server met something it had no model for.
 */
export const UNEXPECTED_THROW_KIND: JiraErrorKind = 'unexpected_shape';

/** Model-facing text for a non-`JiraError` throw. Promises nothing about retrying. */
export const UNEXPECTED_THROW_MESSAGE =
  'The server hit an unexpected internal error while running this tool. This is a ' +
  'bug in jira-mcp-ai, not in the request. Report it with the tool name; do not ' +
  'retry in a loop.';

/** Remediation paired with {@link UNEXPECTED_THROW_MESSAGE}. */
export const UNEXPECTED_THROW_REMEDIATION =
  'Re-run with JIRA_LOG_LEVEL=debug and report the correlation id from stderr.';

export { isJiraError } from '../core/errors.js';

/** A kind that is not in the frozen catalog cannot reach the model. */
function normalizeKind(kind: unknown): JiraErrorKind {
  return typeof kind === 'string' &&
    (JIRA_ERROR_KINDS as readonly string[]).includes(kind)
    ? (kind as JiraErrorKind)
    : UNEXPECTED_THROW_KIND;
}

/**
 * Project any thrown value onto the wire-facing error record.
 *
 * The mechanical projection lives in `core/errors.ts`; this boundary wrapper
 * adds what only the catch site can decide: a non-`JiraError` throw becomes the
 * fixed UNEXPECTED record (no detail — a stack trace is exactly the value that
 * smuggles a token into the transcript), and a structurally-valid error from
 * another realm gets its `kind` re-checked against the closed catalog so an
 * out-of-catalog string can never reach the model.
 */
export function toErrorRecord(error: unknown): ErrorRecord {
  if (!isJiraError(error)) {
    return {
      kind: UNEXPECTED_THROW_KIND,
      message: UNEXPECTED_THROW_MESSAGE,
      retryable: false,
      remediation: UNEXPECTED_THROW_REMEDIATION,
    };
  }

  const record = projectJiraError(error);
  return {
    ...record,
    kind: normalizeKind(record.kind),
    retryable: record.retryable === true,
  };
}

/**
 * The one catch-site mapping: any thrown value becomes a complete `ok: false`
 * envelope. `mcp/registry.ts` (WP-24) wraps every handler in this.
 */
export function errorResult(
  error: unknown,
  options: EnvelopeOptions = {},
): ToolResult<never> {
  return err(toErrorRecord(error), options);
}

/**
 * Build an error envelope from an explicit kind — for refusals decided locally,
 * before any request is sent (write gating, budget checks, unsupported
 * deployments). Goes through `JiraError` so the same rules apply, including the
 * default retryability that `RETRYABLE_ERROR_KINDS` assigns to the kind: an
 * omitted `retryable` inherits it rather than silently meaning `false`.
 */
export function errorResultOf(
  kind: JiraErrorKind,
  message: string,
  init: {
    readonly retryable?: boolean;
    readonly remediation?: string;
    readonly hints?: EnvelopeOptions['hints'];
  } = {},
): ToolResult<never> {
  const error = new JiraError({
    kind,
    message,
    ...(init.retryable === undefined ? {} : { retryable: init.retryable }),
    ...(init.remediation === undefined ? {} : { remediation: init.remediation }),
  });
  return errorResult(error, { hints: init.hints });
}
