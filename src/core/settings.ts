// The `JIRA_*` environment surface, validated once (WP-11).
//
// `loadSettings()` returns `{ settings, report }` and NEVER throws: validation
// collects every problem into one aggregated {@link StartupReport} so `doctor`
// prints the complete picture instead of dying on the first missing variable
// (CONFIGURATION.md). `settings` is best-effort — documented defaults are
// substituted for invalid values so downstream types stay complete — and
// {@link assertStartupOk} is the thing that fails closed on error-severity
// findings. Warnings (a stripped URL path, a token expiring in three weeks) are
// informational and never block startup.
//
// CONFIGURATION.md owns the names and the defaults; the constants below quote
// its table literally, because the env ↔ docs sync test (TESTING.md suite 8)
// compares the documented default against the code's fallback literal. Reading
// an env var that has no row there is a build failure, which is why nothing in
// `core` reads the environment outside this module and `core/config.ts`.

import {
  OAUTH_TOKEN_FILE_NAME,
  defaultOAuthTokenFile,
  loadEnvFile,
  resolveConfigPath,
} from './config.js';
import type { EnvFileResult, EnvFileOptions } from './config.js';
import { effectiveCredentials } from './credentials.js';
import {
  OAUTH_AUTH_HOST,
  OAUTH_GATEWAY_HOST,
  isValidCloudId,
  resolveHost,
} from './host.js';
import type { HostProblem } from './host.js';
import {
  DEFAULT_PLACEHOLDER,
  MIN_DISTINCTIVE_SECRET_LENGTH,
  redactionRisk,
} from './redact.js';
import {
  AUTH_MODES,
  DEPLOYMENTS,
  JiraError,
  LOG_LEVELS,
  TRANSPORT_KINDS,
  WRITE_MODES,
  type AuthMode,
  type Clock,
  type HostRef,
  type JiraDeployment,
  type LogLevel,
  type ProfileConfig,
  type Settings,
  type TransportKind,
  type WriteMode,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults — one constant per CONFIGURATION.md row that has a Default column
// ---------------------------------------------------------------------------

/** `JIRA_TOOL_PACKAGES` default: every package the manifest ships. */
export const DEFAULT_TOOL_PACKAGES = 'all';
/** `JIRA_WRITE_MODE` default: writes describe instead of executing. */
export const DEFAULT_WRITE_MODE: WriteMode = 'plan';
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

const MS_PER_DAY = 86400000;

/** A calendar date, optionally with a time and a zone: what CONFIGURATION.md documents. */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
/** `JIRA_OAUTH_REDIRECT_PORT` range: unprivileged ports only — `login` binds it. */
const MIN_OAUTH_REDIRECT_PORT = 1024;

/**
 * Whether `value` is a `JIRA_TOKEN_EXPIRES` the loader accepts — exported so
 * `doctor --save` refuses what the next start would refuse (CC-190).
 */
export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}
const MAX_PORT = 65535;

/**
 * An https origin and nothing else: scheme, host, optional port. Returns the
 * normalised origin, or `undefined` when the value is not one.
 *
 * Rejecting a path, query, fragment or embedded credentials is not pedantry.
 * These two variables are where the OAuth flow sends the client secret and
 * where it fetches tokens from, so a value that carries anything beyond an
 * origin is either a typo or somebody's redirect target; `URL` would happily
 * accept it and the extra part would be silently dropped when the flow
 * concatenates its own paths. `https` only, for the same reason.
 */
function parseHttpsOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  return url.origin;
}

/** The hostname of an already-validated origin, for the egress allowlist. */
function originHost(origin: string): string {
  return new URL(origin).hostname;
}

// ---------------------------------------------------------------------------
// The aggregated startup report
// ---------------------------------------------------------------------------

/** `error` blocks startup via {@link assertStartupOk}; `warning` never does. */
export type FindingSeverity = 'error' | 'warning';

