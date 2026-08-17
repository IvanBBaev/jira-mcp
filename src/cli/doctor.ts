// `jira-mcp-ai doctor` — the operator-facing health check (AUTH.md §Doctor).
//
// Four properties this module owns:
//
//  1. **The report goes to stdout, the log events to stderr** (D11). Doctor is a
//     CLI run, so no MCP protocol occupies stdout — but the writers are injected
//     rather than `console.log`, so a caller (and a test) can capture the report
//     and the `no-console` rule stays enforced.
//  2. **`run()` returns the exit code.** There is no `process.exit` anywhere in
//     this file: the bin dispatcher decides what to do with the number, which is
//     also what makes every exit path assertable from a test.
//  3. **Every probe runs.** A failing probe never short-circuits the rest — an
//     operator repairing a broken setup wants the whole picture in one pass, not
//     one problem per invocation.
//  4. **Nothing reaches the wire directly.** Probes issue `JiraRequestSpec`s
//     through an injected `JiraRequestFn`; `core/http.ts` remains the only
//     module that knows what `fetch` is.
//
// Exit codes (AUTH.md): 0 = all probes green (warnings allowed), 1 = at least
// one probe failed, 2 = a usage or configuration error prevented probing.

import { closeSync, openSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { systemClock } from '../core/clock.js';
import { effectiveCredentials } from '../core/credentials.js';
import {
  nodeEnvFileHost,
  preferredEnvFilePath,
  resolveEnvFileCandidates,
  type EnvFileHost,
  type EnvFileOptions,
  type EnvFileResult,
} from '../core/config.js';
import {
  SECRET_FILE_MODE,
  writeGuardedFile,
  type EnvLockOptions,
} from '../core/env-lock.js';
import { toJiraError } from '../core/errors.js';
import { isCanonicalCloudHost } from '../core/host.js';
import { createJiraRequest, type JiraHttpOptions } from '../core/http.js';
import { createLogger, NO_CID } from '../core/log.js';
import { createRedactor } from '../core/redact.js';
import { systemRng } from '../core/rng.js';
import {
  loadSettings,
  TOKEN_EXPIRY_WARNING_DAYS,
  type LoadSettingsResult,
  type StartupFinding,
} from '../core/settings.js';
import { createTelemetry, type Counters } from '../core/telemetry.js';
import type {
  Clock,
  HostRef,
  JiraRequestFn,
  Logger,
  Redactor,
  Rng,
  Settings,
} from '../core/types.js';
// `cli/` is a composition root (eslint layer zones), so reaching up into `mcp/`
// is allowed. `expandSelection` is imported rather than re-implemented on
// purpose: doctor's contract is that it reports what the server would do, and a
// second copy of the package vocabulary is exactly how the two came apart.
// `mcp/registry.ts` pulls in no zod and no SDK, so the import stays cheap.
import { expandSelection } from '../mcp/registry.js';

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** Every probe passed; warnings do not change this. */
export const EXIT_OK = 0;
/** At least one probe failed. */
export const EXIT_PROBE_FAILED = 1;
/** A usage error or a broken configuration prevented a meaningful run. */
export const EXIT_CONFIG = 2;

/**
 * The JQL the search probe sends.
 *
 * Exported so the regression test can assert on its shape rather than on a
 * fixture. The leading clause is a RESTRICTION, not a filter: Jira refuses a
 * query that restricts nothing on sites above some size it does not publish,
 * and answers HTTP 400 "Unbounded JQL queries are not allowed here" (D88). A
 * lower bound that predates Jira itself satisfies that rule while still
 * matching every issue the token can see.
 */
export const SEARCH_PROBE_JQL = 'created >= "1970-01-01" order by created desc';

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** Status of one finding, and — as the worst of its findings — of one probe. */
export type ProbeStatus = 'ok' | 'info' | 'skip' | 'warn' | 'fail';

/** Rank used to fold a probe's findings into one status. */
const STATUS_RANK: Readonly<Record<ProbeStatus, number>> = {
  ok: 0,
  info: 1,
  skip: 2,
  warn: 3,
  fail: 4,
};

/** One observation. `remediation` is the next action, never a restatement. */
export interface DoctorFinding {
  readonly status: ProbeStatus;
  readonly text: string;
  readonly remediation?: string;
}

/** One probe's outcome, as it appears in the `--json` report. */
export interface ProbeReport {
  readonly id: string;
  readonly title: string;
  readonly status: ProbeStatus;
  readonly findings: readonly DoctorFinding[];
}

/** The whole `--json` document: one object, one line-free JSON tree. */
export interface DoctorReport {
  /** True iff no probe failed. Warnings keep it true (AUTH.md). */
  readonly ok: boolean;
  readonly exitCode: number;
  readonly offline: boolean;
  /** Epoch ms from the injected clock. */
  readonly ts: number;
  /** Resolved origin, or `null` when `JIRA_SITE` never resolved. */
  readonly host: string | null;
  readonly summary: Readonly<Record<ProbeStatus, number>>;
  readonly probes: readonly ProbeReport[];
  /**
   * What the probes cost on the wire (D12, OBSERVABILITY.md §Counters):
   * requests, retries, rate-limit waits and errors by kind. This run's numbers
   * only — the counters live and die with the process, so a doctor run reports
   * its own probes and nothing else.
   *
   * Absent when a caller injected its own `jiraRequest`: that seam bypasses the
   * telemetry `core/http.ts` increments, and zeros would then be a lie rather
   * than a fact. Offline runs DO report zeros — no request is an honest zero.
   */
  readonly counters?: Counters;
}

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

/**
 * The filesystem doctor touches beyond env-file resolution: the journal probe
 * and `--save`. Separate from `EnvFileHost` because that seam is `core`'s and
 * must not grow a writer.
 */
export interface DoctorFsHost {
  /** File contents, or `undefined` when it does not exist or cannot be read. */
  readText(path: string): string | undefined;
  /** Open for append (creating at 0600), then close. Throws on failure. */
  touchAppend(path: string): void;
  /** Atomic 0600 write under the cross-process env lock. */
  writeSecret(path: string, contents: string, options: EnvLockOptions): Promise<void>;
}

/** The real filesystem. */
export const nodeDoctorFs: DoctorFsHost = {
  readText(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  touchAppend(path: string): void {
    const fd = openSync(path, 'a', SECRET_FILE_MODE);
    closeSync(fd);
  },
  async writeSecret(
    path: string,
    contents: string,
    options: EnvLockOptions,
  ): Promise<void> {
    await writeGuardedFile(path, contents, options);
  },
};

/** One question to the operator. `secret` marks input that must not be stored. */
export type DoctorPrompt = (
  question: string,
  options: { readonly secret: boolean },
) => Promise<string>;

/** Everything ambient, injectable. Defaults are the real host. */
export interface DoctorOptions {
  /**
   * Arguments after the subcommand — `['--json']`, not `['doctor', '--json']`.
   * Defaults to none: the dispatcher (`src/index.ts`) has already split the
   * subcommand off, and re-reading `process.argv` here would feed the word
   * `doctor` back into the parser as an unexpected argument.
   */
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  /** Env-file filesystem seam (stat + load). */
  readonly envFileHost?: EnvFileHost;
  readonly clock?: Clock;
  readonly rng?: Rng;
  readonly logger?: Logger;
  /** Defaults to a fresh redactor; the settings' secrets are registered either way. */
  readonly redactor?: Redactor;
  /** The doctor report (D11). Defaults to `process.stdout`. */
  readonly stdout?: (text: string) => void;
  /** Usage errors and lock diagnostics. Defaults to `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** Whether prompting is allowed; defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  /** Pre-built request function — tests inject the fake here. */
  readonly jiraRequest?: JiraRequestFn;
  /** Factory used when `jiraRequest` is absent. Defaults to `createJiraRequest`. */
  readonly createRequest?: (options: JiraHttpOptions) => JiraRequestFn;
  readonly fs?: DoctorFsHost;
  readonly prompt?: DoctorPrompt;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface DoctorFlags {
  readonly json: boolean;
  readonly offline: boolean;
  readonly save: boolean;
  readonly help: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly flags: DoctorFlags }
  | { readonly ok: false; readonly message: string };

/** The `--help` text; also printed above a usage error. */
export function doctorUsage(): string {
  return [
    'Usage: jira-mcp-ai doctor [options]',
    '',
    'Checks the configuration and the connection to your Jira site.',
    '',
    'Options:',
    '  --json      Print one machine-readable report object instead of text.',
    '  --offline   Run only the local probes; make no network calls.',
    '  --save      Prompt for credentials and write them to the env file,',
    '              then exit without probing (re-run doctor to verify).',
    '  -h, --help  Show this text.',
    '',
    'Exit codes: 0 all probes passed, 1 a probe failed, 2 usage or config error.',
    '',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): ParseResult {
  let json = false;
  let offline = false;
  let save = false;
  let help = false;

  for (const arg of argv) {
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--offline':
        offline = true;
        break;
      case '--save':
        save = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        return {
          ok: false,
          message: arg.startsWith('-')
            ? `Unknown option ${JSON.stringify(arg)}.`
            : `Unexpected argument ${JSON.stringify(arg)}; doctor takes options only.`,
        };
    }
  }

  if (save && json) {
    return {
      ok: false,
      message:
        '--save prompts for input, which --json cannot represent; use one or the other.',
    };
  }

  return { ok: true, flags: { json, offline, save, help } };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const LABEL: Readonly<Record<ProbeStatus, string>> = {
  ok: '[ ok ]',
  info: '[info]',
  skip: '[skip]',
  warn: '[warn]',
  fail: '[FAIL]',
};

const INDENT = ' '.repeat(LABEL.ok.length + 1);

function unit(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** `0600`, the way `chmod` spells it — a decimal mode is a support ticket. */
function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function worstOf(findings: readonly DoctorFinding[]): ProbeStatus {
  let worst: ProbeStatus = 'ok';
  for (const finding of findings) {
    if (STATUS_RANK[finding.status] > STATUS_RANK[worst]) worst = finding.status;
  }
  return worst;
}

function renderProbe(probe: ProbeReport): string {
  let out = '';
  for (const finding of probe.findings) {
    out += `${LABEL[finding.status]} ${probe.title}: ${finding.text}\n`;
    if (finding.remediation !== undefined && finding.remediation !== '') {
      out += `${INDENT}→ ${finding.remediation}\n`;
    }
  }
  return out;
}

function renderSummary(report: DoctorReport): string {
  const order: readonly ProbeStatus[] = ['ok', 'info', 'skip', 'warn', 'fail'];
  const words: Readonly<Record<ProbeStatus, string>> = {
    ok: 'passed',
    info: 'informational',
    skip: 'skipped',
    warn: 'warning',
    fail: 'failed',
  };
  const parts = order
    .filter((status) => report.summary[status] > 0)
    .map((status) => `${String(report.summary[status])} ${words[status]}`);
  const line = `\n${unit(report.probes.length, 'probe', 'probes')}: ${parts.join(', ')}\n`;
  return report.counters === undefined ? line : line + renderCounters(report.counters);
}

/**
 * The counters line (D12). One line, and only the numbers that are not zero
 * beyond the request count — an operator whose run had no retries should not
 * have to read that it had none.
 */
function renderCounters(counters: Counters): string {
  const errorKinds = Object.entries(counters.errors);
  const errorTotal = errorKinds.reduce((sum, [, count]) => sum + count, 0);
  const parts = [unit(counters.requests, 'request', 'requests')];
  if (counters.retries > 0) parts.push(unit(counters.retries, 'retry', 'retries'));
  if (counters.rateLimitWaits > 0) {
    parts.push(unit(counters.rateLimitWaits, 'rate-limit wait', 'rate-limit waits'));
  }
  if (errorTotal > 0) {
    const detail = errorKinds
      .map(([kind, count]) => `${kind} ${String(count)}`)
      .join(', ');
    parts.push(`${unit(errorTotal, 'error', 'errors')} (${detail})`);
  }
  return `HTTP: ${parts.join(', ')}\n`;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface DoctorContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly settings: Settings;
  readonly loaded: LoadSettingsResult;
  readonly host?: HostRef;
  readonly envFile: EnvFileResult;
  readonly envFileHost: EnvFileHost;
  readonly fs: DoctorFsHost;
  readonly offline: boolean;
  /** Startup findings routed to one probe, so no finding is printed twice. */
  findingsFor(probeId: string): readonly StartupFinding[];
  /** Absent when offline, or when the configuration cannot produce a client. */
  readonly request?: JiraRequestFn;
}

interface Probe {
  readonly id: string;
  readonly title: string;
  /** Network probes are the ones `--offline` skips (AUTH.md: local are 1–3, 8–10). */
  readonly network: boolean;
  run(ctx: DoctorContext): readonly DoctorFinding[] | Promise<readonly DoctorFinding[]>;
}

/** Host problems own probe 2; `core/host.ts` is the authority on the codes. */
const HOST_CODES: ReadonlySet<string> = new Set([
  'site_missing',
  'site_malformed',
  'site_credentials',
  'site_scheme',
  'site_port',
  'site_path_stripped',
  'host_not_allowed',
  'allowlist_invalid_pattern',
]);

/** Which probe reports a given startup finding. Everything lands somewhere. */
function probeOfFinding(finding: StartupFinding): string {
  if (finding.code.startsWith('env_file_')) return 'env-file';
  if (HOST_CODES.has(finding.code)) return 'host';
  if (finding.field === 'JIRA_TOKEN_EXPIRES') return 'token-expiry';
  return 'settings';
}

function fromStartupFinding(finding: StartupFinding): DoctorFinding {
  return {
    status: finding.severity === 'error' ? 'fail' : 'warn',
    text: finding.message,
  };
}

/** A `JiraError`-shaped failure rendered as one finding. */
function fromError(
  error: unknown,
  status: ProbeStatus,
  redactor: Redactor,
): DoctorFinding {
  const wrapped = toJiraError(error, { redactor });
  return {
    status,
    text: `${wrapped.message} (kind ${wrapped.kind})`,
    ...(wrapped.remediation !== undefined && wrapped.remediation !== ''
      ? { remediation: wrapped.remediation }
      : {}),
  };
}

/**
 * The gating triple, checked the way the registry checks it (CC-88).
 *
 * `core/settings.ts` splits these three variables into token lists but never
 * looks the tokens up — the vocabulary lives in `mcp/registry.ts`, and the
 * server only meets it while building the tool surface. Doctor used to print the
 * raw tokens as an `info` line, so a misspelt package (or an unexpanded
 * `${user_config.…}` placeholder arriving from a plugin manifest) produced a
 * green `doctor` and a server that then refused to start with exit 2 — the exact
 * opposite of what `assertStartupOk`'s remediation promises about doctor.
 *
 * `expandSelection` is pure and throws a `config` `JiraError` naming the token
 * and the vocabulary, so the finding carries the same words the server prints.
 */
function selectionProblems(settings: Settings): readonly DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const selections: readonly (readonly [string, readonly string[]])[] = [
    ['JIRA_TOOL_PACKAGES', settings.toolPackages],
    ['JIRA_PACKAGES_DENY', settings.packagesDeny],
    ['JIRA_PACKAGES_READONLY', settings.packagesReadonly],
  ];

  for (const [envVar, tokens] of selections) {
    try {
      expandSelection(tokens, envVar);
    } catch (error) {
      const wrapped = toJiraError(error);
      findings.push({
        status: 'fail',
        text: wrapped.message,
        ...(wrapped.remediation !== undefined && wrapped.remediation !== ''
          ? { remediation: wrapped.remediation }
          : {}),
      });
    }
  }
  return findings;
}

/**
 * A `${…}` a client was supposed to substitute and did not.
 *
 * Deliberately narrow: it matches the substitution syntaxes clients actually
 * use — Claude Code's `${user_config.KEY}`, a plain `${VAR}`, VS Code's
 * `${env:VAR}` / `${input:token}` — and nothing that a real value plausibly
 * contains. `JIRA_ALLOWED_HOSTS` takes anchored regexes, and `$` followed by
 * `{` is not a shape any of them has.
 */
const UNEXPANDED_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_.:-]*\}/;

/**
 * Variables still holding a literal placeholder (D84).
 *
 * A manifest that offers an optional field the operator leaves blank, or a
 * client that does not implement the substitution at all, hands the server the
 * placeholder text verbatim. Some variables catch that themselves — a
 * `JIRA_WRITE_MODE` outside `plan | apply` is a settings error, a `JIRA_SITE`
 * that is not a DNS name is a host error — but the free-text ones do not:
 * `JIRA_MEDIA_DIR=${user_config.jira_media_dir}` is a perfectly good relative
 * directory name, so it loaded clean and doctor went green while the attachment
 * sandbox pointed at a directory of that literal name. `JIRA_API_TOKEN` and
 * `JIRA_EMAIL` behave the same way offline.
 *
 * Variables that a startup finding already names are skipped: the operator gets
 * one line per broken variable, and the more specific line is the one the
 * loader wrote.
 *
 * Only the matched placeholder is printed, never the whole value — a value may
 * be `${VAR}` glued to something secret.
 */
function placeholderProblems(ctx: DoctorContext): readonly DoctorFinding[] {
  const alreadyNamed = new Set(
    ctx.loaded.report.findings
      .map((finding) => finding.field)
      .filter((field): field is string => field !== undefined),
  );
  const findings: DoctorFinding[] = [];
  for (const key of Object.keys(ctx.env).sort()) {
    if (!key.startsWith('JIRA_') || alreadyNamed.has(key)) continue;
    const value = ctx.env[key];
    const match = value === undefined ? null : UNEXPANDED_PLACEHOLDER.exec(value);
    if (match === null) continue;
    findings.push({
      status: 'fail',
      text: `${key} still holds the literal placeholder ${match[0]}; whatever launched this server did not substitute it`,
      remediation: `Give ${key} a real value in the client config or the env file, or remove the variable — this text is used verbatim, not resolved.`,
    });
  }
  return findings;
}

/** Read a string field out of an `unknown` JSON body without an unsafe cast. */
function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : undefined;
}

/** Length of an array field, or `undefined` when it is not an array. */
function readArrayLength(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return Array.isArray(found) ? found.length : undefined;
}

const MS_PER_DAY = 86400000;

/**
 * What to report about the env file.
 *
 * `loadSettings` only touches the filesystem when it is reading `process.env` —
 * a caller-supplied environment is used verbatim, which is what makes tests
 * hermetic. Doctor still owes the operator the answer to "which file would be
 * used, and is it 0600?", so in that case it resolves and stats the candidates
 * itself without ever loading them.
 */
function describeEnvFile(
  result: EnvFileResult,
  options: EnvFileOptions,
  host: EnvFileHost,
): EnvFileResult {
  if (result.candidates.length > 0) return result;
  const candidates = resolveEnvFileCandidates(options);
  for (const candidate of candidates) {
    const mode = host.statFile(candidate.path);
    if (mode !== undefined) {
      return {
        loaded: false,
        path: candidate.path,
        source: candidate.source,
        mode,
        candidates,
        problems: [],
      };
    }
  }
  return { loaded: false, candidates, problems: [] };
}

const PROBES: readonly Probe[] = [
  {
    id: 'settings',
    title: 'settings',
    network: false,
    run(ctx) {
      const problems = [
        ...ctx.findingsFor('settings').map(fromStartupFinding),
        ...placeholderProblems(ctx),
      ];
      const count = Object.keys(ctx.env).filter((key) => key.startsWith('JIRA_')).length;
      const summary: DoctorFinding = {
        status: problems.length === 0 ? 'ok' : 'info',
        text: `${unit(count, 'JIRA_* variable', 'JIRA_* variables')} present, log level ${ctx.settings.logLevel}`,
      };
      return [summary, ...problems];
    },
  },
  {
    id: 'host',
    title: 'host',
    network: false,
    run(ctx) {
      const problems = ctx.findingsFor('host').map(fromStartupFinding);
      const host = ctx.host;
      if (host === undefined) {
        // `resolveHost` withholds the host ONLY after pushing an error-severity
        // problem, and every code it can push is in HOST_CODES — so `problems`
        // is never empty here. The cause is printed FIRST and this line second:
        // an operator reading top-to-bottom must meet "JIRA_SITE is not set"
        // before "every network probe is skipped", not the other way round.
        return [
          ...problems,
          { status: 'info', text: 'no usable site; every network probe is skipped' },
        ];
      }
      const hostname = new URL(host.origin).hostname;
      // `host.pathPrefix` is `V1_PATH_PREFIX` — the empty string, and
      // `core/host.ts` is its only producer. There is nothing to report about it
      // until a deployment that needs a prefix (Data Center, v2) exists.
      return [
        {
          status: 'ok',
          text: `${host.origin} — ${
            isCanonicalCloudHost(hostname)
              ? 'canonical Atlassian Cloud host'
              : `allowed by JIRA_ALLOWED_HOSTS (${unit(ctx.settings.allowedHosts.length, 'entry', 'entries')})`
          }`,
        },
        ...problems,
      ];
    },
  },
  {
    id: 'env-file',
    title: 'env file',
    network: false,
    run(ctx) {
      const problems = ctx.findingsFor('env-file');
      const findings: DoctorFinding[] = problems.map(fromStartupFinding);
      const file = ctx.envFile;

      if (file.path === undefined) {
        // `resolveEnvFileCandidates` always ends with the project `.env`, so the
        // candidate list is never empty and "looked at …" always names a path.
        const where = file.candidates.map((candidate) => candidate.path);
        return [
          {
            status: 'info',
            text: `no env file found; looked at ${where.map(quote).join(', ')}`,
          },
          ...findings,
        ];
      }

      const head: DoctorFinding = {
        status: 'ok',
        text: `${file.loaded ? 'loaded' : 'found'} ${quote(file.path)} (${file.source ?? 'unknown'} location)`,
      };

      // `loadEnvFile` already reports a permissive mode as a startup finding
      // when it LOADED the file; only re-derive the verdict when it did not.
      const reported = problems.some((finding) => finding.code === 'env_file_permissive');
      const mode = file.mode;
      if (!reported && mode !== undefined && ctx.platform !== 'win32') {
        findings.push(
          (mode & 0o077) === 0
            ? { status: 'ok', text: `mode ${octal(mode)}` }
            : {
                status: 'warn',
                text: `mode ${octal(mode)} is readable beyond the owner`,
                remediation: `chmod 600 ${file.path}`,
              },
        );
      }
      return [head, ...findings];
    },
  },
  {
    id: 'identity',
    title: 'identity',
    network: true,
    async run(ctx) {
      const response = await ctx.request?.({ method: 'GET', path: '/myself' });
      const data: unknown = response?.data;
      const accountId = readString(data, 'accountId');
      const displayName = readString(data, 'displayName');
      const timeZone = readString(data, 'timeZone');
      if (accountId === undefined) {
        return [
          {
            status: 'fail',
            text: '/myself answered without an accountId',
            remediation:
              'The site returned an unexpected body — check that JIRA_SITE points at a Jira Cloud site and not at a proxy.',
          },
        ];
      }
      const findings: DoctorFinding[] = [
        {
          status: 'ok',
          text: `${displayName ?? 'unnamed account'} (accountId ${accountId})`,
        },
      ];
      findings.push(
        timeZone === undefined
          ? {
              status: 'warn',
              text: 'the account has no timezone; worklog offsets fall back to the host timezone',
            }
          : { status: 'info', text: `timezone ${timeZone}` },
      );
      return findings;
    },
  },
  {
    id: 'deployment',
    title: 'deployment',
    network: true,
    async run(ctx) {
      const response = await ctx.request?.({ method: 'GET', path: '/serverInfo' });
      const data: unknown = response?.data;
      const deployment = readString(data, 'deploymentType');
      const version = readString(data, 'version');
      const suffix = version === undefined ? '' : ` (version ${version})`;
      if (deployment === undefined) {
        return [
          { status: 'warn', text: `/serverInfo reported no deploymentType${suffix}` },
        ];
      }
      return [
        deployment === 'Cloud'
          ? { status: 'ok', text: `Jira Cloud${suffix}` }
          : {
              status: 'warn',
              text: `deployment type is ${deployment}, not Cloud${suffix}`,
              remediation:
                'v1 targets Jira Cloud only (D2); Server/Data Center endpoints and auth differ and are not supported.',
            },
      ];
    },
  },
  {
    id: 'search',
    title: 'search',
    network: true,
    async run(ctx) {
      const response = await ctx.request?.({
        method: 'POST',
        path: '/search/jql',
        // A pure read behind a POST verb: safe to replay (JIRA-API.md).
        safe: true,
        body: { jql: SEARCH_PROBE_JQL, maxResults: 1, fields: ['key'] },
      });
      const data: unknown = response?.data;
      const issues = readArrayLength(data, 'issues');
      if (issues === undefined) {
        return [
          {
            status: 'fail',
            text: 'search/jql answered without an issues array',
            remediation:
              'Only /rest/api/3/search/jql is supported (D6); a body without `issues` suggests a proxy or an older endpoint.',
          },
        ];
      }
      const more = readString(data, 'nextPageToken') !== undefined;
      return [
        {
          status: 'ok',
          text: `search/jql returned ${unit(issues, 'issue', 'issues')}${more ? ' (more pages available)' : ''}`,
        },
      ];
    },
  },
  {
    id: 'agile',
    title: 'agile',
    network: true,
    async run(ctx) {
      try {
        const response = await ctx.request?.({
          method: 'GET',
          path: '/board',
          root: 'agile',
          query: { maxResults: 1 },
        });
        const values = readArrayLength(response?.data, 'values');
        if (values === undefined) {
          return [
            {
              status: 'warn',
              text: '/rest/agile/1.0/board answered without a values array',
            },
          ];
        }
        return [
          {
            status: values === 0 ? 'info' : 'ok',
            text: `${unit(values, 'board', 'boards')} visible on the first page`,
            ...(values === 0
              ? {
                  remediation:
                    'The agile tools will find nothing until this account can see at least one board.',
                }
              : {}),
          },
        ];
      } catch (error) {
        // A site without Jira Software, or an account without the permission,
        // is a working setup with fewer tools — never a doctor failure.
        return [
          {
            ...fromError(error, 'warn', ctx.redactor),
            remediation:
              'The agile package (boards, sprints, backlog) will not work on this site; the rest of the server will.',
          },
        ];
      }
    },
  },
  {
    id: 'journal',
    title: 'journal',
    network: false,
    run(ctx) {
      const path = ctx.settings.journalPath;
      if (path === undefined) {
        return [
          {
            status: 'info',
            text: 'JIRA_JOURNAL_PATH is not set; writes are not journaled',
          },
        ];
      }
      try {
        ctx.fs.touchAppend(path);
      } catch (error) {
        return [
          {
            status: 'fail',
            text: `cannot append to ${quote(path)}: ${error instanceof Error ? error.message : 'unknown error'}`,
            remediation:
              'Point JIRA_JOURNAL_PATH at a writable file in an existing directory, or unset it.',
          },
        ];
      }
      const findings: DoctorFinding[] = [
        { status: 'ok', text: `appendable: ${quote(path)}` },
      ];
      const mode = ctx.envFileHost.statFile(path);
      if (mode !== undefined && ctx.platform !== 'win32' && (mode & 0o077) !== 0) {
        findings.push({
          status: 'warn',
          text: `mode ${octal(mode)} is readable beyond the owner`,
          remediation: `chmod 600 ${path}`,
        });
      }
      return findings;
    },
  },
  {
    id: 'token-expiry',
    title: 'token expiry',
    network: false,
    run(ctx) {
      const problems = ctx.findingsFor('token-expiry').map(fromStartupFinding);
      const raw = ctx.settings.tokenExpires;
      if (raw === undefined) {
        return [
          {
            status: 'info',
            text: 'JIRA_TOKEN_EXPIRES is not set; expiry cannot be checked',
            remediation:
              'Set it to the date shown on the API-token page to get a warning before the token dies.',
          },
          ...problems,
        ];
      }
      const expiresAt = Date.parse(raw);
      if (Number.isNaN(expiresAt)) return problems;
      const daysLeft = Math.floor((expiresAt - ctx.clock.now()) / MS_PER_DAY);
      if (daysLeft <= TOKEN_EXPIRY_WARNING_DAYS) return problems;
      return [
        {
          status: 'ok',
          text: `the API token expires in ${unit(daysLeft, 'day', 'days')}`,
        },
        ...problems,
      ];
    },
  },
  {
    id: 'gating',
    title: 'gating',
    network: false,
    run(ctx) {
      const settings = ctx.settings;
      const findings: DoctorFinding[] = [
        settings.writeMode === 'apply'
          ? {
              status: 'warn',
              text: 'write mode is apply: write tools execute when a call passes apply: true',
              remediation:
                'Set JIRA_WRITE_MODE=plan to make writes describe themselves instead.',
            }
          : {
              status: 'ok',
              text: 'write mode is plan: writes describe instead of executing',
            },
        {
          status: 'info',
          text: `packages ${settings.toolPackages.join(',')}${
            settings.packagesDeny.length > 0
              ? `, denied ${settings.packagesDeny.join(',')}`
              : ''
          }${
            settings.packagesReadonly.length > 0
              ? `, read-only ${settings.packagesReadonly.join(',')}`
              : ''
          }`,
        },
        ...selectionProblems(settings),
      ];

      findings.push(
        settings.transport === 'stdio'
          ? { status: 'ok', text: 'transport stdio' }
          : {
              status: 'fail',
              text: `transport ${settings.transport} is not available in v1`,
              remediation:
                'Unset JIRA_TRANSPORT or set it to stdio; HTTP is planned for v1.5 (D19).',
            },
      );

      const profile = settings.activeProfile;
      if (profile !== undefined) {
        findings.push({
          status: 'info',
          text: `active profile ${quote(profile)}${settings.lockProfile ? ' (locked)' : ''}`,
        });
      }
      if (!settings.lockProfile) {
        findings.push({
          status: 'warn',
          text: 'JIRA_LOCK_PROFILE is off: a tool call may choose the tenant it talks to',
          remediation:
            'Leave it at the default unless you deliberately want per-call switching.',
        });
      }
      return findings;
    },
  },
];

// ---------------------------------------------------------------------------
// `--save`
// ---------------------------------------------------------------------------

/** Env values that need no quoting; anything else is double-quoted and escaped. */
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function renderEnvValue(value: string): string {
  if (PLAIN_ENV_VALUE.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

function isAssignmentFor(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  const body = trimmed.startsWith('export ')
    ? trimmed.slice('export '.length).trimStart()
    : trimmed;
  return body.startsWith(`${key}=`) || body.startsWith(`${key} =`);
}

/**
 * Rewrite only the keys we set, keeping every other line — comments, unrelated
 * variables, ordering — verbatim. An env file is hand-edited; replacing it
 * wholesale would silently delete whatever else lives there.
 */
export function mergeEnvFile(
  existing: string | undefined,
  values: readonly (readonly [string, string])[],
): string {
  const lines = existing === undefined || existing === '' ? [] : existing.split('\n');
  // A file that ends in a newline splits to a trailing "" — appending after it
  // would open a blank line between the old keys and the new ones.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of values) {
    const rendered = `${key}=${renderEnvValue(value)}`;
    const index = lines.findIndex((line) => isAssignmentFor(line, key));
    if (index >= 0) lines[index] = rendered;
    else lines.push(rendered);
  }
  const body = lines.join('\n').replace(/\n+$/, '');
  return `${body}\n`;
}

/**
 * The real prompt, over any stream pair: one question on `output`, one line read
 * from `input`, surrounding whitespace trimmed off the answer.
 *
 * The streams are parameters rather than `process.stdin`/`process.stdout` hard-
 * wired inside so the adapter itself is reachable from a test without owning the
 * process's stdin — the readline lifecycle (an interface that is never closed
 * hangs the CLI) is exactly the part worth pinning.
 *
 * `secret` is deliberately not honoured: there is no echo suppression here, and
 * `--save` says so in its banner. Pretending otherwise would be worse than
 * saying it plainly.
 */
export function createReadlinePrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): DoctorPrompt {
  return async (question) => {
    const rl = createInterface({ input, output });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run the doctor and RETURN the exit code — the caller owns `process.exit`.
 *
 * Ordering: parse arguments, load settings once (never throwing — the report is
 * the point), register every secret with the redactor before a single byte is
 * written, then run all ten probes and print. `--save` short-circuits the probes
 * on purpose: the values it writes reach the file, not this process's
 * environment, so probing after it would verify the OLD configuration.
 */
export async function run(options: DoctorOptions = {}): Promise<number> {
  const redactor = options.redactor ?? createRedactor();
  const writeOut =
    options.stdout ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const writeErr =
    options.stderr ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const out = (text: string): void => writeOut(redactor.redactString(text));
  const err = (text: string): void => writeErr(redactor.redactString(text));

  const parsed = parseArgs(options.argv ?? []);
  if (!parsed.ok) {
    err(`${parsed.message}\n\n${doctorUsage()}`);
    return EXIT_CONFIG;
  }
  const flags = parsed.flags;
  if (flags.help) {
    out(doctorUsage());
    return EXIT_OK;
  }

  const clock = options.clock ?? systemClock;
  const rng = options.rng ?? systemRng;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envFileHost = options.envFileHost ?? nodeEnvFileHost;
  const fs = options.fs ?? nodeDoctorFs;

  const envOptions: EnvFileOptions = {
    env,
    platform,
    host: envFileHost,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };

  const loaded = loadSettings({ ...envOptions, clock });
  // Registration happens BEFORE anything is written: from here on a token
  // cannot reach stdout even through an error message we did not anticipate.
  for (const secret of loaded.secrets) redactor.addSecret(secret);

  const logger = (
    options.logger ?? createLogger({ level: loaded.settings.logLevel, clock, redactor })
  ).withCid(NO_CID);

  logger.emit('settings_report', {
    findingCount: loaded.report.findings.length,
    ...(loaded.report.worst === undefined ? {} : { worst: loaded.report.worst }),
  });
  for (const finding of loaded.report.findings) {
    if (finding.code === 'token_expiry_warning') {
      logger.emit('token_expiry_warning', { ...finding.data });
    }
  }

  if (flags.save) {
    return await saveCredentials({ options, loaded, envOptions, clock, fs, out, err });
  }

  // The active profile's credentials, per field — the same rule the server's
  // resolver applies, from the same module (`core/credentials.ts`).
  const credentials = effectiveCredentials(loaded.settings);
  const host = loaded.host;
  // Counted by `core/http.ts` itself, so an injected `jiraRequest` (below)
  // silently bypasses it — which is exactly why the report omits the counters
  // in that case.
  const telemetry = createTelemetry();
  const injectedRequest = options.jiraRequest;
  const request = flags.offline
    ? undefined
    : (injectedRequest ??
      (host !== undefined &&
      credentials.email !== undefined &&
      credentials.apiToken !== undefined
        ? (options.createRequest ?? createJiraRequest)({
            credentials: {
              host,
              email: credentials.email,
              apiToken: credentials.apiToken,
            },
            clock,
            rng,
            logger,
            redactor,
            telemetry,
            allowedHosts: loaded.settings.allowedHosts,
            requestTimeoutMs: loaded.settings.requestTimeoutMs,
            callBudgetMs: loaded.settings.callBudgetMs,
            hostConcurrency: loaded.settings.hostConcurrency,
            retryAttempts: loaded.settings.retryAttempts,
          })
        : undefined));

  const routed = new Map<string, StartupFinding[]>();
  for (const finding of loaded.report.findings) {
    const id = probeOfFinding(finding);
    const bucket = routed.get(id);
    if (bucket === undefined) routed.set(id, [finding]);
    else bucket.push(finding);
  }

  const ctx: DoctorContext = {
    clock,
    logger,
    redactor,
    env,
    platform,
    settings: loaded.settings,
    loaded,
    ...(host === undefined ? {} : { host }),
    envFile: describeEnvFile(loaded.envFile, envOptions, envFileHost),
    envFileHost,
    fs,
    offline: flags.offline,
    findingsFor: (probeId) => routed.get(probeId) ?? [],
    ...(request === undefined ? {} : { request }),
  };

  if (!flags.json) {
    out(
      `jira-mcp-ai doctor — ${host?.origin ?? 'no site configured'}${
        flags.offline ? ' (offline: network probes skipped)' : ''
      }\n\n`,
    );
  }

  const probes: ProbeReport[] = [];
  for (const probe of PROBES) {
    const findings = await runProbe(probe, ctx);
    const report: ProbeReport = {
      id: probe.id,
      title: probe.title,
      status: worstOf(findings),
      findings,
    };
    probes.push(report);
    // Human mode streams: a network probe can take seconds, and an operator
    // watching a hung run should see which probe is hanging.
    if (!flags.json) out(renderProbe(report));
  }

  const summary: Record<ProbeStatus, number> = {
    ok: 0,
    info: 0,
    skip: 0,
    warn: 0,
    fail: 0,
  };
  for (const probe of probes) summary[probe.status] += 1;

  const failed = summary.fail > 0;
  const exitCode = !loaded.report.ok ? EXIT_CONFIG : failed ? EXIT_PROBE_FAILED : EXIT_OK;

  const report: DoctorReport = {
    ok: !failed,
    exitCode,
    offline: flags.offline,
    ts: clock.now(),
    host: host?.origin ?? null,
    summary,
    probes,
    ...(request !== undefined && request === injectedRequest
      ? {}
      : { counters: telemetry.snapshot() }),
  };

  if (flags.json) {
    // Redact the OBJECT, then serialize — and write the result through
    // `writeOut`, deliberately bypassing the string pass `out` applies.
    //
    // Serializing first and running `redactString` over the finished document
    // corrupts it: the string redactor knows nothing about JSON, so a short
    // secret also matches inside the syntax. With `JIRA_API_TOKEN=t`, `"ok":
    // true` came out as `"ok": [REDACTED]rue` and no parser would take it.
    // Deep-redacting the tree first is what `core/log.ts` does with its fields,
    // and it reaches every string the report actually carries.
    writeOut(`${JSON.stringify(redactor.redact(report), null, 2)}\n`);
  } else out(renderSummary(report));

  return exitCode;
}

/** One probe, with skipping and the per-probe failure boundary applied. */
async function runProbe(
  probe: Probe,
  ctx: DoctorContext,
): Promise<readonly DoctorFinding[]> {
  if (probe.network && ctx.offline) {
    return [{ status: 'skip', text: 'skipped (--offline)' }];
  }
  if (probe.network && ctx.request === undefined) {
    return [
      {
        status: 'skip',
        text: 'skipped: no usable site or credentials',
        remediation: 'Fix the findings above, then run doctor again.',
      },
    ];
  }
  try {
    return await probe.run(ctx);
  } catch (error) {
    return [fromError(error, 'fail', ctx.redactor)];
  }
}

interface SaveArgs {
  readonly options: DoctorOptions;
  readonly loaded: LoadSettingsResult;
  readonly envOptions: EnvFileOptions;
  readonly clock: Clock;
  readonly fs: DoctorFsHost;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * `doctor --save`: prompt for the credentials and write them to the env file
 * atomically at 0600 under the cross-process lock. Only ever runs on a TTY —
 * AUTH.md requires a non-interactive run to fail with a message rather than
 * hang on a read that will never be answered.
 */
async function saveCredentials(args: SaveArgs): Promise<number> {
  const { options, loaded, envOptions, clock, fs, out, err } = args;
  const interactive = options.isTTY ?? process.stdin.isTTY === true;
  const prompt = options.prompt;

  if (prompt === undefined && !interactive) {
    err(
      '--save needs a terminal: stdin is not a TTY, so there is nobody to answer the prompts.\n' +
        'Write the env file yourself, or run doctor from an interactive shell.\n',
    );
    return EXIT_CONFIG;
  }
  // Binding `process.stdin` here rather than at module load matters: touching
  // that getter instantiates the stdin stream, and a doctor run that never
  // prompts must not do that.
  const ask = prompt ?? createReadlinePrompt(process.stdin, process.stdout);

  const target = loaded.envFile.path ?? preferredEnvFilePath(envOptions);
  out(`Writing credentials to ${quote(target)} (mode ${octal(SECRET_FILE_MODE)}).\n`);
  out('Leave an answer empty to abort. Terminal input is echoed — beware shoulders.\n\n');

  const site = await ask('Jira site (e.g. mycompany.atlassian.net): ', { secret: false });
  const email = await ask('Atlassian account email: ', { secret: false });
  const apiToken = await ask('API token: ', { secret: true });
  if (site === '' || email === '' || apiToken === '') {
    err('Aborted: nothing was written.\n');
    return EXIT_CONFIG;
  }
  // The token becomes a secret the moment it is typed, not when it is next read.
  const expires = await ask('Token expiry date (ISO, optional): ', { secret: false });

  const contents = mergeEnvFile(fs.readText(target), [
    ['JIRA_SITE', site],
    ['JIRA_EMAIL', email],
    ['JIRA_API_TOKEN', apiToken],
    ...(expires === '' ? [] : [['JIRA_TOKEN_EXPIRES', expires] as const]),
  ]);

  try {
    await fs.writeSecret(target, contents, {
      clock,
      onWarning: (message) => err(`${message}\n`),
    });
  } catch (error) {
    err(
      `Could not write ${quote(target)}: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    return EXIT_CONFIG;
  }

  out(`\nSaved. Run \`jira-mcp-ai doctor\` to verify the new credentials.\n`);
  return EXIT_OK;
}
