# Observability

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns the **log-event contract**: event names,
> fields, the never-log list, correlation ids, and the startup report.
> `core/log.ts` implements it; tests assert event names against this table.

## Principles

1. **stderr only.** stdout is the MCP protocol under the stdio transport;
   under `http` (D101) the protocol rides the socket and stdout carries
   nothing at all (CC-119). Every diagnostic line — structured or human —
   goes to stderr in both cases. The sole exception is the `doctor` CLI
   report, which goes to stdout (D11 in DECISIONS.md): doctor is a CLI run,
   no protocol is on stdout.
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
| `settings_report` | info | findingCount, worst severity (the per-finding text stays in `doctor`; see §Startup) |
| `token_expiry_warning` | warn | daysLeft (from `JIRA_TOKEN_EXPIRES`; emitted ≤ 30 days) |
| `tool_call_start` | debug | tool |
| `tool_call_end` | info | tool, ok, durationMs, truncated?; on `ok: false` also errorKind, retryable, httpStatus? |
| `http_request` | debug | method, pathTemplate |
| `http_response` | debug | method, pathTemplate, status, durationMs, attempt |
| `http_retry` | warn | method, pathTemplate, reason (`429` \| `5xx` \| `transport`), attempt, delayMs |
| `rate_limited` | warn | retryAfterS (server value), waitS (capped value) |
| `ambiguous_write` | error | method, pathTemplate |
| `budget_exceeded` | error | budgetMs, elapsedMs |
| `auth_failure` | error | status, pathTemplate |
| `journal_write_failed` | warn | errorKind (journal failure is never a tool failure — surfaced as a hint) |
| `upstream_degraded` | warn | consecutiveFailures, host (emitted on the 3rd consecutive 5xx/transport failure; see §No circuit breaker) |
| `oauth_token_refreshed` | info | profile, expiresInMs, rotated |
| `oauth_token_refresh_failed` | error | profile, status, code |
| `shutdown` | info | reason (`stdin_eof` \| `sigint` \| `sigterm` \| `fatal`) |

Notes:

- `pathTemplate` is the route with placeholders (`/rest/api/3/issue/{key}`),
  never the concrete path — issue keys and project keys are workspace data.
- The table is complete: a new event = a new row here first, then code.
- The two `oauth_*` events are the only visibility into a refresh, which happens
  in the background with no tool call of its own to attribute it to. `rotated`
  says whether the refresh token itself was replaced, which is what makes the
  difference between "renewed" and "the old refresh token is now dead"
  (AUTH.md §Refresh and rotation). `expiresInMs` is the reported horizon of the
  new access token, not a constant we assume — the lifetime is not documented by
  Atlassian. `code` on a failure is the token endpoint's `error` field
  (`invalid_grant`, `unauthorized_client`, `invalid_client`, …), which is a
  fixed vocabulary, never the `error_description` prose. **No token, no
  `code_verifier`, no client secret ever appears in a field of either event** —
  and a failure sits at `error` alongside `auth_failure` for the same reason: it
  ends the session until a human runs `login` again.
- The `tool` field exists in **log events only**, and only on the two
  `tool_call_*` events: `budget_exceeded` and `ambiguous_write` are emitted
  from `core/http.ts`, which does not know the tool name, so the name reaches
  stderr through the `tool_call_end` that follows under the same `cid`. The
  model-facing `ErrorRecord` (frozen contract, core/types.ts) has no `tool`
  field either; for those two kinds the registry instead appends
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
- Two redacted lines to stderr at start: `settings_report` (how many
  findings, worst severity) and, once the transport is up, `server_start` —
  host, active profile, package count, write mode, transport, version — enough
  to diagnose "wrong site/wrong mode" from a support transcript alone. The
  findings themselves are not echoed: `doctor` prints them, and an
  error-severity one aborts the start with all of them in the error text.
- Version observability: server version appears in `server_start` and in
  `jira_capabilities` output.
- A transcript that comes back as a wall of placeholders has a stated cause: a
  registered secret that is very short, or that spells a word this server prints
  itself, scrubs the diagnostics along with itself — including the
  startup lines above. Redaction is never weakened for it
  (THREAT-MODEL.md §Credentials); startup validation adds a `warning`-severity
  finding naming the variable to edit, visible in `doctor`
  [test: src/core/settings.test.ts].

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
- The journal errs toward recording. A mutation whose request failed with no
  HTTP status is journaled as attempted (`ok: false`, no `httpStatus`), even
  when the failure came before the wire (credential resolution, a host check).
  The request seam cannot tell that case from a transport failure after the
  bytes left, and an audit trail that drops a write that may have landed is
  worse than one line too many.
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
