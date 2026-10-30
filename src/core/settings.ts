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
//
// This module is a re-export barrel (D516): `loadSettings` in
// `settings/load.ts` folds one reader per section — auth and OAuth, profiles,
// the per-mode requirements and deployment, the token horizon, the tool
// surface, HTTP limits, transport and diagnostics, secret registration — in
// the fixed order that is the report's finding order. Nothing outside
// `core/settings*` imports a section module directly.

export {
  DEFAULT_AUTH_MODE,
  DEFAULT_CALL_BUDGET_MS,
  DEFAULT_DEPLOYMENT,
  DEFAULT_EXPORT_SUBDIR,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_HTTP_BIND,
  DEFAULT_HTTP_PORT,
  DEFAULT_IRREVERSIBLE_CONFIRM,
  DEFAULT_LOCK_PROFILE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_META_CACHE_TTL_S,
  DEFAULT_OAUTH_AUTH_ORIGIN,
  DEFAULT_OAUTH_GATEWAY_ORIGIN,
  DEFAULT_OAUTH_GRANT,
  DEFAULT_OAUTH_REDIRECT_PORT,
  DEFAULT_OAUTH_SCOPES,
  DEFAULT_OAUTH_TOKEN_FILE_DOC,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_TOOL_PACKAGES,
  DEFAULT_TRANSPORT,
  DEFAULT_WRITE_MODE,
  MIN_HTTP_TOKEN_LENGTH,
  TOKEN_EXPIRY_WARNING_DAYS,
} from './settings/defaults.js';
export { splitAllowedHosts } from './settings/hosts.js';
export { isLoopbackAddress } from './settings/transport.js';
export { resolveExportDir } from './settings/limits.js';
export type { ExportDirResolution } from './settings/limits.js';
export { loadSettings } from './settings/load.js';
export type { LoadSettingsOptions, LoadSettingsResult } from './settings/load.js';
export { profileVar } from './settings/profiles.js';
export { assertStartupOk, buildReport, formatStartupReport } from './settings/report.js';
export type {
  FindingSeverity,
  StartupFinding,
  StartupReport,
} from './settings/report.js';
export { collectSecrets } from './settings/secrets.js';
export { PROJECT_KEY_PATTERN } from './settings/surface.js';
export { isIsoDate } from './settings/token-expiry.js';
