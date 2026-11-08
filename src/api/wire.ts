// ---------------------------------------------------------------------------
// api/wire.ts — the request and failure helpers the api modules share.
//
// Before V3-56 each api module carried its own `send`/`sendOne`,
// `writeControls`, `runClassic`, `shapeError`, `requireRecord`,
// `requireField` and `requireText`, and the copies had drifted (TSN-05). The
// differences that callers rely on are kept, but as explicit variants or
// parameters here, never as copies:
//
//   * `send` lets the caller's options win over the spec and omits absent
//     controls; `sendOne` lets the spec win and always sets both keys.
//   * `shapeError` takes an optional remediation; `responseShapeError` is the
//     "Jira's <domain> response could not be read" wording without one.
//   * `requireRecord` and `requireText` take the failure wording as an
//     optional argument; the default is the most common one.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import type {
  JiraError,
  JiraRequestFn,
  JiraRequestSpec,
  JiraResponse,
} from '../core/types.js';
import { asRecord } from './guards.js';
import {
  budgetOf,
  fetchAll,
  type BudgetGuard,
  type ClassicCursor,
  type ClassicLoopResult,
  type ClassicPage,
} from './shared.js';

/** The remediation every "Jira returned an unexpected shape" error carries. */
export const SHAPE_REMEDIATION =
  'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).';

/** The request controls an api call forwards to every request it sends. */
export interface WireControls {
  readonly signal?: AbortSignal | undefined;
  readonly deadlineAt?: number | undefined;
}

/** The options every api call carries: the wire plus its controls. */
export interface WireOptions extends WireControls {
  readonly jira: JiraRequestFn;
}

/** The paging controls of a classic (`startAt`/`maxResults`) read. */
export interface ClassicRunOptions {
  readonly jira: JiraRequestFn;
  readonly signal?: AbortSignal | undefined;
  readonly pageSize?: number | undefined;
  readonly maxPages?: number | undefined;
  readonly startAt?: number | undefined;
}

// ---------------------------------------------------------------------------
// 1. Sending
// ---------------------------------------------------------------------------

/** The caller's cancellation and deadline, with absent keys left out. */
export function writeControls(
  options: WireControls,
): Pick<JiraRequestSpec, 'signal' | 'deadlineAt'> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
}

/** Send a spec with the caller's controls stamped over it (options win). */
export function send(options: WireOptions, spec: JiraRequestSpec): Promise<JiraResponse> {
  return options.jira({ ...spec, ...writeControls(options) });
}

/** Send a spec, filling in the caller's controls the spec did not set (spec wins). */
export function sendOne(
  options: WireOptions,
  spec: JiraRequestSpec,
): Promise<JiraResponse<unknown>> {
  return options.jira({
    ...spec,
    signal: spec.signal ?? options.signal,
    deadlineAt: spec.deadlineAt ?? options.deadlineAt,
  });
}

/** Drive one classic paginated read through {@link fetchAll}. */
export function runClassic<T>(
  options: ClassicRunOptions & BudgetGuard,
  defaultPageSize: number,
  request: (cursor: ClassicCursor) => JiraRequestSpec,
  readPage: (response: JiraResponse) => ClassicPage<T>,
): Promise<ClassicLoopResult<T>> {
  const base = {
    jira: options.jira,
    request,
    readPage,
    pageSize: options.pageSize ?? defaultPageSize,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
  };
  // Narrowed through a plain `BudgetGuard` binding so the discriminant is read
  // off the union itself, not off an intersection TS may not distribute.
  const guard: BudgetGuard = options;
  return fetchAll<T>({ ...base, ...budgetOf(guard) });
}

// ---------------------------------------------------------------------------
// 2. Failures
// ---------------------------------------------------------------------------

/** An `unexpected_shape` error with `reason`, and `remediation` when given. */
export function shapeError(reason: string, remediation?: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason,
    ...(remediation === undefined ? {} : { remediation }),
  });
}

/** `Jira's <domain> response could not be read: <what>.`, without a remediation. */
export function responseShapeError(domain: string, what: string): JiraError {
  return shapeError(`Jira's ${domain} response could not be read: ${what}.`);
}

/** The default {@link requireRecord} failure: "Jira returned a <what> that is not…". */
function notAJsonObject(what: string): JiraError {
  return shapeError(
    `Jira returned a ${what} that is not a JSON object.`,
    SHAPE_REMEDIATION,
  );
}

/** `value` as a JSON object, or throw `fail(what)`. */
export function requireRecord(
  value: unknown,
  what: string,
  fail: (what: string) => JiraError = notAJsonObject,
): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw fail(what);
  return record;
}

/** A field a reader found, or an `unexpected_shape` error naming it. */
export function requireField(
  value: string | undefined,
  field: string,
  what: string,
): string {
  if (value === undefined) {
    throw shapeError(
      `Jira returned a ${what} without a usable "${field}".`,
      SHAPE_REMEDIATION,
    );
  }
  return value;
}

/** The default {@link requireText} reason. */
function requiredText(what: string): string {
  return `A ${what} is required and must not be empty.`;
}

/**
 * The trimmed text, or a `validation` error when it is blank. `blank` words
 * the reason; `remediation` is attached when given.
 */
export function requireText(
  value: string,
  what: string,
  remediation?: string,
  blank: (what: string) => string = requiredText,
): string {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (clean === '') {
    throw createJiraError({
      kind: 'validation',
      reason: blank(what),
      ...(remediation === undefined ? {} : { remediation }),
    });
  }
  return clean;
}

/** The write-side reason: the blank value stopped the call before the wire. */
function requiredNothingSent(what: string): string {
  return `A ${what} is required and must not be empty. Nothing was sent.`;
}

/** {@link requireText} for a write input: the reason says nothing was sent. */
export function requireWriteText(
  value: string,
  what: string,
  remediation: string,
): string {
  return requireText(value, what, remediation, requiredNothingSent);
}
