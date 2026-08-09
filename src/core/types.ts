// ---------------------------------------------------------------------------
// FROZEN — shared `core` contracts (WP-01, Wave 0 contract freeze).
//
// Every row of docs/WORK-PACKAGES.md §1.1 that belongs to the `core` ring lives
// here as a TYPE, so a Wave-1 agent can compile against a contract whose
// implementation does not exist yet. Nothing in this file reaches the network,
// reads the environment or asks the host for the time: declarations, closed
// vocabularies, and one error class whose constructor only copies fields.
//
// CHANGING ANYTHING HERE IS STOP-THE-LINE (WORK-PACKAGES.md §1.1/§4.2). A
// contract edit invalidates every WP written against it, so only the integrator
// applies one and the affected WPs rebase. Friction discovered while
// implementing is a FINDING for the handoff note, never a licence to edit this
// file.
//
// The string-literal unions below (`LogLevel`, `LogEventName`, `JiraErrorKind`,
// `WriteMode`, `TransportKind`) are copied character for character from the
// documents that own them, because tests substring-assert them — a typo here
// surfaces as a mystery failure three waves later.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Clock — the injected time seam
// ---------------------------------------------------------------------------

/**
 * Injected time seam. `Date.now()` and bare timers are banned outside
 * `core/clock.ts` [eslint], so every deadline, backoff wait and duration in the
 * server flows through this interface (ARCHITECTURE.md §Cross-cutting seams).
 *
 * Produced by: `core/clock.ts` (WP-12); `createFakeClock` in tests (WP-01).
 * Consumed by: `core/http.ts` retry/timeout/call-budget (WP-10), the journal and
 * logger (WP-12), doctor (WP-25), every `durationMs` field of the log-event
 * table.
 */
export interface Clock {
  /** Epoch milliseconds; monotonic only insofar as the host clock is. */
  now(): number;

