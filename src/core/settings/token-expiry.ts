// The `JIRA_TOKEN_EXPIRES` horizon (D516): an ISO date, validated the same way
// `doctor --save` validates it, and a warning once the API token is close to
// expiring. Time arrives through the injected `Clock`.

import type { AuthMode, Clock } from '../types.js';
import { TOKEN_EXPIRY_WARNING_DAYS } from './defaults.js';
import type { Add } from './report.js';

const MS_PER_DAY = 86400000;

/** A calendar date, optionally with a time and a zone: what CONFIGURATION.md documents. */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Whether `value` is a `JIRA_TOKEN_EXPIRES` the loader accepts — exported so
 * `doctor --save` refuses what the next start would refuse (CC-190).
 */
export function isIsoDate(value: string): boolean {
  return (
    ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) && isOnCalendar(value)
  );
}

/**
 * The instant a {@link isIsoDate} value names. A date-time without a zone is
 * read as UTC, like a bare date: `Date.parse` reads it in the machine's local
 * time, so `2027-01-31T12:00` meant different instants on different hosts —
 * the drift CC-142 closed for `1/2/2027` (CC-764).
 */
function isoInstant(value: string): number {
  const zoneless = value.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  return Date.parse(zoneless ? `${value}Z` : value);
}

/**
 * `Date.parse` rolls 2026-02-30 over to 2026-03-02 rather than refusing it, so
 * the shape and a parse do not prove the day exists (CC-415, as CC-182).
 */
function isOnCalendar(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Check the token expiry horizon. The horizon describes the API token of Basic
 * auth. In oauth mode there is no such token, so the variable is reported as
 * inert rather than parsed: an operator who left it behind should hear "this
 * does nothing now", not an `invalid_date` about a value that no longer has a
 * meaning to be wrong about.
 */
export function checkTokenExpiry(
  tokenExpires: string | undefined,
  authMode: AuthMode,
  clock: Clock | undefined,
  add: Add,
): void {
  if (tokenExpires !== undefined && authMode === 'pat') {
    add({
      severity: 'warning',
      code: 'token_expires_ignored',
      message:
        'JIRA_TOKEN_EXPIRES describes the API token of basic auth; JIRA_AUTH_MODE=pat does not track a personal access token expiry yet, so it is ignored. Unset the variable to silence this.',
      field: 'JIRA_TOKEN_EXPIRES',
    });
  } else if (tokenExpires !== undefined && authMode === 'oauth') {
    add({
      severity: 'warning',
      code: 'token_expires_ignored',
      message:
        'JIRA_TOKEN_EXPIRES describes the API token of basic auth, which JIRA_AUTH_MODE=oauth does not use; it is ignored. OAuth token lifetimes come from the token store that `jira-mcp-ai login` wrote, and doctor reports them. Unset the variable to silence this.',
      field: 'JIRA_TOKEN_EXPIRES',
    });
  } else if (tokenExpires !== undefined) {
    // ISO 8601 only: `Date.parse` alone also takes `1/2/2027`, read in US order
    // and local time, so the same value would mean different days on
    // different machines (CC-142).
    const expiresAt = isIsoDate(tokenExpires) ? isoInstant(tokenExpires) : Number.NaN;
    if (Number.isNaN(expiresAt)) {
      add({
        severity: 'error',
        code: 'invalid_date',
        message: `JIRA_TOKEN_EXPIRES ${JSON.stringify(tokenExpires)} is not an ISO date. Use the date shown on the API-token page, e.g. 2027-01-31.`,
        field: 'JIRA_TOKEN_EXPIRES',
      });
    } else if (clock !== undefined) {
      const daysLeft = Math.floor((expiresAt - clock.now()) / MS_PER_DAY);
      if (daysLeft <= TOKEN_EXPIRY_WARNING_DAYS) {
        add({
          severity: 'warning',
          code: 'token_expiry_warning',
          message:
            daysLeft < 0
              ? `The API token expired ${String(-daysLeft)} day(s) ago per JIRA_TOKEN_EXPIRES. Create a new token and update JIRA_API_TOKEN.`
              : `The API token expires in ${String(daysLeft)} day(s) per JIRA_TOKEN_EXPIRES. Create a new token before it does.`,
          field: 'JIRA_TOKEN_EXPIRES',
          data: { daysLeft },
        });
      }
    }
  }
}
