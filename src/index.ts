// ---------------------------------------------------------------------------
// Process entry point — ARCHITECTURE.md §Dependency injection boundary.
//
// THIS FILE IS IMPORT-FREE AT MODULE SCOPE, WITH ONE EXCEPTION. Every value
// import is a dynamic `import()` inside a function; the other static imports are
// `import type`, which vanish at build time. The reason is the Node version
// guard below: the module graph underneath uses syntax and APIs that old
// runtimes fail to *parse*, and a guard that never runs prints nothing at all.
// The CJS launcher in `bin/` makes the same bet one level up, for the runtimes
// that cannot even parse this file.
//
// The exception is `core/credentials.ts` (WP-51), whose one rule doctor and this
// file must not restate differently. That module is deliberately a LEAF — no
// runtime imports of its own, plain functions, the host resolver injected — so
// what the guard now loads before it can run is one dependency-free file. Do not
// let that module grow an import, and do not add a second static import here.
//
// `main` IS A FROZEN EXPORT NAME. Under `npx`/`bin` the process `argv[1]` is the
// launcher shim, so the self-run guard at the bottom is false by construction
// and the shim calls `main()` explicitly. Renaming this export turns every
// installed binary into a no-op that exits 0 — a failure with no error message.
//
// EXIT CODES ARE SET, NEVER FORCED. `process.exitCode` lets Node flush a piped
// stdout before it leaves; `process.exit()` truncates it mid-frame, which on the
// stdio transport means a half-written JSON-RPC message on the client's side.
// ---------------------------------------------------------------------------

import { buildCredentialResolver, configError } from './core/credentials.js';
import type { Clock, Journal, Logger, Redactor, Settings } from './core/types.js';
import type { ShutdownReason, TransportHandle } from './mcp/transport.js';
import type { CapabilitiesInfo } from './tools/core.js';

/**
 * The per-call credential lookup, re-exported from where it now lives.
 *
 * A FROZEN EXPORT NAME, like `main`: the bin surface and the entry-point tests
 * know it here. The implementation moved to `core/credentials.ts` (WP-51)
 * because `cli/doctor.ts` derived the same profile override a second time, and
 * two copies of one rule is two ways for a profile to mean different things
 * depending on who asked.
 */
export { buildCredentialResolver };
export type { CredentialDeps } from './core/credentials.js';

// ---------------------------------------------------------------------------
// Node version guard
// ---------------------------------------------------------------------------

/** `package.json` `engines.node`. Node 22 is the `process.loadEnvFile()` floor. */
export const MIN_NODE_MAJOR = 22;

/**
 * The complaint about this runtime, or `undefined` when it is new enough.
 *
 * A pure function of the version string so a test can assert the message
 * without a second runtime: the guard is the one piece of this file that must
 * work on a Node the rest of the code cannot even load.
 */
export function nodeVersionProblem(
  version: string = process.versions.node,
): string | undefined {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major) || major >= MIN_NODE_MAJOR) return undefined;
  return (
    `jira-mcp-ai requires Node.js >= ${String(MIN_NODE_MAJOR)}, but this is ${version}.\n` +
    'Node 22 is the floor because the server loads env files with ' +
    'process.loadEnvFile() instead of dotenv.\n' +
    'Use a newer runtime, e.g.: nvm install 24 && nvm use 24'
  );
}

// ---------------------------------------------------------------------------
// Exit codes and usage
// ---------------------------------------------------------------------------

/** Clean start (and, for the server, a clean shutdown). */
export const EXIT_OK = 0;

/** The server could not be started for a reason that is not the configuration. */
export const EXIT_FAILURE = 1;

/**
 * Bad configuration or bad invocation. Same number as `doctor`'s `EXIT_CONFIG`
 * on purpose — an operator scripting `jira-mcp-ai doctor || …` reads one code
 * table, not two. Duplicated as a literal rather than imported because this
 * module may not import anything at load time, and a value needed before the
 * first `await` cannot come from a dynamic import.
 */
export const EXIT_CONFIG = 2;