  /**
   * Resolve after `ms` of clock time. When `signal` aborts, the pending wait is
   * dropped and the promise rejects with an error whose `name` is `AbortError`.
   *
   * `AbortSignal.timeout` is banned project-wide [eslint]: it owns a real timer
   * the fake clock cannot drive. A per-request timeout is `sleep(ms, signal)`
   * raced against the fetch promise with an explicit `AbortController`.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// 2. Rng — the injected randomness seam
// ---------------------------------------------------------------------------

/**
 * Injected randomness seam returning a float in `[0, 1)`, same contract as
 * `Math.random` — which is banned outside `core/rng.ts` [eslint].
 *
 * Produced by: `core/rng.ts` (WP-12); a scripted sequence in tests.
 * Consumed by: retry/Retry-After jitter in `core/http.ts` (WP-10) and
 * correlation-id generation in `core/log.ts` (WP-12). Backoff sequences are
 * asserted exactly (CC-11…CC-14), which is only possible because this is a seam.
 */
export type Rng = () => number;

// ---------------------------------------------------------------------------
// 3. Logging — the normative event table (OBSERVABILITY.md)
// ---------------------------------------------------------------------------

/** Severity vocabulary; also the value space of `JIRA_LOG_LEVEL` (default `info`). */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/**
 * A log severity.
 *
 * Produced by: the `JIRA_LOG_LEVEL` parser in `core/settings.ts` (WP-11).
 * Consumed by: `core/log.ts` level filtering (WP-12).
 */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Every event name the server may emit — the normative table of
 * OBSERVABILITY.md §Log-event table, in table order. The table is complete: a
 * new event is a documentation change first, then code. Tests substring-assert
 * these names, so renaming one is a breaking change.
 */
export const LOG_EVENTS = [
  'server_start',
  'settings_report',
  'token_expiry_warning',
  'tool_call_start',
  'tool_call_end',
  'http_request',
  'http_response',
  'http_retry',
  'rate_limited',
  'ambiguous_write',
  'budget_exceeded',
  'auth_failure',
  'journal_write_failed',
  'upstream_degraded',
  'shutdown',
] as const;

/**
 * One of the fifteen contract event names.
 *
 * Produced by: every layer that logs (WP-10…WP-25).
 * Consumed by: `core/log.ts` (WP-12) and the log-table test.
 */
export type LogEventName = (typeof LOG_EVENTS)[number];

/**
 * The level column of the log-event table. The level belongs to the event, not
 * to the call site, so `Logger.emit` needs no level argument and no call site
 * can log `server_start` at `error`.
 *
 * Produced by: this module (frozen data).
 * Consumed by: `core/log.ts` (WP-12), the fake logger, the log-table test.
 */
export const LOG_EVENT_LEVEL: Readonly<Record<LogEventName, LogLevel>> = Object.freeze({
  server_start: 'info',
  settings_report: 'info',
  token_expiry_warning: 'warn',
  tool_call_start: 'debug',
  tool_call_end: 'info',
  http_request: 'debug',
  http_response: 'debug',
  http_retry: 'warn',
  rate_limited: 'warn',
  ambiguous_write: 'error',
  budget_exceeded: 'error',
  auth_failure: 'error',
  journal_write_failed: 'warn',
  upstream_degraded: 'warn',
  shutdown: 'info',
});

/**
 * Structured metadata attached to an event: names, statuses, durations, counts.
 * Never payload — OBSERVABILITY.md §Never-log list forbids bodies, JQL, ADF,
 * header values, query-string values and env values at every level. Fields pass
 * through the redactor at the choke point before serialization.
 *
 * Produced by: every call site that logs.
 * Consumed by: `core/log.ts` (WP-12).
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * One serialized log record, as it reaches stderr (stdout is the MCP protocol).
 *
 * Produced by: `core/log.ts` (WP-12); recorded verbatim by the fake logger.
 * Consumed by: the stderr sink, and tests asserting emitted events.
 */
export interface LogEvent {
  /** Machine-stable event name from {@link LOG_EVENTS}. */
  readonly event: LogEventName;
  /** Always `LOG_EVENT_LEVEL[event]`; carried so a sink needs no lookup table. */
  readonly level: LogLevel;
  /** Correlation id of the tool call, or `-` for startup and doctor probes. */
  readonly cid: string;
  /** Epoch milliseconds, stamped from the injected {@link Clock}. */
  readonly ts: number;
  /** Event-specific metadata; see the table's "Fields" column. */
  readonly fields?: LogFields;
}

/**
 * Structured stderr logger. There is no free-form message API on purpose: an
 * event name is a contract entry, and its level comes from
 * {@link LOG_EVENT_LEVEL}, so `emit` cannot disagree with the table.
 *
 * Produced by: `createLogger` in `core/log.ts` (WP-12); `createFakeLogger`
 * (WP-01) in tests.
 * Consumed by: every ring — http, api, mcp, tools, doctor.
 */
export interface Logger {
  /** Emit `event` at the level the table assigns it, with the bound `cid`. */
  emit(event: LogEventName, fields?: LogFields): void;

