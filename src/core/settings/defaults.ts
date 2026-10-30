// The documented defaults (D516): one constant per CONFIGURATION.md row that
// has a Default column. The env ↔ docs sync test (TESTING.md suite 8) compares
// the documented default against these literals, so they quote the table.

import { OAUTH_TOKEN_FILE_NAME } from '../config.js';
import { OAUTH_AUTH_HOST, OAUTH_GATEWAY_HOST } from '../host.js';
import type {
  AuthMode,
  IrreversibleConfirm,
  JiraDeployment,
  LogLevel,
  OAuthGrant,
  TransportKind,
  WriteMode,
} from '../types.js';

/** `JIRA_TOOL_PACKAGES` default: every package the manifest ships. */
export const DEFAULT_TOOL_PACKAGES = 'all';
/** `JIRA_WRITE_MODE` default: writes describe instead of executing. */
export const DEFAULT_WRITE_MODE: WriteMode = 'plan';
/** `JIRA_IRREVERSIBLE_CONFIRM` default: no elicitation, the D45 gate alone. */
export const DEFAULT_IRREVERSIBLE_CONFIRM: IrreversibleConfirm = 'off';
/** `JIRA_REQUEST_TIMEOUT_MS` default. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** `JIRA_CALL_BUDGET_MS` default. */
export const DEFAULT_CALL_BUDGET_MS = 120000;
/** `JIRA_HOST_CONCURRENCY` default. */
export const DEFAULT_HOST_CONCURRENCY = 4;
/** `JIRA_RETRY_ATTEMPTS` default. */
export const DEFAULT_RETRY_ATTEMPTS = 3;
/** `JIRA_MAX_RESULT_CHARS` default. */
export const DEFAULT_MAX_RESULT_CHARS = 25000;
/** `JIRA_MAX_PAGES` default. */
export const DEFAULT_MAX_PAGES = 20;
/** `JIRA_META_CACHE_TTL_S` default: five minutes (D123). */
export const DEFAULT_META_CACHE_TTL_S = 300;
/** `JIRA_TRANSPORT` default. */
export const DEFAULT_TRANSPORT: TransportKind = 'stdio';
/** `JIRA_HTTP_PORT` default. */
export const DEFAULT_HTTP_PORT = 3334;
/** `JIRA_LOG_LEVEL` default. */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
/**
 * `JIRA_LOCK_PROFILE` default. v1 serves ONE profile (O-6, AUTH.md): a model
 * that can pick the tenant per call can leak issue text across tenants, so
 * unlocking is a deliberate act.
 */
export const DEFAULT_LOCK_PROFILE = true;
/** Horizon at which `JIRA_TOKEN_EXPIRES` starts warning (OBSERVABILITY.md). */
export const TOKEN_EXPIRY_WARNING_DAYS = 30;
/** `JIRA_AUTH_MODE` default: v1's Basic auth, unchanged (D91). */
export const DEFAULT_AUTH_MODE: AuthMode = 'basic';
/** `JIRA_OAUTH_GRANT` default: 3LO with `login`, as oauth mode always was (D302). */
export const DEFAULT_OAUTH_GRANT: OAuthGrant = 'authorization_code';
/** `JIRA_DEPLOYMENT` default: Jira Cloud, which is all v1 serves (D2, D106). */
export const DEFAULT_DEPLOYMENT: JiraDeployment = 'cloud';
/**
 * `JIRA_OAUTH_SCOPES` default — what `login` asks consent for.
 *
 * Deliberately mixed: the classic `*:jira-work` / `*:jira-user` scopes cover the
 * platform half, but Jira Software (boards, sprints, epics) has no classic
 * equivalent, so those tools need granular scopes. `offline_access` is what
 * makes the refresh token appear; without it a session dies in an hour.
 * `manage:jira-configuration` (global admin) is left out on purpose — the
 * consent screen should not ask for power the tool surface does not exercise.
 * `delete:sprint:jira-software` is also left out, even though a sprint-delete
 * tool exists since D102: widening the default set would force every existing
 * grant through re-consent (the economics below), so an oauth-mode
 * `jira_delete_sprint` under the defaults is a scope refusal, remedied with
 * `JIRA_OAUTH_SCOPES` and a fresh `login` (AUTH.md finding 5).
 *
 * Changing this list after a successful `login` forces a re-consent: the stored
 * grant is for the old set, and Atlassian will not widen it silently. That is
 * why `write:board-scope:jira-software` is here even though only
 * `jira_move_to_backlog` plausibly needs it and Atlassian publishes no
 * scope-to-endpoint map for the Agile API (AUTH.md §Scopes, finding 1): paying
 * for one inferred scope at first login is cheaper than making every user log in
 * again on an upgrade.
 */
export const DEFAULT_OAUTH_SCOPES: readonly string[] = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'manage:jira-project',
  'read:board-scope:jira-software',
  'write:board-scope:jira-software',
  'read:sprint:jira-software',
  'write:sprint:jira-software',
  'read:epic:jira-software',
  'write:epic:jira-software',
  'read:issue:jira-software',
  'write:issue:jira-software',
  'offline_access',
];
/** `JIRA_OAUTH_REDIRECT_PORT` default: the loopback port `login` listens on. */
export const DEFAULT_OAUTH_REDIRECT_PORT = 8250;
/** `JIRA_OAUTH_AUTH_ORIGIN` default: Atlassian's authorization server. */
export const DEFAULT_OAUTH_AUTH_ORIGIN = `https://${OAUTH_AUTH_HOST}`;
/** `JIRA_OAUTH_GATEWAY_ORIGIN` default: Atlassian's OAuth API gateway. */
export const DEFAULT_OAUTH_GATEWAY_ORIGIN = `https://${OAUTH_GATEWAY_HOST}`;
/**
 * How CONFIGURATION.md spells the `JIRA_OAUTH_TOKEN_FILE` default. The real
 * default is machine-specific (`core/config.ts` derives it from the config
 * home), so the table documents the shape and the env ↔ docs sync test compares
 * against this string rather than against a path that differs per checkout.
 */
export const DEFAULT_OAUTH_TOKEN_FILE_DOC = `<config dir>/${OAUTH_TOKEN_FILE_NAME}`;
