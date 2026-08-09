// Error construction and classification — the implementation half of
// ARCHITECTURE.md §Error model and the thirteen-kind catalog of TOOLS.md
// §Error-kind catalog (frozen as `JIRA_ERROR_KINDS`).
//
// Three jobs:
//
//  1. **Read Jira's three error shapes.** Jira is inconsistent (JIRA-API.md
//     §Error response shapes): `errorMessages: string[]`, `errors: { field:
//     message }`, `message: string`, and — behind a proxy or a gateway — no JSON
//     at all. The extractor reads them in that order and falls back to the
//     status text.
//  2. **Map status → kind.** One table, with the two documented deviations:
//     a 404 is "absent OR invisible" because Jira 404s what you may not see
//     (CC-16), and a 403 carrying Jira's login-denied headers is an auth
//     failure, not a permission one (CC-18).
//  3. **Say what to do next.** Every kind has remediation text: the model reads
//     it, and for `ambiguous_write` it is the difference between verifying state
//     and silently duplicating a write.
//
// Log-safety: a raw response body NEVER reaches `message`. The single exception
// is CC-15 — a non-JSON body contributes a bounded (≤ 200 char), redacted
// snippet, and it lives in `detail` on the error, not in a log event
// (OBSERVABILITY.md §Never-log list).
//
// Redaction is applied HERE, at construction: the frozen `JiraError` constructor
// only copies fields, so an error built with `new JiraError(...)` directly
// bypasses the choke point. Everything in the server builds errors through this
// module.

import { stripCredentialShapes } from './redact.js';
import { JIRA_ERROR_KINDS, JiraError } from './types.js';
import type {
  ErrorRecord,
  HttpMethod,
  JiraApiRoot,
  JiraErrorKind,
  JiraResponseHeaders,
  Redactor,
} from './types.js';

/** CC-15: longest non-JSON body snippet carried in `JiraError.detail`. */
export const NON_JSON_DETAIL_MAX = 200;

/** Longest slice of Jira's own messages embedded in `JiraError.message`. */
export const MESSAGE_DETAIL_MAX = 300;

/**
 * What the caller should do next, per kind. Cause comes from the wire; this is
 * the recovery half of every message, and the text a model acts on.
 */
export const REMEDIATION: Readonly<Record<JiraErrorKind, string>> = Object.freeze({
  config:
    'Fix the server configuration and restart: JIRA_SITE, JIRA_EMAIL and ' +
    'JIRA_API_TOKEN must all be set and consistent. Run the doctor command to see ' +
    'every configuration problem at once.',
  auth:
    'Check that JIRA_EMAIL is the account that owns JIRA_API_TOKEN and that the ' +
    'token is still valid — Atlassian Cloud API tokens expire (a year at most) and ' +
    'a revoked token fails identically. Issue a new token and restart the server.',
  permission:
    'The credentials are valid but the account lacks permission for this resource. ' +
    'Ask a Jira administrator for the required project or global permission, or use ' +
    'an account that already has it; repeating the call unchanged will fail again.',
  not_found:
    'Jira answers 404 both for a resource that does not exist and for one this ' +
    'account may not see, so treat it as "not found OR no permission". Confirm the ' +
    'key or id (jira_search) and that the account can browse the project.',
  validation:
    'Jira rejected the request as invalid. Correct the fields or the JQL — ' +
    'jira_list_fields and jira_get_create_meta report what this instance accepts — ' +
    'and send a corrected request; an unchanged retry fails identically.',
  rate_limited:
    'Jira rate-limited this call and the automatic retry budget is spent. Wait ' +
    'before calling again and lower the request rate: fewer parallel calls, fewer ' +
    'pages, fewer fields.',
  transport:
    'The call could not be completed after retries. Check network connectivity and ' +
    "Atlassian's status page (https://status.atlassian.com) before retrying.",
  timeout:
    'The request outlived JIRA_REQUEST_TIMEOUT_MS. Narrow it (fewer fields, a ' +
    'smaller maxResults) or raise the timeout, then retry.',
  ambiguous_write:
    'The write may or may not have been applied, so it was deliberately NOT ' +
    'retried. Re-read the affected issue to establish the current state before ' +
    'deciding whether to send it again — a blind retry risks a duplicate.',
  budget_exceeded:
    'The call exhausted JIRA_CALL_BUDGET_MS. Narrow the request — fewer fields, a ' +
    'smaller maxResults, fewer pages — rather than repeating it unchanged.',
  write_gated:
    'The write gate blocked this call. In plan mode, re-invoke with apply: true ' +
    'and the plan_id returned by the plan; the server must also run with ' +
    'JIRA_WRITE_MODE=apply and the tool must not be in a readonly package.',
  unexpected_shape:
    'Jira returned a response this server could not read. Report the tool name and ' +
    'the request; retrying unchanged will not help.',
  unsupported:
    'This endpoint is not available on this Jira deployment — the Jira Software ' +
    '(Agile) API may be unlicensed, disabled, or invisible to this account. Use a ' +
    'platform (v3) tool instead, or ask an administrator to enable it.',
});