  /**
   * Child logger that stamps `cid` on every event it emits. One correlation id
   * per MCP tool call (`c-4f9a01`-shaped, from the injected {@link Rng});
   * startup and doctor use `-`.
   */
  withCid(cid: string): Logger;
}

// ---------------------------------------------------------------------------
// 4. Redactor — the single secret-stripping choke point
// ---------------------------------------------------------------------------

/** Seed configuration for a redactor. */
export interface RedactorConfig {
  /** Secret VALUES registered up front (API tokens, HTTP token, profile tokens). */
  readonly secrets?: readonly string[];
  /** Replacement text; implementations default to `[REDACTED]`. */
  readonly placeholder?: string;
}

/**
 * Value-based redaction choke point: registered secret values are stripped from
 * logs, errors and results (ARCHITECTURE.md §Cross-cutting seams). Scope is
 * SECRETS, not PII — accountIds and display names are workspace data the model
 * needs (THREAT-MODEL.md §Redaction scope).
 *
 * Produced by: `createRedactor` in `core/redact.ts` (WP-12); `createFakeRedactor`
 * (WP-01) in tests.
 * Consumed by: the logger, `JiraError` construction, the journal, plan-mode
 * request capture.
 */
export interface Redactor {
  /** Deep-redact an arbitrary value, returning a structurally equal copy. */
  redact(value: unknown): unknown;
  /** Redact a single string (log lines, error messages, body snippets). */
  redactString(text: string): string;
  /**
   * Register another secret value at runtime — exhaustive registration is a
   * requirement, not an optimisation (AUTH.md): an unregistered token cannot be
   * stripped by a later bug fix.
   */
  addSecret(value: string): void;
}

// ---------------------------------------------------------------------------
// 5. Settings — one field per CONFIGURATION.md row
// ---------------------------------------------------------------------------

/** Value space of `JIRA_WRITE_MODE` (default `plan`). */
export const WRITE_MODES = ['plan', 'apply'] as const;

/**
 * Write gate mode: `plan` describes the request a write would send, `apply`
 * executes it when the call also passes `apply: true` and a matching `plan_id`
 * (THREAT-MODEL.md §Gate contract, D14).
 *
 * Produced by: `core/settings.ts` (WP-11).
 * Consumed by: `mcp/write-mode.ts` (WP-24), the plan-capturing request seam.
 */
export type WriteMode = (typeof WRITE_MODES)[number];

/** Value space of `JIRA_TRANSPORT` (default `stdio`). */
export const TRANSPORT_KINDS = ['stdio', 'http'] as const;

/**
 * Transport selection.
 *
 * Produced by: `core/settings.ts` (WP-11).
 * Consumed by: `mcp/transport.ts` (WP-24) and `src/index.ts` (WP-40).
 */
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/**
 * A named credential set from `JIRA_PROFILE_<NAME>_SITE` / `_EMAIL` /
 * `_API_TOKEN`. Per-call resolution flows through AsyncLocalStorage
 * (`core/request-context.ts`).
 *
 * Produced by: `core/settings.ts` (WP-11).
 * Consumed by: the api context builder and doctor (WP-25).
 */
export interface ProfileConfig {
  /** Profile name exactly as it appears between `JIRA_PROFILE_` and `_SITE`. */
  readonly name: string;
  readonly site?: string;
  readonly email?: string;
  /** Secret; registered with the redactor at startup. */
  readonly apiToken?: string;
}

/**
 * A Jira host resolved once, never a bare string (ARCHITECTURE.md
 * §Cross-cutting seams). v1 always produces an empty `pathPrefix`; the v2 OAuth
 * gateway (`api.atlassian.com/ex/jira/{cloudId}`) is exactly a different origin
 * plus a prefix, so this shape keeps that door open without touching call sites.
 *
 * Produced by: `core/host.ts` (WP-11) from `settings.site` + `allowedHosts`.
 * Consumed by: `core/http.ts` URL assembly (WP-10), `server_start` logging,
 * doctor.
 */
export interface HostRef {
  /** Scheme + host, no trailing slash — e.g. `https://mycompany.atlassian.net`. */
  readonly origin: string;
  /** Path segment prefixed before the API root; `''` in v1. */
  readonly pathPrefix: string;
}

/**
 * The validated view of the environment — exactly one field per row of
 * CONFIGURATION.md, which owns the names and the defaults quoted below. The
 * env ↔ docs sync test compares the `JIRA_*` names read in `src/**` against that
 * table, so an undocumented knob and a documented-but-dead one both fail.
 *
 * Credential fields are optional because `loadSettings()` returns
 * `{ settings, report }` — a best-effort `Settings` alongside an error-severity
 * report, so `doctor` can print EVERY problem at once instead of dying on the
 * first missing variable. `assertStartupOk(report)` is what fails closed; after
 * it passes, the required fields below are present.
 *
 * Produced by: `loadSettings` in `core/settings.ts` (WP-11).
 * Consumed by: `buildServer` (WP-40), the registry (WP-24), doctor (WP-25).
 * Note that `core/http.ts` never imports settings — every option is passed to it
 * explicitly.
 */
export interface Settings {
  /** `JIRA_SITE` (required). Short name, host, or full URL; path stripped (CC-27). */
  readonly site?: string;
  /** `JIRA_EMAIL` (required). Atlassian account email for Basic auth. */
  readonly email?: string;
  /** `JIRA_API_TOKEN` (required). Secret; registered with the redactor. */
  readonly apiToken?: string;
  /** `JIRA_TOKEN_EXPIRES`. ISO date; warns ≤ 30 days out (`token_expiry_warning`). */
  readonly tokenExpires?: string;
  /** `JIRA_ALLOWED_HOSTS`. Extra exact hosts or anchored regexes; suffix match banned. */
  readonly allowedHosts: readonly string[];

