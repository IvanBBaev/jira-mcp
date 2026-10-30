// Transport and diagnostics (D516): stdio or the loopback HTTP transport with
// its bearer token (CC-30), the log level and the journal path.

import { resolveConfigPath } from '../config.js';
import type { EnvFileOptions } from '../config.js';
import {
  LOG_LEVELS,
  TRANSPORT_KINDS,
  type LogLevel,
  type Settings,
  type TransportKind,
} from '../types.js';
import { DEFAULT_HTTP_PORT, DEFAULT_LOG_LEVEL, DEFAULT_TRANSPORT } from './defaults.js';
import type { EnvReader } from './env-reader.js';
import type { Add } from './report.js';

/** The slice of `Settings` the transport section owns, in `Settings` key order. */
export type TransportSettings = Pick<Settings, 'transport' | 'httpPort' | 'httpToken'>;

/** Read the transport (CC-30). */
export function readTransport(read: EnvReader, add: Add): TransportSettings {
  const transport = read.enumOf<TransportKind>(
    'JIRA_TRANSPORT',
    TRANSPORT_KINDS,
    DEFAULT_TRANSPORT,
  );
  const httpPort = read.int('JIRA_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65535);
  const httpToken = read.str('JIRA_HTTP_TOKEN');
  if (transport === 'http' && httpToken === undefined) {
    add({
      severity: 'error',
      code: 'http_token_missing',
      message:
        'JIRA_TRANSPORT=http requires JIRA_HTTP_TOKEN; the HTTP transport fails closed without it (CC-30). Set a random bearer token or use the stdio transport.',
      field: 'JIRA_HTTP_TOKEN',
    });
  }
  return { transport, httpPort, httpToken };
}

/** The slice of `Settings` the diagnostics section owns, in `Settings` key order. */
export type DiagnosticSettings = Pick<Settings, 'logLevel' | 'journalPath'>;

/** Read the diagnostics knobs. */
export function readDiagnostics(
  read: EnvReader,
  options: EnvFileOptions,
): DiagnosticSettings {
  const logLevel = read.enumOf<LogLevel>('JIRA_LOG_LEVEL', LOG_LEVELS, DEFAULT_LOG_LEVEL);
  const journalPathRaw = read.str('JIRA_JOURNAL_PATH');
  const journalPath =
    journalPathRaw === undefined ? undefined : resolveConfigPath(journalPathRaw, options);
  return { logLevel, journalPath };
}
