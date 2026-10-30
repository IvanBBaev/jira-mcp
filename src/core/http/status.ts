// Reading a response's status, headers and error body into the words a
// `JiraError` carries (D515).

import type { JiraErrorKind, JiraResponseHeaders } from '../types.js';
import { REMEDIATION, kindForStatus } from '../errors.js';
import type { JiraCredentials } from './credentials.js';

export interface JiraErrorBody {
  readonly messages: readonly string[];
  readonly detail?: string;
}

export function headersOf(response: Response): JiraResponseHeaders {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/**
 * Minimal projection of Jira's three error shapes (`errorMessages[]`,
 * `errors{}`, `message`) — JIRA-API.md §Error response shapes.
 *
 * Deliberately internal to the wire tier and deliberately minimal: the full extractor with its
 * field-name mapping is `core/errors.ts` (WP-12). This exists only so the
 * client can populate `JiraError.jiraMessages` without importing upwards, and
 * should collapse into the WP-12 helper once that lands.
 */
export function projectErrorBody(text: string): JiraErrorBody {
  if (text.trim() === '') return { messages: [] };

  const parsed = parseJson(text);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    // CC-15: a non-JSON error body (HTML from a proxy, plain text from a WAF)
    // survives as a bounded snippet, never as a full body. The cut is made by
    // `makeFail`, after redaction (CC-238).
    return { messages: [], detail: text.trim() };
  }

  const body = parsed.value as Record<string, unknown>;
  const messages: string[] = [];

  const errorMessages = body['errorMessages'];
  if (Array.isArray(errorMessages)) {
    for (const entry of errorMessages) {
      if (typeof entry === 'string' && entry !== '') messages.push(entry);
    }
  }

  const errors = body['errors'];
  if (typeof errors === 'object' && errors !== null && !Array.isArray(errors)) {
    for (const [field, value] of Object.entries(errors)) {
      if (typeof value === 'string') messages.push(`${field}: ${value}`);
    }
  }

  const message = body['message'];
  if (messages.length === 0 && typeof message === 'string' && message !== '') {
    messages.push(message);
  }

  return { messages };
}

export interface StatusMapping {
  readonly kind: JiraErrorKind;
  readonly remediation: string;
}

/**
 * HTTP status → error kind + remediation. The kind comes from the single
 * status table in `errors.ts` (`kindForStatus`), which owns the CC-18 rule:
 * a 403 carrying Jira's login-denied headers is `auth`, but an ordinary
 * permission 403 with `X-Seraph-LoginReason: OK` is not. The remediation is
 * written for the model reading the tool result, so it names the next action,
 * not the failure; statuses without a bespoke text fall back to the kind's
 * `REMEDIATION` entry.
 *
 * 429 has no case here and must not grow one: the retry loop answers a 429
 * itself — it either waits and retries, or throws `rate_limited` when the
 * budget is spent — so this function is never called with one.
 */
export function describeStatus(
  status: number,
  headers: JiraResponseHeaders,
  credentialKind: JiraCredentials['kind'],
): StatusMapping {
  const kind = kindForStatus(status, { headers });
  if (kind === 'auth' && credentialKind === 'bearer') {
    // OAuth signs nothing with JIRA_EMAIL/JIRA_API_TOKEN; naming them sends the
    // operator after the wrong problem (CC-208).
    return {
      kind,
      remediation:
        'The OAuth authorization was refused. Run `jira-mcp-ai login` again (with --profile for a named profile), and check that JIRA_OAUTH_SCOPES covers this call.',
    };
  }
  if (kind === 'auth') {
    return {
      kind,
      remediation:
        'Check JIRA_EMAIL and JIRA_API_TOKEN. Atlassian API tokens expire within a year — regenerate the token at id.atlassian.com if it has.',
    };
  }
  if (status === 400) {
    return {
      kind,
      remediation:
        'Jira rejected the request fields; the messages above name the offending field. Fix the input and retry.',
    };
  }
  if (status === 403) {
    return {
      kind,
      remediation:
        'The account is authenticated but lacks the required Jira permission for this project or issue. Ask a Jira admin, or use a different project.',
    };
  }
  if (status === 404) {
    return {
      kind,
      remediation:
        'Jira returns 404 both for "does not exist" and for "you cannot see it" — verify the key/id, then verify the account has Browse Projects on it.',
    };
  }
  if (status === 405 || status === 410) {
    return {
      kind,
      remediation:
        'This endpoint is not available on this site. Note that the legacy /rest/api/3/search endpoints were removed in 2025 — searches must use /search/jql.',
    };
  }
  if (status === 409) {
    return {
      kind,
      remediation:
        'The resource changed underneath this call (concurrent edit, or the issue moved). Re-read it and retry.',
    };
  }
  if (status === 413 || status === 414) {
    return {
      kind,
      remediation:
        'The request was too large. Send fewer fields, or a smaller page size.',
    };
  }
  if (status >= 500 && kind === 'transport') {
    return {
      kind,
      remediation:
        'Jira returned a server error. This is usually transient — retry shortly.',
    };
  }
  return { kind, remediation: REMEDIATION[kind] };
}