  /** `JIRA_PROFILE_<NAME>_*`, keyed by profile name. */
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
  /** `JIRA_ACTIVE_PROFILE`. Used when a tool call does not name one. */
  readonly activeProfile?: string;
  /** `JIRA_LOCK_PROFILE` (default true per O-6). Per-call switching is rejected. */
  readonly lockProfile: boolean;

  /**
   * `JIRA_TOOL_PACKAGES` (default `all`). A profile (`core`, `reader`, `all`) or
   * an explicit package list. Kept as strings here because the package
   * vocabulary lives in the `mcp` ring (`PackageId`) and `core` may not import
   * it [eslint]; `mcp/registry.ts` (WP-24) validates the values.
   */
  readonly toolPackages: readonly string[];
  /** `JIRA_PACKAGES_DENY`. Wins over selection; `core` is force-re-added (CC-29). */
  readonly packagesDeny: readonly string[];
  /** `JIRA_PACKAGES_READONLY`. Packages whose write-tier tools are dropped. */
  readonly packagesReadonly: readonly string[];
  /** `JIRA_WRITE_MODE` (default `plan`). */
  readonly writeMode: WriteMode;

  /** `JIRA_REQUEST_TIMEOUT_MS` (default 30000). */
  readonly requestTimeoutMs: number;
  /** `JIRA_CALL_BUDGET_MS` (default 120000). Wall clock for one tool call's HTTP. */
  readonly callBudgetMs: number;
  /** `JIRA_HOST_CONCURRENCY` (default 4). Per-host semaphore slots. */
  readonly hostConcurrency: number;
  /** `JIRA_RETRY_ATTEMPTS` (default 3). Max retry attempts (JIRA-API.md). */
  readonly retryAttempts: number;
  /** `JIRA_MAX_RESULT_CHARS` (default 25000). Truncation budget for results. */
  readonly maxResultChars: number;
  /** `JIRA_MAX_PAGES` (default 20). Loop guard for `fetchAll`/`searchPages`. */
  readonly maxPages: number;

  /** `JIRA_TRANSPORT` (default `stdio`). */
  readonly transport: TransportKind;
  /** `JIRA_HTTP_PORT` (default 3334). Loopback-only Streamable HTTP port. */
  readonly httpPort: number;
  /** `JIRA_HTTP_TOKEN`. Required for http transport; secret (CC-30). */
  readonly httpToken?: string;

