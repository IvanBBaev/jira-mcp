// Transport and diagnostics (D516): stdio or the loopback HTTP transport with
// its bind address and bearer token (CC-30, D532), the log level and the
// journal path.

import { isIP } from 'node:net';

import { resolveConfigPath } from '../config.js';
import type { EnvFileOptions } from '../config.js';
import {
  LOG_LEVELS,
  TRANSPORT_KINDS,
  type LogLevel,
  type Settings,
  type TransportKind,
} from '../types.js';
import {
  DEFAULT_HTTP_BIND,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_TRANSPORT,
  MIN_HTTP_TOKEN_LENGTH,
} from './defaults.js';
import type { EnvReader } from './env-reader.js';
import type { Add } from './report.js';

/** The slice of `Settings` the transport section owns, in `Settings` key order. */
export type TransportSettings = Pick<
  Settings,
  'transport' | 'httpPort' | 'httpBind' | 'httpToken'
>;

/** How to make a token that passes the floor; doctor prints it with the error. */
const TOKEN_HINT =
  "Generate one with `openssl rand -hex 32` (or `node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"`) or use the stdio transport.";

/**
 * Loopback addresses: the whole 127/8 block and `::1`. Anything else, the
 * wildcards included, is a bind other machines may reach (D532).
 */
export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  return address === '::1';
}

/** Read the transport (CC-30, D532). */
export function readTransport(read: EnvReader, add: Add): TransportSettings {
  const transport = read.enumOf<TransportKind>(
    'JIRA_TRANSPORT',
    TRANSPORT_KINDS,
    DEFAULT_TRANSPORT,
  );
  const httpPort = read.int('JIRA_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65535);
  const httpBind = readBind(read, add, transport);
  const httpToken = read.str('JIRA_HTTP_TOKEN');
  if (transport === 'http' && httpToken === undefined) {
    add({
      severity: 'error',
      code: 'http_token_missing',
      message: `JIRA_TRANSPORT=http requires JIRA_HTTP_TOKEN; the HTTP transport fails closed without it. ${TOKEN_HINT}`,
      field: 'JIRA_HTTP_TOKEN',
    });
  } else if (transport === 'http' && httpToken !== undefined) {
    // Characters, not UTF-16 units: an emoji is one character to the person
    // who typed it. The message names the floor, never the value.
    const length = [...httpToken].length;
    if (length < MIN_HTTP_TOKEN_LENGTH) {
      add({
        severity: 'error',
        code: 'http_token_too_short',
        message: `JIRA_HTTP_TOKEN is ${String(length)} characters; the http transport needs at least ${String(MIN_HTTP_TOKEN_LENGTH)}. ${TOKEN_HINT}`,
        field: 'JIRA_HTTP_TOKEN',
      });
    }
  }
  return { transport, httpPort, httpBind, httpToken };
}

/**
 * `JIRA_HTTP_BIND` (D532): an IP literal, never a hostname — a name resolves
 * to whatever DNS says at listen time. A non-loopback bind is allowed, for a
 * container, and warned about loudly; the Host and Origin checks do not widen
 * with it.
 */
function readBind(read: EnvReader, add: Add, transport: TransportKind): string {
  const raw = read.str('JIRA_HTTP_BIND');
  if (raw === undefined) return DEFAULT_HTTP_BIND;
  if (isIP(raw) === 0) {
    add({
      severity: 'error',
      code: 'http_bind_invalid',
      message: `JIRA_HTTP_BIND must be an IP address such as 127.0.0.1 or 0.0.0.0, not a hostname; got ${JSON.stringify(raw)}.`,
      field: 'JIRA_HTTP_BIND',
    });
    return DEFAULT_HTTP_BIND;
  }
  if (transport === 'http' && !isLoopbackAddress(raw)) {
    add({
      severity: 'warning',
      code: 'http_bind_not_loopback',
      message: `JIRA_HTTP_BIND=${raw} listens beyond loopback: anything that can reach this address and holds the token can run every enabled tool against your Jira. Meant for a container published as \`-p 127.0.0.1:<port>:<port>\` only; requests must still name 127.0.0.1 or localhost in Host.`,
      field: 'JIRA_HTTP_BIND',
    });
  }
  return raw;
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
