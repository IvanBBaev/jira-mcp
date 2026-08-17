# Configuration

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns **env var names and defaults** — a default
> stated anywhere else is a pointer to this table.

All configuration is environment variables with the `JIRA_` prefix. `loadSettings()`
returns `{ settings, report }`; `assertStartupOk(report)` fails closed on
error-severity findings. Every knob has a documented default here; `core/http.ts`
never imports settings — every option is passed explicitly.

## Env file resolution

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_ENV_FILE` | no | — | Explicit path to the env file; wins over every other location. |

Resolution order:

1. `JIRA_ENV_FILE` (explicit path)
2. `$XDG_CONFIG_HOME/jira-mcp-ai/.env` (default `~/.config/jira-mcp-ai/.env`)
3. project-local `.env` (development only)

`XDG_CONFIG_HOME` is a platform convention, not a knob of this server: it
carries no `JIRA_` prefix and the env ↔ docs sync test (TESTING.md suite 8)
scopes itself to `JIRA_*` names, so it needs no row of its own.

Files are loaded with Node's `process.loadEnvFile()` — no dotenv dependency
(D10 in DECISIONS.md: dotenv ≥ 17 prints a stdout banner, which would corrupt
the MCP protocol).

Files written by the CLI (`doctor --save`, future `login`) are created atomically
with mode `0600`, guarded by a cross-process env lock.

## Core credentials (v1)

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_SITE` | yes | — | `"mycompany"`, `"mycompany.atlassian.net"`, or full URL. Which host forms are accepted without an allowlist is a wire rule — JIRA-API.md §Hosts; other hosts need `JIRA_ALLOWED_HOSTS`. |
| `JIRA_EMAIL` | yes | — | Atlassian account email for Basic auth. |
| `JIRA_API_TOKEN` | yes | — | API token (secret; registered with the redactor). |
| `JIRA_TOKEN_EXPIRES` | no | — | ISO date of the token's expiry (Cloud tokens expire ≤ 1 year). When set, doctor and the startup report warn ≤ 30 days out (`token_expiry_warning`, OBSERVABILITY.md). |
| `JIRA_ALLOWED_HOSTS` | no | — | Comma list of extra allowed hosts (Server/DC or vanity domains). Exact host or anchored regex; suffix matching banned. |

## Profiles

| Variable | Default | Description |
|---|---|---|
| `JIRA_PROFILE_<NAME>_SITE` / `_EMAIL` / `_API_TOKEN` | — | Named profile credentials. |
| `JIRA_ACTIVE_PROFILE` | — | Profile used when a tool call doesn't specify one. |
| `JIRA_LOCK_PROFILE` | `true` | Per-call profile switching is rejected. Locked by default (O-6): a model that can pick the tenant per call can leak issue text across tenants, so unlocking is a deliberate act. |

Per-call resolution flows through AsyncLocalStorage (the `runWithCid` seam in
`core/log.ts`), same pattern as servicenow-mcp.

## Tool surface gating

| Variable | Default | Description |
|---|---|---|
| `JIRA_TOOL_PACKAGES` | `all` | Profile (`core`, `reader`, `all`) or explicit comma list of packages. `reader` = core + search + issues + meta + users + agile reads. |
| `JIRA_PACKAGES_DENY` | — | Deny list; wins over selection; `core` is force-re-added. |
| `JIRA_PACKAGES_READONLY` | — | Packages whose write-tier tools are dropped. |
| `JIRA_WRITE_MODE` | `plan` | `plan` = writes describe instead of execute; `apply` = writes execute when the call passes `apply: true`. Gate contract: THREAT-MODEL.md. |
| `JIRA_ALLOW_IRREVERSIBLE` | `false` | Opt-in for the irreversible write tier (deletes, D45). Without it those tools refuse even under `JIRA_WRITE_MODE=apply` — blanket write mode never covers the tier. |

## HTTP behaviour