  /** `JIRA_LOG_LEVEL` (default `info`). All output to stderr. */
  readonly logLevel: LogLevel;
  /** `JIRA_JOURNAL_PATH`. Enables the append-only JSONL write journal. */
  readonly journalPath?: string;
}

// ---------------------------------------------------------------------------
// 6. Errors — one error type, one machine-stable kind catalog (TOOLS.md)
// ---------------------------------------------------------------------------

/**
 * The error-kind catalog of TOOLS.md §Error-kind catalog, in table order.
 * Machine-stable and substring-asserted; adding a kind is a spec change first.
 */
export const JIRA_ERROR_KINDS = [
  'config',
  'auth',
  'permission',
  'not_found',
  'validation',
  'rate_limited',
  'transport',
  'timeout',
  'ambiguous_write',
  'budget_exceeded',
  'write_gated',
  'unexpected_shape',
  'unsupported',
] as const;

/**
 * One of the thirteen error kinds.
 *
 * Produced by: `core/errors.ts` + `core/http.ts` (WP-10/WP-12), api guards,
 * the write gate.
 * Consumed by: `mcp/errors.ts` (WP-14), every tool, doctor exit codes.
 */
export type JiraErrorKind = (typeof JIRA_ERROR_KINDS)[number];

/**
 * The kinds whose `retryable` column is `true`. It describes the CLASS, not
 * permission to auto-retry: retries already happened inside `core/http.ts`, so
 * by the time a kind reaches the model the automatic budget is spent.
 *
 * Produced by: this module (frozen data).
 * Consumed by: the {@link JiraError} constructor default and the catalog test.
 */
export const RETRYABLE_ERROR_KINDS: readonly JiraErrorKind[] = Object.freeze([
  'rate_limited',
  'transport',
  'timeout',
]);

/** Constructor input for {@link JiraError}. */
export interface JiraErrorInit {
  /** Machine-stable kind; drives remediation and doctor exit codes. */
  readonly kind: JiraErrorKind;
  /** Cause first, then the recovery action. Redacted at construction time. */
  readonly message: string;
  /** Upstream HTTP status when the error came from the wire. */
  readonly httpStatus?: number;
  /** Jira's own `errorMessages[]` / flattened `errors{}` entries, verbatim. */
  readonly jiraMessages?: readonly string[];
  /** Defaults to membership in {@link RETRYABLE_ERROR_KINDS}. */
  readonly retryable?: boolean;
  /** What the caller should do next; the model reads this. */
  readonly remediation?: string;
  /**
   * Bounded (≤ 200 chars), redacted body snippet for a non-JSON error body
   * (CC-15) — the sole exception to the never-log list, and it lives here on the
   * error rather than in a log event.
   */
  readonly detail?: string;
  /** Underlying error, attached via the standard `Error` cause chain. */
  readonly cause?: unknown;
}

/**
 * The single error type of the server (ARCHITECTURE.md §Error model). Every
 * failure — config, wire, guard, gate — surfaces as one of these, so tools never
 * see a raw `TypeError` from deep inside a parser.
 *
 * Produced by: `core/errors.ts` (WP-12), `core/http.ts` (WP-10), api guards,
 * `mcp/write-mode.ts` (WP-24).
 * Consumed by: `mcp/errors.ts` (WP-14), which projects it to {@link ErrorRecord}
 * for the envelope.
 */
export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  readonly httpStatus?: number;
  readonly jiraMessages?: readonly string[];
  readonly retryable: boolean;
  readonly remediation?: string;
  readonly detail?: string;

  constructor(init: JiraErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'JiraError';
    this.kind = init.kind;
    this.httpStatus = init.httpStatus;
    this.jiraMessages = init.jiraMessages;
    this.retryable = init.retryable ?? RETRYABLE_ERROR_KINDS.includes(init.kind);
    this.remediation = init.remediation;
    this.detail = init.detail;
    // Restore the prototype chain so `instanceof JiraError` holds when the
    // class is transpiled to a function.
    Object.setPrototypeOf(this, JiraError.prototype);
  }
}

/**
 * The serialized, model-facing projection of a {@link JiraError} — what actually
 * travels in `ToolResult.error`. Plain data: no stack, no `cause`, nothing that
 * only makes sense inside the process.
 *
 * Produced by: `mcp/errors.ts` (WP-14).
 * Consumed by: `mcp/result.ts` (WP-14) and every tool's envelope.
 */