/** One config problem, machine-stable `code` first. */
export interface StartupFinding {
  readonly severity: FindingSeverity;
  /** Stable code, e.g. `invalid_number`, `token_expiry_warning`. */
  readonly code: string;
  /** Cause, then the recovery action. Never contains a secret VALUE. */
  readonly message: string;
  /** The env var the operator has to edit, when there is one. */
  readonly field?: string;
  /** Extra structured context for the log event (e.g. `daysLeft`). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Every problem found in one pass over the environment. */
export interface StartupReport {
  /** True iff there are zero error-severity findings. */
  readonly ok: boolean;
  readonly findings: readonly StartupFinding[];
  readonly errors: readonly StartupFinding[];
  readonly warnings: readonly StartupFinding[];
  /** Worst severity present, or `undefined` when the report is clean. */
  readonly worst?: FindingSeverity;
}

/** What `main()` and `doctor` receive from one environment pass. */
export interface LoadSettingsResult {
  readonly settings: Settings;
  readonly report: StartupReport;
  /**
   * Every secret VALUE found in the environment, deduplicated — feed it
   * straight to `createRedactor({ secrets })` (WP-12) before anything logs.
   * Registration is exhaustive on purpose (AUTH.md): an unused profile token is
   * still a secret that must never reach a transcript.
   */
  readonly secrets: readonly string[];
  /** Resolved host; absent when `JIRA_SITE` is missing, malformed or denied. */
  readonly host?: HostRef;
  /** Which env file was used, and where the loader looked. */
  readonly envFile: EnvFileResult;
}

/** Options for {@link loadSettings}; every ambient input is injectable. */
export interface LoadSettingsOptions extends EnvFileOptions {
  /**
   * Clock used for the `JIRA_TOKEN_EXPIRES` horizon. When omitted the expiry
   * is still parsed and validated, but no `token_expiry_warning` is produced —
   * `Date.now()` is banned outside `core/clock.ts` [eslint], so time has to be
   * injected. `main()` and `doctor` pass the real clock.
   */
  readonly clock?: Clock;
  /**
   * Read the env file before parsing. Default `true`, but the file is only
   * loaded when reading `process.env` — a caller-supplied `env` object is used
   * verbatim, which is what makes tests hermetic.
   */
  readonly loadEnvFile?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const PROFILE_KEY_RE = /^JIRA_PROFILE_(.+)_(SITE|EMAIL|API_TOKEN)$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Truthy/falsy spellings accepted for boolean knobs. */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

type Add = (finding: StartupFinding) => void;

function fromHostProblem(problem: HostProblem): StartupFinding {
  return {
    severity: problem.severity,
    code: problem.code,
    message: problem.message,
    field: problem.field,
  };
}

/**
 * Resolve the whole `JIRA_*` surface, aggregating every problem. Never throws.
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadSettingsResult {
  const env = options.env ?? process.env;
  const usingProcessEnv = env === process.env;

  // Env-first: the file only populates variables the client did not pass
  // (`process.loadEnvFile` does not overwrite existing entries).
  const envFile =
    usingProcessEnv && (options.loadEnvFile ?? true)
      ? loadEnvFile(options)
      : { loaded: false, candidates: [], problems: [] };

  const findings: StartupFinding[] = [];
  const add: Add = (finding) => findings.push(finding);

  for (const problem of envFile.problems) {
    add({
      severity: problem.severity,
      code: problem.code,
      message: problem.message,
      field: problem.field,
    });
  }

  const str = (key: string): string | undefined => {
    const value = env[key];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const csv = (key: string): readonly string[] => {
    const raw = str(key);
    if (raw === undefined) return [];
    return raw
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0);
  };

  /**
   * Integer knob. An unparseable or out-of-range value is an ERROR finding, not
   * a silent fallback: a typo in a timeout must fail startup, not quietly
   * change behaviour. The default is still substituted so `Settings` stays
   * complete for the report path.
   */
  const int = (key: string, def: number, min: number, max: number): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    // Plain decimal digits only: `Number` would also take `0x0D06`, `3e4` and
    // `4.0`, none of which the documentation promises (CC-141).
    const parsed = /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      add({
        severity: 'error',
        code: 'invalid_number',
        message: `${key} must be an integer in [${String(min)}, ${String(max)}]; got ${JSON.stringify(raw)}. Startup uses the documented default ${String(def)} only to finish the report.`,
        field: key,
      });
      return def;
    }
    return parsed;
  };

  const enumOf = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const raw = str(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase();
    const match = allowed.find((candidate) => candidate === lower);
    if (match === undefined) {
      add({
        severity: 'error',
        code: 'invalid_enum',
        message: `${key} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(raw)}. Using the documented default ${def}.`,
        field: key,
      });
      return def;
    }
    return match;
  };

  const bool = (key: string, def: boolean): boolean => {
    const raw = str(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase();
    if (TRUE_VALUES.has(lower)) return true;
    if (FALSE_VALUES.has(lower)) return false;
    add({
      severity: 'error',
      code: 'invalid_boolean',
      message: `${key} must be one of 1|true|yes|on|0|false|no|off; got ${JSON.stringify(raw)}. Using the default ${String(def)}.`,
      field: key,
    });
    return def;
  };

  /**
   * An https origin knob. Same contract as {@link int}: a bad value is an ERROR
   * finding and the documented default is substituted so the report can finish.
   */
  const httpsOrigin = (key: string, def: string): string => {
    const raw = str(key);
    if (raw === undefined) return def;
    const parsed = parseHttpsOrigin(raw);
    if (parsed === undefined) {
      add({
        severity: 'error',
        code: 'invalid_origin',
        // The value is echoed with any userinfo masked: a password pasted into
        // the origin must not reach the report (CC-140). The mask runs to the
        // LAST `@` before any query or fragment, because a password may itself
        // hold an `@` or a `/` (CC-185).
        message: `${key} must be an https origin with no path, query, fragment or credentials (e.g. ${def}); got ${JSON.stringify(raw.replace(/\/\/[^?#]*@/, '//***@'))}. Using the documented default ${def}.`,
        field: key,
      });
      return def;
    }
    return parsed;
  };

  // --- Credentials ---------------------------------------------------------
  const site = str('JIRA_SITE');
  const email = str('JIRA_EMAIL');
  const apiToken = str('JIRA_API_TOKEN');
  const tokenExpires = str('JIRA_TOKEN_EXPIRES');
  const configuredHosts = (str('JIRA_ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // --- Auth mode and the OAuth block (D91) ---------------------------------
  // Parsed unconditionally, in BOTH modes: `Settings.oauth` is always a complete
  // value, so doctor can report a block an operator is halfway through filling
  // in, and a typo in one of these knobs is an error wherever it appears — the
  // house rule is that a malformed value never becomes a silent fallback. What
  // the MODE decides is which variables are *required* (below, with the
  // credentials) and whether the OAuth hosts join the egress allowlist (D97).
  const authMode = enumOf<AuthMode>('JIRA_AUTH_MODE', AUTH_MODES, DEFAULT_AUTH_MODE);
  const deployment = enumOf<JiraDeployment>(
    'JIRA_DEPLOYMENT',
    DEPLOYMENTS,
    DEFAULT_DEPLOYMENT,
  );
  const pat = str('JIRA_PAT');
  const datacenterPreview = bool('JIRA_DATACENTER_PREVIEW', false);
  const oauthClientId = str('JIRA_OAUTH_CLIENT_ID');
  const oauthClientSecret = str('JIRA_OAUTH_CLIENT_SECRET');
  const oauthScopes = csv('JIRA_OAUTH_SCOPES');
  const oauthCloudId = str('JIRA_OAUTH_CLOUD_ID');
  const oauthTokenFileRaw = str('JIRA_OAUTH_TOKEN_FILE');
  const oauthTokenFile =
    oauthTokenFileRaw === undefined
      ? defaultOAuthTokenFile(options)
      : resolveConfigPath(oauthTokenFileRaw, options);
  const oauthRedirectPort = int(
    'JIRA_OAUTH_REDIRECT_PORT',
    DEFAULT_OAUTH_REDIRECT_PORT,
    MIN_OAUTH_REDIRECT_PORT,
    MAX_PORT,
  );
  // Both origins exist for ONE reason: the offline test harness points the flow
  // at a local stand-in for Atlassian, because a test that must not touch the
  // network still has to exercise the authorize → exchange → refresh sequence.
  // Nothing in a real deployment sets them — they are a seam, not a knob — which
  // is why the default is the real Atlassian origin and the validation is strict.
  //
  // Strict includes the scheme: a stand-in must serve https too (the harness
  // uses `https://127.0.0.1:<port>`). There is deliberately no loopback
  // exemption. The client secret and every refresh token are sent to the auth
  // origin, and a validator that accepts cleartext for "just a test host" is one
  // copied `.env` line away from doing it against a real tenant. A unit test
  // that does not want to run a TLS listener should inject `AuthRequestFn`
  // instead of reconfiguring the origin.
  const oauthAuthOrigin = httpsOrigin(
    'JIRA_OAUTH_AUTH_ORIGIN',
    DEFAULT_OAUTH_AUTH_ORIGIN,
  );
  const oauthGatewayOrigin = httpsOrigin(
    'JIRA_OAUTH_GATEWAY_ORIGIN',
    DEFAULT_OAUTH_GATEWAY_ORIGIN,
  );

  // The cloudId is interpolated into every request path, so a value that is not
  // path-safe is refused at startup rather than at the first call — using the
  // same predicate as the request builder (CC-101), because two spellings of one
  // rule is how a check ends up rejecting what the other accepts. It is a
  // shape check, not a lookup: only the flow can say whether the id exists.
  if (oauthCloudId !== undefined && !isValidCloudId(oauthCloudId)) {
    add({
      severity: 'error',
      code: 'invalid_cloud_id',
      message: `JIRA_OAUTH_CLOUD_ID ${JSON.stringify(oauthCloudId)} is not a cloud id — letters, digits and hyphens only. It is the id \`jira-mcp-ai login\` prints for the site, not the site URL; unset it to let login discover the site on every run instead.`,
      field: 'JIRA_OAUTH_CLOUD_ID',
    });
  }

  // D97: the two OAuth hosts are allowlisted ONLY in oauth mode, and only for
  // the origins actually configured. `Settings.allowedHosts` is the EFFECTIVE
  // list — assembled here, before `resolveHost` runs — so every consumer of it
  // (the host resolver, the per-call resolver, `core/http.ts`) agrees on what
  // egress is permitted. In basic mode the list is byte-identical to what the
  // operator wrote: v1's egress surface does not change because a feature it
  // does not use exists.
  const allowedHosts =
    authMode === 'oauth'
      ? withOAuthHosts(configuredHosts, [oauthAuthOrigin, oauthGatewayOrigin])
      : configuredHosts;

  // --- Profiles (v1: parsed and validated; per-call switching is locked) ----
  const profiles = parseProfiles(env, add);
  const activeProfileRaw = str('JIRA_ACTIVE_PROFILE');
  const activeProfileKey = activeProfileRaw?.toLowerCase();
  const activeProfile =
    activeProfileKey !== undefined ? profiles[activeProfileKey] : undefined;

  if (activeProfileRaw !== undefined && activeProfile === undefined) {
    const known = Object.keys(profiles);
    add({
      severity: 'error',
      code: 'unknown_profile',
      message: `JIRA_ACTIVE_PROFILE names ${JSON.stringify(activeProfileRaw)}, for which no ${profileVar('<NAME>', 'SITE')}-style variables are set. ${known.length === 0 ? 'No profiles are defined.' : `Known profiles: ${known.join(', ')}.`}`,
      field: 'JIRA_ACTIVE_PROFILE',
    });
  }

  const lockProfile = bool('JIRA_LOCK_PROFILE', DEFAULT_LOCK_PROFILE);

  // The credentials actually used — the per-field profile override, applied by
  // the rule's one home (`core/credentials.ts`, D29) so load-time diagnostics
  // can never disagree with the per-call resolver.
  const {
    site: effectiveSite,
    email: effectiveEmail,
    apiToken: effectiveToken,
  } = effectiveCredentials({
    profiles,
    site,
    email,
    apiToken,
    activeProfile: activeProfileKey,
  });
  const profileName = activeProfile?.name;
  // The variable each effective value was READ from, so a finding about a value
  // the active profile supplied names the profile's variable (CC-189).
  const emailVariable =
    profileName !== undefined && activeProfile?.email !== undefined
      ? profileVar(profileName, 'EMAIL')
      : 'JIRA_EMAIL';
  const siteVariable =
    profileName !== undefined && activeProfile?.site !== undefined
      ? profileVar(profileName, 'SITE')
      : 'JIRA_SITE';

  // Which credentials are REQUIRED is the one thing the mode changes here.
  // `JIRA_SITE` is required either way — oauth resolves the tenant through the
  // gateway, but the operator still has to say which tenant — so its findings
  // come from `resolveHost` below, outside this branch.
  if (authMode === 'basic') {
    if (effectiveEmail === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message: `${profileName === undefined ? 'JIRA_EMAIL' : profileVar(profileName, 'EMAIL')} is not set. Basic auth needs the Atlassian account email.`,
        field: 'JIRA_EMAIL',
      });
    } else if (!effectiveEmail.includes('@')) {
      add({
        severity: 'error',
        code: 'invalid_email',
        message: `${emailVariable} ${JSON.stringify(effectiveEmail)} is not an email address. Basic auth sends email:token, so a login name will always 401.`,
        field: emailVariable,
      });
    }

    if (effectiveToken === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message: `${profileName === undefined ? 'JIRA_API_TOKEN' : profileVar(profileName, 'API_TOKEN')} is not set. Create one at https://id.atlassian.com/manage-profile/security/api-tokens`,
        field: 'JIRA_API_TOKEN',
      });
    }
  } else if (authMode === 'pat') {
    // A Data Center personal access token is the whole credential: no email,
    // no app. Its absence is the one thing to report in this mode.
    if (pat === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message:
          'JIRA_AUTH_MODE=pat needs JIRA_PAT: the personal access token created in Jira Data Center under Profile → Personal Access Tokens. It is sent as a bearer token to the site host.',
        field: 'JIRA_PAT',
      });
    }
  } else {
    // In oauth mode the email/token pair signs nothing, so their absence is not
    // a problem to report — sending an operator to fix `JIRA_API_TOKEN` when the
    // server never reads it is how a config error becomes an hour of debugging.
    // The app's own credentials take their place, and BOTH are required:
    // Atlassian authenticates the client on the token endpoint for the code
    // exchange and for every refresh, so there is no public-client shortcut here
    // however much PKCE would suggest one.
    if (oauthClientId === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message:
          'JIRA_AUTH_MODE=oauth needs JIRA_OAUTH_CLIENT_ID: it names the OAuth 2.0 (3LO) app the login flow asks consent for. Create the app at https://developer.atlassian.com/console/myapps/ and copy its client id.',
        field: 'JIRA_OAUTH_CLIENT_ID',
      });
    }
    if (oauthClientSecret === undefined) {
      add({
        severity: 'error',
        code: 'missing_credential',
        message:
          'JIRA_AUTH_MODE=oauth needs JIRA_OAUTH_CLIENT_SECRET: Atlassian requires client authentication on the token endpoint, for the initial exchange and for every refresh. Copy it from the same app under Settings → Authentication details.',
        field: 'JIRA_OAUTH_CLIENT_SECRET',
      });
    }
  }

  // --- Deployment (D106) ---------------------------------------------------
  // The two products do not share a credential: a PAT exists only on Data
  // Center, and an API token with an email, or a 3LO grant, only on Cloud. A
  // mismatch is an error rather than a guess, because the guess would send one
  // product's secret to the other's host.
  if (authMode === 'pat' && deployment !== 'datacenter') {
    add({
      severity: 'error',
      code: 'auth_mode_deployment',
      message:
        'JIRA_AUTH_MODE=pat is a Jira Data Center credential, and JIRA_DEPLOYMENT is cloud. Jira Cloud has no personal access tokens: use JIRA_AUTH_MODE=basic (email + API token) or oauth, or set JIRA_DEPLOYMENT=datacenter.',
      field: 'JIRA_AUTH_MODE',
    });
  }
  if (deployment === 'datacenter' && authMode !== 'pat') {
    add({
      severity: 'error',
      code: 'auth_mode_deployment',
      message: `JIRA_DEPLOYMENT=datacenter authenticates with a personal access token, and JIRA_AUTH_MODE is ${authMode}. Set JIRA_AUTH_MODE=pat and JIRA_PAT.`,
      field: 'JIRA_AUTH_MODE',
    });
  }
  if (pat !== undefined && authMode !== 'pat') {
    add({
      severity: 'warning',
      code: 'pat_ignored',
      message: `JIRA_PAT is set, but JIRA_AUTH_MODE is ${authMode}, which does not use it; it is ignored. Unset it to silence this.`,
      field: 'JIRA_PAT',
    });
  }
  // Fail closed: the Data Center adapter is UNVERIFIED (D106, D104's
  // condition), so it runs only on the operator's explicit acknowledgement.
  // Everything above still runs, so an operator preparing a Data Center
  // configuration sees every other problem in the same report.
  if (deployment === 'datacenter' && !datacenterPreview) {
    add({
      severity: 'error',
      code: 'deployment_unavailable',
      message:
        'JIRA_DEPLOYMENT=datacenter selects a read-only Data Center adapter that has never been run against a Data Center instance (IMPLEMENTATION-PLAN.md Phase 13, D106). It starts only with JIRA_DATACENTER_PREVIEW=true, which says you accept that. Unset JIRA_DEPLOYMENT to use Jira Cloud.',
      field: 'JIRA_DEPLOYMENT',
    });
  } else if (deployment === 'datacenter') {
    add({
      severity: 'warning',
      code: 'deployment_unverified',
      message:
        "Jira Data Center preview: a read-only adapter built from Atlassian's documentation and never verified against a Data Center instance. jira_capabilities lists the tools it serves; report what breaks.",
      field: 'JIRA_DATACENTER_PREVIEW',
    });
  }
  if (datacenterPreview && deployment !== 'datacenter') {
    add({
      severity: 'warning',
      code: 'datacenter_preview_ignored',
      message:
        'JIRA_DATACENTER_PREVIEW is set, but JIRA_DEPLOYMENT is cloud; it is ignored. Unset it to silence this.',
      field: 'JIRA_DATACENTER_PREVIEW',
    });
  }

  // --- Host ----------------------------------------------------------------
  const resolution = resolveHost(effectiveSite, allowedHosts, siteVariable, deployment);
  for (const problem of resolution.problems) add(fromHostProblem(problem));

  // --- Token expiry horizon ------------------------------------------------
  // The horizon describes the API token of Basic auth. In oauth mode there is no
  // such token, so the variable is reported as inert rather than parsed: an
  // operator who left it behind should hear "this does nothing now", not an
  // `invalid_date` about a value that no longer has a meaning to be wrong about.
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
    const expiresAt = isIsoDate(tokenExpires) ? Date.parse(tokenExpires) : Number.NaN;
    if (Number.isNaN(expiresAt)) {
      add({
        severity: 'error',
        code: 'invalid_date',
        message: `JIRA_TOKEN_EXPIRES ${JSON.stringify(tokenExpires)} is not an ISO date. Use the date shown on the API-token page, e.g. 2027-01-31.`,
        field: 'JIRA_TOKEN_EXPIRES',
      });
    } else if (options.clock !== undefined) {
      const daysLeft = Math.floor((expiresAt - options.clock.now()) / MS_PER_DAY);
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

  // --- Tool surface gating -------------------------------------------------
  const toolPackages = csv('JIRA_TOOL_PACKAGES');
  const packagesDeny = csv('JIRA_PACKAGES_DENY');
  const packagesReadonly = csv('JIRA_PACKAGES_READONLY');

  if (packagesDeny.includes('core')) {
    // CC-29: the deny list cannot remove `core` — capabilities and doctor must
    // always exist. The value passes through unchanged; `mcp/registry.ts` does
    // the re-adding, so this is the visible half of that invariant.
    add({
      severity: 'warning',
      code: 'core_package_undeniable',
      message:
        'JIRA_PACKAGES_DENY lists "core"; the core package is force-re-added (CC-29) because capabilities and doctor depend on it. Remove it from the deny list to silence this.',
      field: 'JIRA_PACKAGES_DENY',
    });
  }

  const writeMode = enumOf<WriteMode>('JIRA_WRITE_MODE', WRITE_MODES, DEFAULT_WRITE_MODE);
  const allowIrreversible = bool('JIRA_ALLOW_IRREVERSIBLE', false);

  // --- HTTP behaviour ------------------------------------------------------
  const requestTimeoutMs = int(
    'JIRA_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    600000,
  );
  const callBudgetMs = int('JIRA_CALL_BUDGET_MS', DEFAULT_CALL_BUDGET_MS, 1, 3600000);
  const hostConcurrency = int('JIRA_HOST_CONCURRENCY', DEFAULT_HOST_CONCURRENCY, 1, 64);
  const retryAttempts = int('JIRA_RETRY_ATTEMPTS', DEFAULT_RETRY_ATTEMPTS, 0, 10);
  const maxResultChars = int(
    'JIRA_MAX_RESULT_CHARS',
    DEFAULT_MAX_RESULT_CHARS,
    500,
    10000000,
  );
  const maxPages = int('JIRA_MAX_PAGES', DEFAULT_MAX_PAGES, 1, 1000);
  // Both paths are normalised the way `JIRA_ENV_FILE` is (CC-184): an env var
  // carries no shell expansion, so `~/jira-media` would otherwise name a
  // directory called `~` under whatever cwd the client spawned the server in.
  const mediaDirRaw = str('JIRA_MEDIA_DIR');
  const mediaDir =
    mediaDirRaw === undefined ? undefined : resolveConfigPath(mediaDirRaw, options);

  if (callBudgetMs < requestTimeoutMs) {
    add({
      severity: 'warning',
      code: 'budget_below_timeout',
      message: `JIRA_CALL_BUDGET_MS (${String(callBudgetMs)}) is below JIRA_REQUEST_TIMEOUT_MS (${String(requestTimeoutMs)}); a single slow request will exhaust the whole call budget.`,
      field: 'JIRA_CALL_BUDGET_MS',
    });
  }

  // --- Transport (CC-30) ---------------------------------------------------
  const transport = enumOf<TransportKind>(
    'JIRA_TRANSPORT',
    TRANSPORT_KINDS,
    DEFAULT_TRANSPORT,
  );
  const httpPort = int('JIRA_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65535);
  const httpToken = str('JIRA_HTTP_TOKEN');
  if (transport === 'http' && httpToken === undefined) {
    add({
      severity: 'error',
      code: 'http_token_missing',
      message:
        'JIRA_TRANSPORT=http requires JIRA_HTTP_TOKEN; the HTTP transport fails closed without it (CC-30). Set a random bearer token or use the stdio transport.',
      field: 'JIRA_HTTP_TOKEN',
    });
  }

  // --- Diagnostics ---------------------------------------------------------
  const logLevel = enumOf<LogLevel>('JIRA_LOG_LEVEL', LOG_LEVELS, DEFAULT_LOG_LEVEL);
  const journalPathRaw = str('JIRA_JOURNAL_PATH');
  const journalPath =
    journalPathRaw === undefined ? undefined : resolveConfigPath(journalPathRaw, options);

  const settings: Settings = {
    site,
    email,
    apiToken,
    tokenExpires,
    authMode,
    deployment,
    datacenterPreview,
    ...(pat === undefined ? {} : { pat }),
    oauth: {
      ...(oauthClientId === undefined ? {} : { clientId: oauthClientId }),
      ...(oauthClientSecret === undefined ? {} : { clientSecret: oauthClientSecret }),
      scopes: oauthScopes.length > 0 ? oauthScopes : DEFAULT_OAUTH_SCOPES,
      ...(oauthCloudId === undefined ? {} : { cloudId: oauthCloudId }),
      tokenFile: oauthTokenFile,
      redirectPort: oauthRedirectPort,
      authOrigin: oauthAuthOrigin,
      gatewayOrigin: oauthGatewayOrigin,
    },
    allowedHosts,
    profiles,
    activeProfile: activeProfileRaw,
    lockProfile,
    toolPackages: toolPackages.length > 0 ? toolPackages : [DEFAULT_TOOL_PACKAGES],
    packagesDeny,
    packagesReadonly,
    writeMode,
    allowIrreversible,
    requestTimeoutMs,
    callBudgetMs,
    hostConcurrency,
    retryAttempts,
    maxResultChars,
    maxPages,
    mediaDir,
    transport,
    httpPort,
    httpToken,
    logLevel,
    journalPath,
  };

  // --- Redaction blast radius ----------------------------------------------
  // Everything below is registered with the redactor as a literal needle, so a
  // placeholder token (`t`, `settings`) scrubs the server's own output away and
  // the operator is left staring at a wall of placeholders with nothing saying
  // why. The redactor will not refuse such a value — declining to protect a
  // secret is the one failure mode worse than an unreadable log (see
  // `redactionRisk`) — so the complaint belongs here, where a `warning` is
  // visible in doctor and in the startup report and still lets the server run.
  // One finding per variable, not per distinct value: two variables holding the
  // same placeholder are two edits the operator has to make.
  for (const { field, value } of secretVariables(settings)) {
    const risk = redactionRisk(value);
    if (risk === undefined) continue;
    add({
      severity: 'warning',
      code: 'redaction_collision',
      message:
        risk === 'too_short'
          ? `${field} is shorter than ${String(MIN_DISTINCTIVE_SECRET_LENGTH)} characters. Secrets are redacted as literal text, so a value this short also blanks ordinary text that contains it and output comes back as a wall of ${DEFAULT_PLACEHOLDER}. Nothing is under-redacted; replace the placeholder with the real credential to get readable output back.`
          : `${field} is a substring of text this server prints itself, so redacting it blanks that text too and diagnostics come back unreadable. Nothing is under-redacted; replace the placeholder with the real credential to get readable output back.`,
      field,
    });
  }

  return {
    settings,
    report: buildReport(findings),
    secrets: collectSecrets(settings),
    ...(resolution.host === undefined ? {} : { host: resolution.host }),
    envFile,
  };
}

/**
 * The operator's allowlist plus the hostnames of the given OAuth origins, in
 * that order and deduplicated. Hostnames only: `compileAllowlist` matches hosts,
 * and the port an origin may carry is not part of that decision.
 */
function withOAuthHosts(
  configured: readonly string[],
  origins: readonly string[],
): string[] {
  const out = [...configured];
  for (const origin of origins) {
    const hostname = originHost(origin);
    if (!out.includes(hostname)) out.push(hostname);
  }
  return out;
}

/** `JIRA_PROFILE_<NAME>_<FIELD>`, built rather than spelled out. */
export function profileVar(name: string, field: 'SITE' | 'EMAIL' | 'API_TOKEN'): string {
  return `JIRA_PROFILE_${name.toUpperCase()}_${field}`;
}

/**
 * Collect every `JIRA_PROFILE_<NAME>_SITE|EMAIL|API_TOKEN` into profiles, keyed
 * by lower-cased name so `JIRA_ACTIVE_PROFILE=work` finds `JIRA_PROFILE_WORK_*`.
 * `ProfileConfig.name` is that same lower-cased key, so `profiles[k].name === k`
 * holds whatever case the operator spelled the variable in.
 */
function parseProfiles(
  env: NodeJS.ProcessEnv,
  add: Add,
): Readonly<Record<string, ProfileConfig>> {
  const drafts = new Map<
    string,
    { name: string; site?: string; email?: string; apiToken?: string }
  >();
  // The variable each profile field was read from, keyed `<name>:<FIELD>`.
  // Names are case-insensitive, so `JIRA_PROFILE_eu_SITE` and
  // `JIRA_PROFILE_EU_SITE` are the same field: taking the last one silently
  // would pick a site by environment order, and a second API token would never
  // reach the redactor (CC-188).
  const sources = new Map<string, string>();

  for (const key of Object.keys(env)) {
    const match = PROFILE_KEY_RE.exec(key);
    if (match === null) continue;
    const rawName = match[1];
    const field = match[2];
    if (rawName === undefined || field === undefined) continue;

    if (!PROFILE_NAME_RE.test(rawName)) {
      add({
        severity: 'error',
        code: 'invalid_profile_name',
        message: `${key} has an unusable profile name; use letters, digits, hyphen and underscore only.`,
        field: key,
      });
      continue;
    }

    const value = env[key]?.trim();
    if (value === undefined || value.length === 0) {
      add({
        severity: 'error',
        code: 'empty_profile_value',
        message: `${key} is set but empty. Give it a value or unset it.`,
        field: key,
      });
      continue;
    }

    const lower = rawName.toLowerCase();
    const earlier = sources.get(`${lower}:${field}`);
    if (earlier !== undefined) {
      add({
        severity: 'error',
        code: 'duplicate_profile_variable',
        message: `${key} and ${earlier} set the same profile field (profile names are case-insensitive). Keep one of them.`,
        field: key,
      });
      continue;
    }
    sources.set(`${lower}:${field}`, key);
    const draft = drafts.get(lower) ?? { name: lower };
    if (field === 'SITE') draft.site = value;
    else if (field === 'EMAIL') draft.email = value;
    else draft.apiToken = value;
    drafts.set(lower, draft);
  }

  const out: Record<string, ProfileConfig> = {};
  for (const [key, draft] of drafts) {
    out[key] = {
      name: draft.name,
      ...(draft.site === undefined ? {} : { site: draft.site }),
      ...(draft.email === undefined ? {} : { email: draft.email }),
      ...(draft.apiToken === undefined ? {} : { apiToken: draft.apiToken }),
    };
  }
  return out;
}

/**
 * Every secret value in the environment paired with the variable it came from —
 * the active token, the tokens of INACTIVE profiles, `JIRA_HTTP_TOKEN` and the
 * OAuth client secret (AUTH.md §Secret registration is exhaustive at startup).
 * {@link collectSecrets} is this list with the names dropped, so a diagnostic
 * that names a variable and the set actually handed to the redactor can never
 * drift apart.
 *
 * Registration ignores `authMode` on purpose: a client secret sitting in the
 * environment of a server running basic auth is still a secret, and the mode is
 * exactly the kind of thing that gets flipped between runs.
 */
function secretVariables(settings: Settings): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  const push = (field: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) out.push({ field, value });
  };
  push('JIRA_API_TOKEN', settings.apiToken);
  for (const profile of Object.values(settings.profiles)) {
    push(profileVar(profile.name, 'API_TOKEN'), profile.apiToken);
  }
  push('JIRA_HTTP_TOKEN', settings.httpToken);
  push('JIRA_OAUTH_CLIENT_SECRET', settings.oauth.clientSecret);
  push('JIRA_PAT', settings.pat);
  return out;
}

