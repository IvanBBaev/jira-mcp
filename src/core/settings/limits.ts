// HTTP behaviour (D516): timeouts, the call budget, concurrency, retries,
// result and paging caps, the metadata cache and the two output directories.

import { resolveConfigPath } from '../config.js';
import type { EnvFileOptions } from '../config.js';
import type { Settings } from '../types.js';
import {
  DEFAULT_CALL_BUDGET_MS,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_META_CACHE_TTL_S,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_ATTEMPTS,
} from './defaults.js';
import type { EnvReader } from './env-reader.js';
import type { Add } from './report.js';

/** The slice of `Settings` the limits section owns, in `Settings` key order. */
export type LimitSettings = Pick<
  Settings,
  | 'requestTimeoutMs'
  | 'callBudgetMs'
  | 'hostConcurrency'
  | 'retryAttempts'
  | 'maxResultChars'
  | 'maxPages'
  | 'metaCacheTtlS'
  | 'mediaDir'
  | 'reportDir'
>;

/** Read the HTTP behaviour knobs. */
export function readLimits(
  read: EnvReader,
  options: EnvFileOptions,
  add: Add,
): LimitSettings {
  const requestTimeoutMs = read.int(
    'JIRA_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    600000,
  );
  const callBudgetMs = read.int(
    'JIRA_CALL_BUDGET_MS',
    DEFAULT_CALL_BUDGET_MS,
    1,
    3600000,
  );
  const hostConcurrency = read.int(
    'JIRA_HOST_CONCURRENCY',
    DEFAULT_HOST_CONCURRENCY,
    1,
    64,
  );
  const retryAttempts = read.int('JIRA_RETRY_ATTEMPTS', DEFAULT_RETRY_ATTEMPTS, 0, 10);
  const maxResultChars = read.int(
    'JIRA_MAX_RESULT_CHARS',
    DEFAULT_MAX_RESULT_CHARS,
    500,
    10000000,
  );
  const maxPages = read.int('JIRA_MAX_PAGES', DEFAULT_MAX_PAGES, 1, 1000);
  // `0` is a legal value — it switches the metadata cache off (D123).
  const metaCacheTtlS = read.int(
    'JIRA_META_CACHE_TTL_S',
    DEFAULT_META_CACHE_TTL_S,
    0,
    86400,
  );
  // Both paths are normalised the way `JIRA_ENV_FILE` is (CC-184): an env var
  // carries no shell expansion, so `~/jira-media` would otherwise name a
  // directory called `~` under whatever cwd the client spawned the server in.
  const mediaDirRaw = read.str('JIRA_MEDIA_DIR');
  const mediaDir =
    mediaDirRaw === undefined ? undefined : resolveConfigPath(mediaDirRaw, options);
  const reportDirRaw = read.str('JIRA_REPORT_DIR');
  const reportDir =
    reportDirRaw === undefined ? undefined : resolveConfigPath(reportDirRaw, options);

  if (callBudgetMs < requestTimeoutMs) {
    add({
      severity: 'warning',
      code: 'budget_below_timeout',
      message: `JIRA_CALL_BUDGET_MS (${String(callBudgetMs)}) is below JIRA_REQUEST_TIMEOUT_MS (${String(requestTimeoutMs)}); a single slow request will exhaust the whole call budget.`,
      field: 'JIRA_CALL_BUDGET_MS',
    });
  }

  return {
    requestTimeoutMs,
    callBudgetMs,
    hostConcurrency,
    retryAttempts,
    maxResultChars,
    maxPages,
    metaCacheTtlS,
    mediaDir,
    reportDir,
  };
}