export interface ErrorRecord {
  readonly kind: JiraErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly jiraMessages?: readonly string[];
  readonly remediation?: string;
  /** Bounded, redacted body snippet from CC-15, when there was one. */
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// 7. Wire — the `jiraRequest` contract (JIRA-API.md)
// ---------------------------------------------------------------------------

/** HTTP verbs the server emits. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

/**
 * An HTTP method.
 *
 * Produced by: every `api/*` module (WP-20…WP-23).
 * Consumed by: `core/http.ts` retry matrix (WP-10) — the GET-only idempotence
 * rule reads this field.
 */
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The two Jira API roots v1 speaks. */
export const JIRA_API_ROOTS = ['v3', 'agile'] as const;

/**
 * Which Jira API a request targets: `v3` is the platform REST API (ADF bodies,
 * accountIds), `agile` is the Jira Software board/sprint API. They differ in
 * path prefix, in availability (the Agile root can be absent or unlicensed —
 * `kind=unsupported`, CC-34) and in response conventions (`isLast` pagination
 * instead of `nextPageToken`).
 *
 * Produced by: `api/*` modules.
 * Consumed by: `core/http.ts` URL assembly.
 */
export type JiraApiRoot = (typeof JIRA_API_ROOTS)[number];

/**
 * Path prefix per root, appended after `HostRef.pathPrefix`. v3 only — the
 * legacy `/rest/api/2` root is never used, and `/rest/api/3/search` (without
 * `/jql`) was removed server-side on 2025-08-01.
 *
 * Produced by: this module (frozen data).
 * Consumed by: `core/http.ts` (WP-10) and the fake request client.
 */
export const JIRA_ROOT_PATHS: Readonly<Record<JiraApiRoot, string>> = Object.freeze({
  v3: '/rest/api/3',
  agile: '/rest/agile/1.0',
});

/** A single query-string value; arrays are joined by the caller (Jira uses CSV). */
export type QueryValue = string | number | boolean;

/** Query parameters; an `undefined` value is omitted from the URL entirely. */
export type QueryParams = Readonly<Record<string, QueryValue | undefined>>;

/** Response headers, lowercased by the client so lookups need no normalisation. */
export type JiraResponseHeaders = Readonly<Record<string, string>>;

/**
 * One outbound Jira request, as the api ring describes it. The client owns URL
 * assembly, auth, retries, the semaphore and the budget; the caller owns the
 * route and the policy flags below.
 *
 * Produced by: `api/*` (WP-20…WP-23), doctor probes (WP-25).
 * Consumed by: `createJiraRequest` in `core/http.ts` (WP-10), the plan-mode
 * capturing seam (WP-24), `createFakeJiraRequest` (WP-01).
 */
export interface JiraRequestSpec {
  readonly method: HttpMethod;

  /**
   * Path RELATIVE to the API root, starting with `/` — e.g. `/issue/ABC-1`,
   * which becomes `{origin}{pathPrefix}/rest/api/3/issue/ABC-1`. Each dynamic
   * segment must already be percent-encoded per segment by the caller.
   */
  readonly path: string;

  /** Which API root `path` is relative to. Defaults to `v3`. */
  readonly root?: JiraApiRoot;

  /**
   * The route with placeholders — `/issue/{key}` — used for the `pathTemplate`
   * field of every http log event. OBSERVABILITY.md forbids concrete paths in
   * events because issue and project keys are workspace data, so any path
   * carrying an id MUST set this; the logger falls back to `path` only for
   * constant routes, which are their own template.
   */
  readonly pathTemplate?: string;

  readonly query?: QueryParams;

  /** JSON-serializable request body; ADF documents travel here. */
  readonly body?: unknown;

  /**
   * Marks a request that is a pure READ despite its verb, so 502/503/504 and
   * transport failures may be replayed for it. Exists for
   * `POST /search/jql` and `POST /search/approximate-count` (JIRA-API.md
   * §Rate limiting and retries). Never set it on anything that mutates: an
   * unsafe write is never replayed, it surfaces `ambiguous_write` (CC-12/13).
   */
  readonly safe?: boolean;

  /** Overrides `JIRA_REQUEST_TIMEOUT_MS` for this request. */
  readonly timeoutMs?: number;

