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

import { loadEnvFile } from './config.js';
import type { EnvFileResult, EnvFileOptions } from './config.js';
import { resolveHost } from './host.js';
import type { HostProblem } from './host.js';
import {
  JiraError,
  LOG_LEVELS,
  TRANSPORT_KINDS,
  WRITE_MODES,
  type Clock,
  type HostRef,
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

const MS_PER_DAY = 86400000;

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
    const parsed = Number(raw);
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

  // --- Credentials ---------------------------------------------------------
  const site = str('JIRA_SITE');
  const email = str('JIRA_EMAIL');
  const apiToken = str('JIRA_API_TOKEN');
  const tokenExpires = str('JIRA_TOKEN_EXPIRES');
  const allowedHosts = (str('JIRA_ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

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

  // The credentials actually used: the active profile wins over the top-level
  // variables, field by field, so a profile may override only the token.
  const effectiveSite = activeProfile?.site ?? site;
  const effectiveEmail = activeProfile?.email ?? email;
  const effectiveToken = activeProfile?.apiToken ?? apiToken;
  const profileName = activeProfile?.name;

  if (effectiveEmail === undefined) {
    add({
      severity: 'error',
      code: 'missing_credential',
      message: `${profileName === undefined ? 'JIRA_EMAIL' : profileVar(profileName, 'EMAIL')} is not set. Basic auth needs the Atlassian account email.`,
      field: profileName === undefined ? 'JIRA_EMAIL' : 'JIRA_EMAIL',
    });
  } else if (!effectiveEmail.includes('@')) {
    add({
      severity: 'error',
      code: 'invalid_email',
      message: `JIRA_EMAIL ${JSON.stringify(effectiveEmail)} is not an email address. Basic auth sends email:token, so a login name will always 401.`,
      field: 'JIRA_EMAIL',
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

  // --- Host ----------------------------------------------------------------
  const resolution = resolveHost(effectiveSite, allowedHosts);
  for (const problem of resolution.problems) add(fromHostProblem(problem));

  // --- Token expiry horizon ------------------------------------------------
  if (tokenExpires !== undefined) {
    const expiresAt = Date.parse(tokenExpires);
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
  const journalPath = str('JIRA_JOURNAL_PATH');

  const settings: Settings = {
    site,
    email,
    apiToken,
    tokenExpires,
    allowedHosts,
    profiles,
    activeProfile: activeProfileRaw,
    lockProfile,
    toolPackages: toolPackages.length > 0 ? toolPackages : [DEFAULT_TOOL_PACKAGES],
    packagesDeny,
    packagesReadonly,
    writeMode,
    requestTimeoutMs,
    callBudgetMs,
    hostConcurrency,
    retryAttempts,
    maxResultChars,
    maxPages,
    transport,
    httpPort,
    httpToken,
    logLevel,
    journalPath,
  };

  return {
    settings,
    report: buildReport(findings),
    secrets: collectSecrets(settings),
    ...(resolution.host === undefined ? {} : { host: resolution.host }),
    envFile,
  };
}

/** `JIRA_PROFILE_<NAME>_<FIELD>`, built rather than spelled out. */
function profileVar(name: string, field: 'SITE' | 'EMAIL' | 'API_TOKEN'): string {
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
 * Every secret value in the environment — the active token, the tokens of
 * INACTIVE profiles, and `JIRA_HTTP_TOKEN` (AUTH.md §Secret registration is
 * exhaustive at startup). Deduplicated and order-stable so the redactor's
 * longest-first ordering is reproducible.
 */
export function collectSecrets(settings: Settings): readonly string[] {
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    if (value !== undefined && value.length > 0) seen.add(value);
  };
  push(settings.apiToken);
  for (const profile of Object.values(settings.profiles)) push(profile.apiToken);
  push(settings.httpToken);
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
      'Fix the JIRA_* variables listed above (names and defaults: CONFIGURATION.md), then restart. `jira-mcp-ai doctor` prints the same report without starting the server.',
  });
}
