# Observability

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns the **log-event contract**: event names,
> fields, the never-log list, correlation ids, and the startup report.
> `core/log.ts` implements it; tests assert event names against this table.

## Principles

1. **stderr only.** stdout is the MCP protocol (stdio transport); every
   diagnostic line — structured or human — goes to stderr. The sole exception
   is the `doctor` CLI report, which goes to stdout (D11 in DECISIONS.md):
   doctor is a CLI run, no protocol is on stdout.
2. **Metadata-only.** Log events carry names, statuses, durations and counts —
   never payload. See the never-log list below.
3. **Redacted at the choke point.** Every event passes `core/redact.ts` before
   serialization; secrets registered at startup cannot appear even by bug.
4. **Machine-stable names.** Event names below are contract: tests
   substring-assert them; renaming one is a breaking change recorded in
   DECISIONS.md.

## Correlation id

- Every MCP tool call gets a correlation id (short id from the injected RNG,
  e.g. `c-4f9a01`), stored in `AsyncLocalStorage` (`core/log.ts`:
  `runWithCid`/`currentCid`; profile resolution joins the same seam in Wave 2).
- Every log event emitted during that call — http, retry, journal, result —
  carries the id as `cid`. Doctor probes and startup use `cid: "-"`.

## Log-event table (normative)

| Event | Level | Fields (beyond `cid`) |
|---|---|---|
| `server_start` | info | version, transport, packageCount, toolCount, writeMode, allowIrreversible, profile, host |
| `settings_report` | info | findingCount, worst severity (report text is the startup line, redacted) |
| `token_expiry_warning` | warn | daysLeft (from `JIRA_TOKEN_EXPIRES`; emitted ≤ 30 days) |
| `tool_call_start` | debug | tool |
| `tool_call_end` | info | tool, ok, durationMs, truncated? |
| `http_request` | debug | method, pathTemplate |
| `http_response` | debug | method, pathTemplate, status, durationMs, attempt |
| `http_retry` | warn | method, pathTemplate, reason (`429` \| `5xx` \| `transport`), attempt, delayMs |
| `rate_limited` | warn | retryAfterS (server value), waitS (capped value) |
| `ambiguous_write` | error | tool, method, pathTemplate |
| `budget_exceeded` | error | tool, budgetMs, elapsedMs |
| `auth_failure` | error | status, pathTemplate |
| `journal_write_failed` | warn | errorKind (journal failure is never a tool failure — surfaced as a hint) |
| `upstream_degraded` | warn | consecutiveFailures, host (emitted on the 3rd consecutive 5xx/transport failure; see §No circuit breaker) |
| `shutdown` | info | reason (`stdin_eof` \| `sigint` \| `sigterm` \| `fatal`) |

Notes:

- `pathTemplate` is the route with placeholders (`/rest/api/3/issue/{key}`),
  never the concrete path — issue keys and project keys are workspace data.
- The table is complete: a new event = a new row here first, then code.
- The `tool` field above exists in **log events only**. The model-facing
  `ErrorRecord` (frozen contract, core/types.ts) has no `tool` field; for
  `budget_exceeded` and `ambiguous_write` the registry instead appends
  ` Tool: <name>.` to the error message once (idempotent suffix), so the
  result a model reads still names the tool that failed.

## Never-log list

At **any** log level, events must not contain:

- request or response **bodies**;
- **JQL** text;
- **ADF** content or any issue/comment text;
- header values or query-string values;
- env var values, tokens, or the settings object itself.

Sole exception: CC-15 — a non-JSON error body (HTML from a proxy) may carry a
**bounded (≤ 200 chars), redacted** snippet in the `JiraError` detail, because
status-only errors are undebuggable there. That snippet lives in the error, not
in a log event.

## Startup

- **Offline-only**: no network I/O before the transport connects. Settings
  load, redactor registration and manifest assembly are all local; the first
  network call is always a tool call (or a doctor probe in CLI mode).
- One-line redacted config report to stderr at start (the `settings_report`
  text): host, active profile, package selection, write mode, transport —
  enough to diagnose "wrong site/wrong mode" from a support transcript alone.
- Version observability: server version appears in `server_start`, in the
  startup line, and in `jira_capabilities` output.

## Write journal

`JIRA_JOURNAL_PATH` (CONFIGURATION.md) enables an append-only JSONL record of
every **executed** write — plan-mode calls are not journaled (nothing
happened).

- Line shape (O-8 default, minimized): `{ ts, cid, tool, argsHash, ok,
  httpStatus?, issueKey? }`. `argsHash` is a stable hash of the normalized
  arguments — **no field values, no ADF, no JQL**. The issue key is kept
  because a journal that cannot answer "what did it touch?" is not worth
  writing; it is workspace data, not PII.
- Rotation at ~5 MB (donor-style: rename to `.1`, keep one previous file) —
  an unbounded audit file on a laptop is a slow-motion disk failure.
- **A journal write failure is never a tool failure.** The write already
  happened; the tool returns `ok: true` with hint `journal_unavailable` and the
  `journal_write_failed` event (CC-33). Failing the tool would tell the model
  to retry a write that in fact succeeded — the worst possible outcome.
- The file is created 0600; it inherits the redactor, not bypasses it.

## No circuit breaker (D13)

v1 has retries, a per-host semaphore and a per-call budget, but **no circuit
breaker** — a single-user MCP server cannot generate the load that makes one
pay off, and a tripped breaker would confuse a model far more than a slow
error. Instead: the third consecutive 5xx/transport failure against a host
emits `upstream_degraded`, and the surfaced error's remediation names
Atlassian's status page rather than suggesting an immediate retry.

## Counters

The donor's in-process `Telemetry` counters (requests, retries, rate-limit
waits, errors by kind) are kept and surfaced in two places only:
`jira_capabilities` output and the doctor report (D12). Nothing is exported
anywhere — no OTel, no metrics endpoint, no phone-home; the counters die with
the process.

## Call budget

`JIRA_CALL_BUDGET_MS` (CONFIGURATION.md) bounds one tool call's total HTTP
activity — retry waits and semaphore queueing included. On breach the call
aborts with `JiraError kind=budget_exceeded` (+ the log event above) telling
the model to narrow the request (fewer fields, smaller maxResults) rather than
retry as-is. Policy detail: JIRA-API.md §Rate limiting and retries.