/** Status codes whose kind is fixed. Everything else falls through the ranges. */
const STATUS_KIND: Readonly<Record<number, JiraErrorKind>> = Object.freeze({
  400: 'validation',
  401: 'auth',
  402: 'unsupported',
  403: 'permission',
  404: 'not_found',
  405: 'validation',
  406: 'validation',
  408: 'timeout',
  409: 'validation',
  410: 'not_found',
  412: 'validation',
  413: 'validation',
  415: 'validation',
  422: 'validation',
  429: 'rate_limited',
  501: 'unsupported',
});

/**
 * Headers Jira sets when a 403 is really an authentication failure (CC-18):
 * a denied login, a CAPTCHA challenge after repeated failures, or a failed-login
 * counter. Without this a locked-out account reads as "ask your admin for
 * permission", which sends the user in the wrong direction entirely.
 */
const LOGIN_DENIED_HEADERS = [
  'x-authentication-denied-reason',
  'x-failed-login-count',
] as const;

/** `X-Seraph-LoginReason` values that mean the credentials were refused. */
const SERAPH_OK = 'OK';

export interface StatusKindContext {
  /** Response headers, lowercased by the client (CC-18 detection). */
  readonly headers?: JiraResponseHeaders;
  /** Which API root the request targeted; `agile` reclassifies 403/404 (CC-34). */
  readonly apiRoot?: JiraApiRoot;
}

function isLoginDenied(headers: JiraResponseHeaders | undefined): boolean {
  if (!headers) return false;
  for (const name of LOGIN_DENIED_HEADERS) {
    if (headers[name] !== undefined) return true;
  }
  const seraph = headers['x-seraph-loginreason'];
  return seraph !== undefined && seraph.toUpperCase() !== SERAPH_OK;
}

/**
 * Map an HTTP status onto the frozen kind catalog.
 *
 * Deviations from the plain table, both documented: a 403 with Jira's
 * login-denied headers is `auth` (CC-18), and a 403/404 from the Agile root is
 * `unsupported` — "board doesn't exist" is the wrong story when the real cause
 * is that Jira Software is not licensed for this account (CC-34).
 */
export function kindForStatus(
  status: number,
  context: StatusKindContext = {},
): JiraErrorKind {
  if (status === 403 && isLoginDenied(context.headers)) return 'auth';
  if (context.apiRoot === 'agile' && (status === 403 || status === 404)) {
    return 'unsupported';
  }

  const mapped = STATUS_KIND[status];
  if (mapped !== undefined) return mapped;

  if (status >= 500) return 'transport';
  if (status >= 400) return 'validation';
  // 1xx/2xx/3xx never reach here: a non-2xx is what becomes an error, and a
  // redirect is rejected before it is followed (THREAT-MODEL.md §SSRF).
  return 'unexpected_shape';
}

function pushUnique(out: string[], value: string): void {
  const text = value.trim();
  if (text !== '' && !out.includes(text)) out.push(text);
}

/**
 * Read Jira's error messages out of a parsed body, in the order JIRA-API.md
 * fixes: `errorMessages[]`, then `errors{}` flattened as `field: message`, then
 * `message`. Duplicates are dropped; a body of any other shape yields `[]` and
 * the caller falls back to the status text.
 */