| Variable | Default | Description |
|---|---|---|
| `JIRA_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout via injected clock/AbortSignal. |
| `JIRA_CALL_BUDGET_MS` | `120000` | Wall-clock budget for one tool call's total HTTP activity — retry waits and semaphore queueing count against it. On breach: abort with `kind=budget_exceeded` (OBSERVABILITY.md §Call budget). |
| `JIRA_HOST_CONCURRENCY` | `4` | Per-host semaphore slots. |
| `JIRA_RETRY_ATTEMPTS` | `3` | Max retry attempts (policy in JIRA-API.md). |
| `JIRA_MAX_RESULT_CHARS` | `25000` | Truncation budget for tool results. |
| `JIRA_MAX_PAGES` | `20` | Loop guard for `fetchAll`/`searchPages`. |
| `JIRA_MEDIA_DIR` | — | Directory attachment downloads land in (and uploads are read from). Unset ⇒ the binary attachment tools refuse with a `config` error; metadata listing needs no directory (D45). |

## Transport

| Variable | Default | Description |
|---|---|---|
| `JIRA_TRANSPORT` | `stdio` | Accepts `stdio` or `http`, but **only `stdio` runs**: `http` is parsed, then refused at startup with an error naming v1.5 (D19). |
| `JIRA_HTTP_PORT` | `3334` | Loopback-only Streamable HTTP port. Parsed and validated; unused until the HTTP transport is reinstated. |
| `JIRA_HTTP_TOKEN` | — | Required whenever `http` is selected — settings refuse that combination without it (CC-30) — though the transport itself is refused a step later regardless. |

## Diagnostics

| Variable | Default | Description |
|---|---|---|
| `JIRA_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`; all output to stderr. |
| `JIRA_JOURNAL_PATH` | — | Optional write-journal (JSONL of every write tool call: tool, args hash, result, timestamp). |

## Test-only variables

Not read by the server; listed here so the env ↔ docs sync test (TESTING.md)
knows they are deliberately outside the runtime surface.

| Variable | Default | Description |
|---|---|---|
| `JIRA_LIVE_TEST` | — | `1` enables the live read suite against the scratch site; unset, those tests skip. |

## Claude Code registration (example)

Put this in `.mcp.json` (project scope), or paste the inner `"jira"` object
into `claude mcp add-json jira '<object>'` — `claude mcp add` takes CLI
arguments, not JSON.

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "jira-mcp-ai@0.9.0"],
      "env": {
        "JIRA_SITE": "mycompany",
        "JIRA_EMAIL": "me@example.com",
        "JIRA_API_TOKEN": "<api-token>",
        "JIRA_WRITE_MODE": "plan"
      }
    }
  }
}
```

The version is **pinned deliberately**. `npx -y jira-mcp-ai` re-resolves to
whatever is newest at spawn time, which means a published package can start
running new code inside an agent session with no review step — the same supply
chain risk the files-allowlist and provenance items in Phase 5 address from the
publishing side. Bump the pin when you have read the changelog.

## When the client shows no server

**It is almost always PATH.** Claude Desktop launches MCP servers from a minimal
environment that does not include your shell's PATH, so a `node`/`npx` installed
by nvm, Homebrew or fnm is invisible to it and the launch fails inside the
client, before this server runs — you get the client's generic "server failed"
message and nothing on this server's stderr, because there was no process. Fix it
by giving an absolute path: `"command": "/usr/local/bin/npx"` (`which npx` prints
yours). Claude Code, run from a terminal, inherits your PATH and is not affected.

When the process *does* start, everything it says goes to **stderr** — stdout is
the MCP protocol (D10). Claude Code keeps stderr in `~/.claude/logs/`; Claude
Desktop in `~/Library/Logs/Claude/mcp*.log` (macOS) or `%APPDATA%\Claude\logs\`
(Windows). The startup report, the `token_expiry_warning` and every
error-severity finding from `assertStartupOk` land there.