/**
 * Every secret value in the environment. Deduplicated and order-stable so the
 * redactor's longest-first ordering is reproducible.
 */
export function collectSecrets(settings: Settings): readonly string[] {
  const seen = new Set<string>();
  for (const { value } of secretVariables(settings)) seen.add(value);
  return [...seen];
}

/** Group findings into the aggregated report shape. */
export function buildReport(findings: readonly StartupFinding[]): StartupReport {
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const worst: FindingSeverity | undefined =
    errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : undefined;
  return {
    ok: errors.length === 0,
    findings,
    errors,
    warnings,
    ...(worst === undefined ? {} : { worst }),
  };
}

/** Human-readable rendering; also the body of the `assertStartupOk` error. */
export function formatStartupReport(report: StartupReport): string {
  const lines: string[] = [];
  if (report.errors.length > 0) {
    lines.push(`Configuration errors (${String(report.errors.length)}):`);
    for (const finding of report.errors)
      lines.push(`  - [${finding.code}] ${finding.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Configuration warnings (${String(report.warnings.length)}):`);
    for (const finding of report.warnings)
      lines.push(`  - [${finding.code}] ${finding.message}`);
  }
  if (lines.length === 0) lines.push('Configuration OK.');
  return lines.join('\n');
}

/**
 * Fail closed on error-severity findings. Warnings pass — a token expiring in
 * three weeks must not stop a server that still works today.
 *
 * Throws `JiraError { kind: 'config' }`; the aggregated text is the message, so
 * one failed start shows every problem at once.
 */
export function assertStartupOk(report: StartupReport): void {
  if (report.ok) return;
  throw new JiraError({
    kind: 'config',
    message: `Invalid configuration:\n${formatStartupReport(report)}`,
    retryable: false,
    remediation:
      'Fix the JIRA_* variables listed above (names and defaults: https://github.com/IvanBBaev/jira-mcp/blob/main/docs/CONFIGURATION.md), then restart. `jira-mcp-ai doctor` prints the same report without starting the server.',
  });
}