export function extractJiraMessages(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const out: string[] = [];

  const errorMessages: unknown = record.errorMessages;
  if (Array.isArray(errorMessages)) {
    for (const entry of errorMessages as unknown[]) {
      if (typeof entry === 'string') pushUnique(out, entry);
    }
  }

  const errors: unknown = record.errors;
  if (typeof errors === 'object' && errors !== null && !Array.isArray(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      if (typeof value === 'string') pushUnique(out, `${field}: ${value}`);
      else if (typeof value === 'number' || typeof value === 'boolean') {
        pushUnique(out, `${field}: ${String(value)}`);
      }
    }
  }

  const message: unknown = record.message;
  if (typeof message === 'string') pushUnique(out, message);

  return out;
}

/** Collapse whitespace and cut to `max`, marking the cut with an ellipsis. */
function bound(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function scrub(text: string, redactor: Redactor | undefined): string {
  return redactor ? redactor.redactString(text) : stripCredentialShapes(text);
}

/**
 * CC-15: the bounded, redacted snippet of a NON-JSON error body (the HTML a
 * proxy returns). Returns `undefined` for anything else — a parsed JSON body is
 * read by {@link extractJiraMessages}, never quoted verbatim.
 */
export function bodySnippet(body: unknown, redactor?: Redactor): string | undefined {
  if (typeof body !== 'string') return undefined;
  const snippet = bound(scrub(body, redactor), NON_JSON_DETAIL_MAX);
  return snippet === '' ? undefined : snippet;
}

export interface JiraErrorOptions {
  readonly kind: JiraErrorKind;
  /** The cause sentence. The remediation is appended to form `message`. */
  readonly reason: string;
  /** Overrides {@link REMEDIATION}; pass `''` to append nothing. */
  readonly remediation?: string;
  readonly httpStatus?: number;
  readonly jiraMessages?: readonly string[];
  readonly detail?: string;
  /** Defaults to the kind's `RETRYABLE_ERROR_KINDS` membership. */
  readonly retryable?: boolean;
  /** Underlying error for the `Error` cause chain. */
  readonly cause?: unknown;
  /** Redaction choke point; without one, only credential SHAPES are stripped. */
  readonly redactor?: Redactor;
}

/**
 * Build a {@link JiraError} with redaction and remediation applied — the only
 * sanctioned way to construct one.
 *
 * `message` is cause first, then recovery action (ARCHITECTURE.md §Error model),
 * so a client that renders nothing but the message still tells its user what to
 * do.
 */
export function createJiraError(options: JiraErrorOptions): JiraError {
  const { kind, redactor } = options;
  const remediation = options.remediation ?? REMEDIATION[kind];
  const reason = scrub(options.reason, redactor);
  const message =
    remediation === '' ? reason : `${reason} ${scrub(remediation, redactor)}`;

  const jiraMessages = options.jiraMessages?.map((entry) => scrub(entry, redactor));

  return new JiraError({
    kind,
    message,
    httpStatus: options.httpStatus,
    jiraMessages: jiraMessages && jiraMessages.length > 0 ? jiraMessages : undefined,
    retryable: options.retryable,
    remediation: remediation === '' ? undefined : scrub(remediation, redactor),
    detail: options.detail === undefined ? undefined : scrub(options.detail, redactor),
    cause: options.cause,
  });
}

export interface ResponseErrorOptions extends StatusKindContext {
  readonly status: number;
  /** Parsed JSON body, or the raw text when the body was not JSON (CC-15). */
  readonly body?: unknown;
  readonly method?: HttpMethod;
  /** Route WITH placeholders — never the concrete path (OBSERVABILITY.md). */
  readonly pathTemplate?: string;
  /** Overrides the status mapping; the retry engine knows `ambiguous_write`. */
  readonly kind?: JiraErrorKind;
  readonly retryable?: boolean;
  readonly cause?: unknown;
  readonly redactor?: Redactor;
}

/** `GET /issue/{key}` — placeholders only, so no workspace data reaches a log. */
function describeRoute(method?: HttpMethod, pathTemplate?: string): string {
  if (method && pathTemplate) return ` for ${method} ${pathTemplate}`;
  if (pathTemplate) return ` for ${pathTemplate}`;
  return '';
}

/**
 * Turn a non-2xx Jira response into a {@link JiraError}: status → kind, body →
 * `jiraMessages` (or a bounded `detail` snippet when the body was not JSON), and
 * the kind's remediation.
 *
 * The raw body never reaches `message`; only the messages Jira itself labelled
 * as errors do, bounded to {@link MESSAGE_DETAIL_MAX}.
 */
export function errorFromResponse(options: ResponseErrorOptions): JiraError {
  const { status, body, redactor } = options;
  const kind =
    options.kind ??
    kindForStatus(status, { headers: options.headers, apiRoot: options.apiRoot });

  const jiraMessages = extractJiraMessages(body);
  const detail = bodySnippet(body, redactor);

  const route = describeRoute(options.method, options.pathTemplate);
  const summary =
    jiraMessages.length > 0
      ? `: ${bound(jiraMessages.join('; '), MESSAGE_DETAIL_MAX)}`
      : detail !== undefined
        ? ' with a non-JSON body'
        : '';

  return createJiraError({
    kind,
    reason: `Jira returned HTTP ${status}${route}${summary}.`,
    httpStatus: status,
    jiraMessages,
    detail,
    retryable: options.retryable,
    cause: options.cause,
    redactor,
  });
}

/**
 * Is this a {@link JiraError}? Narrowing helper for `catch` blocks.
 *
 * Not `instanceof` alone: a `JiraError` can arrive from another realm (a
 * worker, a duplicated module instance) where the prototype chain differs, and
 * misclassifying a well-formed error as an internal bug loses both its kind
 * and its remediation. The structural branch still demands a real `Error`
 * carrying a kind from the closed catalog and a boolean `retryable`.
 */
export function isJiraError(value: unknown): value is JiraError {
  if (value instanceof JiraError) return true;
  if (!(value instanceof Error)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    typeof record['kind'] === 'string' &&
    (JIRA_ERROR_KINDS as readonly string[]).includes(record['kind']) &&
    typeof record['retryable'] === 'boolean'
  );
}

export interface WrapOptions {
  /** Kind for a non-`JiraError`; defaults to `transport`. */
  readonly kind?: JiraErrorKind;
  /** Cause sentence; defaults to the wrapped error's own message. */
  readonly reason?: string;
  readonly redactor?: Redactor;
}

/**
 * Guarantee a {@link JiraError} at a ring boundary: a `JiraError` passes
 * through untouched, anything else (a `TypeError` from `fetch`, a JSON parse
 * failure) is wrapped so a tool never sees a raw platform error.
 */
export function toJiraError(value: unknown, options: WrapOptions = {}): JiraError {
  if (isJiraError(value)) return value;

  const kind = options.kind ?? 'transport';
  const native = value instanceof Error ? value.message : '';
  const reason =
    options.reason ??
    (native === ''
      ? 'The call failed.'
      : `The call failed: ${bound(native, MESSAGE_DETAIL_MAX)}`);

  return createJiraError({ kind, reason, cause: value, redactor: options.redactor });
}

/**
 * The log-safe projection of an error: kind, status, retryability — and nothing
 * else.
 *
 * A `JiraError` must never be handed to `logger.emit` whole. Its `message`
 * carries Jira's own error text and its `detail` carries the CC-15 body snippet,
 * which OBSERVABILITY.md §Never-log list places "in the error, not in a log
 * event". Call sites log this instead.
 */
export function toLogFields(error: JiraError): Record<string, unknown> {
  return {
    errorKind: error.kind,
    retryable: error.retryable,
    ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  };
}

/**
 * Project a {@link JiraError} onto the model-facing {@link ErrorRecord}: plain
 * data, no stack, no cause chain, absent keys omitted rather than set to
 * `undefined` so the serialized envelope stays clean. An empty `remediation` or
 * `detail` is dropped the same way — `"remediation": ""` reads as advice that
 * was withheld, not advice that never existed.
 */
export function toErrorRecord(error: JiraError): ErrorRecord {
  return {
    kind: error.kind,
    message: error.message,
    retryable: error.retryable,
    ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    ...(error.jiraMessages !== undefined && error.jiraMessages.length > 0
      ? { jiraMessages: [...error.jiraMessages] }
      : {}),
    ...(error.remediation !== undefined && error.remediation !== ''
      ? { remediation: error.remediation }
      : {}),
    ...(error.detail !== undefined && error.detail !== ''
      ? { detail: error.detail }
      : {}),
  };
}