const USAGE = `jira-mcp-ai — MCP server for Jira Cloud.

Usage:
  jira-mcp-ai                 Serve the MCP protocol over stdio (default).
  jira-mcp-ai doctor [flags]  Check the configuration and probe the site.
  jira-mcp-ai --version       Print the server version.
  jira-mcp-ai --help          Print this message.

With no subcommand the process speaks JSON-RPC on stdin/stdout and must be
registered as a stdio MCP server; diagnostics always go to stderr.
Configuration is environment-only (JIRA_*) — see
https://github.com/IvanBBaev/jira-mcp/blob/main/docs/CONFIGURATION.md`;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface MainOptions {
  /** Arguments after the executable and script. Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[];
}

/**
 * The entry point. Dispatches a CLI subcommand or serves the MCP protocol.
 *
 * Never throws and never calls `process.exit()`: a failure becomes a stderr
 * message and a `process.exitCode`, so a piped stdout is flushed intact and an
 * embedding runtime (the bin shim, a test) keeps control of the process.
 */
export async function main(options: MainOptions = {}): Promise<void> {
  const problem = nodeVersionProblem();
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = EXIT_FAILURE;
    return;
  }

  const argv = options.argv ?? process.argv.slice(2);
  const command = argv[0];

  try {
    // Subcommands are dispatched BEFORE anything server-shaped is constructed,
    // and their modules are imported lazily: a `doctor` run must not pay for the
    // tool manifest, and a server start must not pay for doctor's probe table.
    if (command === 'doctor') {
      const { run } = await import('./cli/doctor.js');
      process.exitCode = await run({ argv: argv.slice(1) });
      return;
    }
    if (command === 'help' || command === '--help' || command === '-h') {
      // Stdout, like doctor's report: these paths never connect a transport, so
      // there is no JSON-RPC framing to corrupt.
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    if (command === '--version' || command === '-v') {
      const { SERVER_VERSION } = await import('./tools/index.js');
      process.stdout.write(`${SERVER_VERSION}\n`);
      return;
    }
    if (command !== undefined) {
      process.stderr.write(`jira-mcp-ai: unknown command "${command}".\n\n${USAGE}\n`);
      process.exitCode = EXIT_CONFIG;
      return;
    }

    await serve();
  } catch (error) {
    // Reached only for a failure before the logger exists (a broken install, a
    // module that will not load). Everything after that point is reported by
    // `serve` itself, with the redactor attached.
    process.stderr.write(`${describeFatal(error)}\n`);
    process.exitCode = exitCodeFor(error);
  }
}

/**
 * Start the server: settings → secrets → logger → request function → journal →
 * manifest → registry → transport.
 *
 * Strictly offline (OBSERVABILITY.md §Startup): nothing here touches the
 * network, so a misconfigured site is a startup error rather than a hung
 * connect. The first request this process makes is always a tool call.
 */
async function serve(): Promise<void> {
  // From the client's point of view stdout has been the JSON-RPC channel since
  // the moment it spawned this process. Our own source is console-free (eslint
  // `no-console`), but a DEPENDENCY's stray `console.log` would wedge a line of
  // prose between frames — so the whole console is rebound to stderr before the
  // first server module loads. `warn`/`error` already went there; `log`, `info`,
  // `debug`, `dir` and the rest move. The CLI paths (doctor, --help, --version)
  // never reach this function and keep their stdout.
  Object.assign(
    console,
    // eslint-disable-next-line no-console -- the guard that keeps every OTHER console call off the protocol stream.
    new console.Console({ stdout: process.stderr, stderr: process.stderr }),
  );

  const { systemClock } = await import('./core/clock.js');
  const { systemRng } = await import('./core/rng.js');
  const { assertStartupOk, loadSettings } = await import('./core/settings.js');
  const { createRedactor } = await import('./core/redact.js');
  const { NO_CID, createLogger } = await import('./core/log.js');

  const clock = systemClock;
  const rng = systemRng;

  const loaded = loadSettings({ clock });
  const { settings } = loaded;

  // Registration happens BEFORE the first line is written: from here on a token
  // cannot reach stderr even through a message nobody anticipated (AUTH.md).
  const redactor = createRedactor({ secrets: loaded.secrets });
  const logger = createLogger({ level: settings.logLevel, clock, redactor }).withCid(
    NO_CID,
  );

  try {
    // The redacted config report every support transcript starts with.
    logger.emit('settings_report', {
      findingCount: loaded.report.findings.length,
      ...(loaded.report.worst === undefined ? {} : { worst: loaded.report.worst }),
    });
    for (const finding of loaded.report.findings) {
      if (finding.code === 'token_expiry_warning') {
        logger.emit('token_expiry_warning', { ...finding.data });
      }
    }

    // Both of these fail closed, before anything is constructed: an unusable
    // configuration must not become a server that answers `tools/list` and then
    // fails every call.
    assertStartupOk(loaded.report);
    const { assertTransportSupported, connectTransport } =
      await import('./mcp/transport.js');
    assertTransportSupported(settings);

    const { createJiraRequest } = await import('./core/http.js');
    const { resolveHost } = await import('./core/host.js');
    const { createTelemetry } = await import('./core/telemetry.js');

    // The in-process counters (D12). One instance per process, injected — not a
    // module global — and read back in exactly two places: the capabilities
    // thunk below and, in its own process, the doctor report. Nothing persists
    // them; they die with the server, which is the whole contract.
    const telemetry = createTelemetry();

    const jira = createJiraRequest({
      credentials: buildCredentialResolver({
        settings,
        ...(loaded.host === undefined ? {} : { host: loaded.host }),
        resolveHost,
      }),
      clock,
      rng,
      logger,
      redactor,
      telemetry,
      allowedHosts: settings.allowedHosts,
      requestTimeoutMs: settings.requestTimeoutMs,
      callBudgetMs: settings.callBudgetMs,
      hostConcurrency: settings.hostConcurrency,
      retryAttempts: settings.retryAttempts,
    });

    const journal = await openJournal({ settings, clock, logger, redactor });

    // The capabilities circle: the report describes the registry that contains
    // the tool that returns it. `createPackages` takes a thunk, which is only
    // called at tool-call time — long after the assignment below.
    const { SERVER_NAME, SERVER_VERSION, buildCapabilitiesInfo, createPackages } =
      await import('./tools/index.js');
    const { selectPackages } = await import('./mcp/registry.js');

    // A one-field box rather than a `let`: the thunk has to read the value that
    // exists WHEN IT IS CALLED, not the one that existed when it was created.
    const assembled: { report?: CapabilitiesInfo } = {};
    const packages = createPackages(
      (): CapabilitiesInfo => {
        if (assembled.report === undefined) {
          // Unreachable: the report is assigned before a transport exists, and a
          // tool call cannot arrive before one does.
          throw configError(
            'The capabilities report was requested before startup finished assembling it.',
            'Restart the server; if this persists it is a bug in main() (src/index.ts).',
          );
        }
        // Counters are merged HERE rather than baked into the assembled report:
        // the report is built once at startup, the counters change with every
        // request, and the thunk is the only thing in this file that runs per
        // call. `jira_capabilities` therefore always reports the current numbers.
        return { ...assembled.report, counters: telemetry.snapshot() };
      },
      { mediaDir: settings.mediaDir },
    );

    // Gating is applied twice on purpose: `buildServer` needs the WHOLE manifest
    // (it reports what a deny list removed), and the report needs the SELECTION.
    // `selectPackages` is pure, so the second pass costs a few array walks and
    // buys a report that cannot drift from the registered surface.
    const selection = selectPackages(packages, settings);
    assembled.report = buildCapabilitiesInfo({
      settings,
      selection,
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
    });

    const { buildServer } = await import('./mcp/server.js');
    const server = buildServer({
      settings,
      packages,
      serverName: SERVER_NAME,
      version: SERVER_VERSION,
      jira,
      logger,
      redactor,
      clock,
      rng,
      journal,
    });

    const handle = await connectTransport(server, { settings, logger });
    installShutdownHandlers(handle);

    logger.emit('server_start', {
      version: SERVER_VERSION,
      transport: handle.kind,
      packageCount: selection.packages.length,
      toolCount: selection.packages.reduce((total, pkg) => total + pkg.tools.length, 0),
      writeMode: settings.writeMode,
      allowIrreversible: settings.allowIrreversible,
      ...(settings.activeProfile === undefined
        ? {}
        : { profile: settings.activeProfile }),
      ...(loaded.host === undefined ? {} : { host: loaded.host.origin }),
    });
  } catch (error) {
    // `fatal` is the shutdown reason for "died before or during serving"; the
    // human-readable line goes through the redactor, because a stack from a
    // dependency is exactly where an unredacted value would surface.
    logger.emit('shutdown', { reason: 'fatal' });
    process.stderr.write(`${redactor.redactString(describeFatal(error))}\n`);
    process.exitCode = exitCodeFor(error);
  }
}

/** Options for {@link openJournal}, all already-constructed seams. */
interface JournalDeps {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor: Redactor;
}

/**
 * The write journal, or `undefined` when `JIRA_JOURNAL_PATH` is unset.
 *
 * Resolved against the CWD so the path an operator configured and the file that
 * actually gets written are the same one, whatever directory the MCP client
 * happened to spawn the server from. The file itself is opened lazily by the
 * journal (0600, on first append), which keeps startup free of filesystem I/O
 * that a read-only session would never need.
 */
async function openJournal(deps: JournalDeps): Promise<Journal | undefined> {
  const configured = deps.settings.journalPath;
  if (configured === undefined || configured === '') return undefined;
  const path = await import('node:path');
  const { createFileJournal } = await import('./core/journal.js');
  return createFileJournal({
    path: path.resolve(configured),
    clock: deps.clock,
    logger: deps.logger,
    redactor: deps.redactor,
  });
}

/**
 * Take the server down on a signal.
 *
 * `once` rather than `on`: a second Ctrl-C should reach the default handler and
 * kill a process that is stuck closing, rather than being swallowed. Closing
 * detaches the stdio listeners and pauses stdin, so the event loop drains and
 * the process exits on its own — no `process.exit()` and no truncated stdout.
 */
function installShutdownHandlers(handle: TransportHandle): void {
  const shutdown = (reason: ShutdownReason) => (): void => {
    void handle.close(reason).catch(() => {
      /* the shutdown event is already on stderr; nothing left to report to */
    });
  };
  process.once('SIGINT', shutdown('sigint'));
  process.once('SIGTERM', shutdown('sigterm'));
}

/**
 * The stderr line for a startup failure: cause, then the recovery action.
 *
 * A `JiraError` is recognised structurally (`kind` + `remediation`) instead of
 * with `isJiraError`, because this runs on the failure path where importing one
 * more module is exactly what may be broken.
 */
function describeFatal(error: unknown): string {
  if (error instanceof Error) {
    const remediation: unknown = (error as { remediation?: unknown }).remediation;
    const detail =
      typeof remediation === 'string' && remediation !== ''
        ? `\n${remediation}`
        : hasKind(error)
          ? ''
          : `\n${error.stack ?? ''}`;
    return `jira-mcp-ai: ${error.message}${detail}`;
  }
  return `jira-mcp-ai: ${String(error)}`;
}

/** Whether the value carries a `JiraError`-shaped `kind` string. */
function hasKind(error: Error): boolean {
  return typeof (error as { kind?: unknown }).kind === 'string';
}

/** `config` problems are the operator's to fix (2); anything else is 1. */
function exitCodeFor(error: unknown): number {
  return error instanceof Error && (error as { kind?: unknown }).kind === 'config'
    ? EXIT_CONFIG
    : EXIT_FAILURE;
}

// ---------------------------------------------------------------------------
// Self-run guard
// ---------------------------------------------------------------------------

/**
 * True when this module IS the program, rather than an import.
 *
 * `import.meta.url` is compared against `argv[1]` through `fileURLToPath`, and
 * both sides are realpath'd: an npm bin link and a `node build/index.js` on a
 * symlinked checkout name the same file by different paths, and a guard that
 * says "no" there is a binary that exits 0 having done nothing.
 */
async function isSelfRun(): Promise<boolean> {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return false;
  try {
    const { fileURLToPath } = await import('node:url');
    const { realpathSync } = await import('node:fs');
    const real = (path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    return real(fileURLToPath(import.meta.url)) === real(entry);
  } catch {
    return false;
  }
}

// Importing this module must never boot a server (the smoke test and the bin
// shim both do exactly that), so the guard runs before `main` is called.
void isSelfRun().then(async (selfRun) => {
  if (selfRun) await main();
});