  /**
   * Call-budget deadline in `clock.now()` epoch ms, computed ONCE per tool call
   * as `clock.now() + settings.callBudgetMs` and passed to every request the
   * call makes — retry waits and semaphore queueing count against it. Modelled
   * as a shared deadline rather than a per-request duration precisely because a
   * per-request budget would not compose across a paginated loop. On breach:
   * `kind=budget_exceeded`.
   */
  readonly deadlineAt?: number;

  /** Overrides `JIRA_RETRY_ATTEMPTS` for this request. */
  readonly retryAttempts?: number;

  /** Cancellation from the MCP request; the client forwards it to `fetch`. */
  readonly signal?: AbortSignal;

  /** Profile whose credentials this request uses; defaults to the active one. */
  readonly profile?: string;
}

/**
 * A successful Jira response after status handling: a non-2xx never arrives
 * here, it becomes a {@link JiraError}.
 *
 * Produced by: `core/http.ts` (WP-10), `createFakeJiraRequest` (WP-01).
 * Consumed by: every `api/*` guard, which narrows `data` from `unknown`.
 */
export interface JiraResponse<T = unknown> {
  readonly status: number;
  readonly headers: JiraResponseHeaders;
  /** Parsed JSON body, or `undefined` for a 204. Enters the api ring as `unknown`. */
  readonly data: T;
}

/**
 * The one function the api ring is allowed to call to reach Jira. In `plan`
 * mode `buildServer` injects an implementation that CAPTURES the method, path
 * and body a write would have sent and returns it instead of touching the
 * network — which is why tools contain no plan-mode branch and the "nothing hit
 * the wire" property is testable at the seam (CC-20).
 *
 * Produced by: `createJiraRequest` in `core/http.ts` (WP-10), the plan seam
 * (WP-24), `createFakeJiraRequest` (WP-01).
 * Consumed by: every `api/*` module and every tool through `ToolCtx`.
 */
export type JiraRequestFn = <T = unknown>(
  req: JiraRequestSpec,
) => Promise<JiraResponse<T>>;

// ---------------------------------------------------------------------------
// 8. Journal — the append-only record of executed writes (OBSERVABILITY.md)
// ---------------------------------------------------------------------------

/** Outcome of an append; `failed` is normal operation, never an exception. */
export type JournalStatus = 'ok' | 'failed';

/**
 * Caller-supplied journal fields; the journal stamps `ts` itself. The shape is
 * deliberately minimal (O-8): `argsHash` is a stable hash of the normalized
 * arguments — no field values, no ADF, no JQL. `issueKey` survives because a
 * journal that cannot answer "what did it touch?" is not worth writing.
 *
 * Produced by: the tool-call wrapper after an EXECUTED write (plan-mode calls
 * are never journaled — nothing happened).
 * Consumed by: `core/journal.ts` (WP-12) and `createMemoryJournal` (WP-01).
 */
export interface JournalEntryInput {
  /** Correlation id of the call, matching the `cid` of its log events. */
  readonly cid: string;
  readonly tool: string;
  readonly argsHash: string;
  readonly ok: boolean;
  readonly httpStatus?: number;
  readonly issueKey?: string;
}

/** A stored journal line — one JSON object per line in `JIRA_JOURNAL_PATH`. */
export interface JournalEntry extends JournalEntryInput {
  /** ISO-8601 UTC timestamp, stamped on append from the injected {@link Clock}. */
  readonly ts: string;
}

/**
 * Append-only write journal. `append` NEVER throws and never rejects: a journal
 * failure returns `'failed'` so the tool can still report `ok: true` with hint
 * `journal_unavailable` (CC-33). Failing the tool would tell the model to retry
 * a write that in fact succeeded — the worst available outcome.
 *
 * Produced by: `core/journal.ts` (WP-12); `createMemoryJournal` (WP-01).
 * Consumed by: the write path in `mcp/write-mode.ts` (WP-24).
 */
export interface Journal {
  append(entry: JournalEntryInput): Promise<JournalStatus>;
}
