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

Files written by the CLI (`doctor --save`, and the token store `login` writes)
are created atomically with mode `0600`, guarded by a cross-process env lock.

## Core credentials (v1)

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_SITE` | yes | — | `"mycompany"`, `"mycompany.atlassian.net"`, or full URL. Which host forms are accepted without an allowlist is a wire rule — JIRA-API.md §Hosts; other hosts need `JIRA_ALLOWED_HOSTS`. |
| `JIRA_EMAIL` | yes | — | Atlassian account email for Basic auth. Not used under `JIRA_AUTH_MODE=oauth`. |
| `JIRA_API_TOKEN` | yes | — | API token (secret; registered with the redactor). Not used under `JIRA_AUTH_MODE=oauth` — still redacted if it is left set. |
| `JIRA_TOKEN_EXPIRES` | no | — | ISO date of the token's expiry (Cloud tokens expire ≤ 1 year). When set, doctor and the startup report warn ≤ 30 days out (`token_expiry_warning`, OBSERVABILITY.md). Ignored under `JIRA_AUTH_MODE=oauth` and `pat`, each of which says so rather than pretending to honour it. |
| `JIRA_ALLOWED_HOSTS` | no | — | Comma list of extra allowed hosts (Server/DC or vanity domains). Exact host or anchored regex (`/^jira\.example\.com$/`); suffix matching banned. A suffix form (`*.example.com`, `.example.com`) or a regex without both `^` and `$` is a startup error naming the entry (CC-231). The SSRF blocklist (loopback, private, link-local, metadata) wins over this list: an entry cannot make such a host reachable, and a `JIRA_SITE` naming one is a startup error (`host_blocked`, CC-233). |

The Required column describes the **default** mode, `basic`, which is what an
installation that sets nothing from the next section runs: all three are needed.
Under `JIRA_AUTH_MODE=oauth` the email and token are not used (a token left
in the environment is still redacted, never sent), and the requiredness moves to
the two client variables below.

## Authentication mode and OAuth 2.0 (3LO)

`JIRA_AUTH_MODE` selects **where credentials come from**, and nothing else: the
tool surface, the gates and the wire calls are identical in both modes. In
`basic` mode the three variables above are the credentials and this whole
section is inert. In `oauth` mode they are not read at all — `jira-mcp-ai login`
runs the authorization-code flow once and writes a token store, and the server
signs every call with the access token it finds there. The flow itself, its
threat model and what `login` / `logout` do are AUTH.md's; this table owns only
the names and defaults.

`JIRA_SITE` is required in **both** modes — it is what tells the server which
Jira site a call is about, whether or not the credentials came from a token.

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_AUTH_MODE` | no | `basic` | `basic` (email + API token), `oauth` (OAuth 2.0 3LO with PKCE), or `pat` (a Jira Data Center personal access token — only with `JIRA_DEPLOYMENT=datacenter`, see the next section). Selecting `oauth` changes which variables below are required, silences `JIRA_TOKEN_EXPIRES` — it describes an API token this mode never uses — and extends the egress allowlist as described under `JIRA_OAUTH_GATEWAY_ORIGIN`. |
| `JIRA_OAUTH_CLIENT_ID` | no | — | **Required in `oauth` mode**, ignored in `basic` — which is why the column says no. Client id of the OAuth 2.0 (3LO) app consent is asked for; create the app in the Atlassian developer console (AUTH.md §"Registering the app" covers what that costs you). |
| `JIRA_OAUTH_CLIENT_SECRET` | no | — | **Required in `oauth` mode** too (secret; registered with the redactor). Required despite PKCE, which is why it is not optional: Atlassian authenticates the client on the token endpoint, on the first exchange and on every refresh. |
| `JIRA_OAUTH_SCOPES` | no | `read:jira-work,write:jira-work,read:jira-user,manage:jira-project,read:board-scope:jira-software,write:board-scope:jira-software,read:sprint:jira-software,write:sprint:jira-software,read:epic:jira-software,write:epic:jira-software,read:issue:jira-software,write:issue:jira-software,offline_access` | Comma list of scopes `login` asks consent for. The default covers the v1 tool surface and deliberately leaves out global admin and sprint deletes (AUTH.md §Scopes). **Changing this list after a successful login forces a re-consent** — Atlassian never widens a stored grant silently, so run `login` again after editing it. |
| `JIRA_OAUTH_CLOUD_ID` | no | — | Pins the flow to one Jira Cloud site. A **pin, not a cache**: discovery stays the default path, so unset means every run resolves the site from the accessible-resources endpoint. Set it only when the authorized account can reach several sites and you want one of them — `login` prints the id. At call time it is checked against the cloudId the profile's stored tokens were issued for, and a mismatch is a `config` error (re-run `login`, or unset it; CC-165). Refused at startup if it is not path-safe (it goes into every request path). |
| `JIRA_OAUTH_TOKEN_FILE` | no | `<config dir>/oauth.json` | Where `login` writes the token store, mode `0600`. `<config dir>` is the directory the env file is looked for in (`$XDG_CONFIG_HOME/jira-mcp-ai`, default `~/.config/jira-mcp-ai`), so tokens sit beside the env file rather than in the project. A leading `~` and relative paths are expanded exactly as for `JIRA_ENV_FILE`. |
| `JIRA_OAUTH_REDIRECT_PORT` | no | `8250` | Loopback port `login` binds for the redirect callback. It must match the callback URL registered on the app character for character — AUTH.md §"The redirect URI is the unverified part of this feature" spells the URL. Unprivileged ports only (1024–65535). |
| `JIRA_OAUTH_AUTH_ORIGIN` | no | `https://auth.atlassian.com` | Origin of the authorization server the browser is sent to and tokens are exchanged at. Must be an **https origin with no path, query, fragment or credentials** — this is where the client secret is sent, so anything beyond an origin is a typo or somebody's redirect target. It exists so the offline test harness can point the flow at a local fake; there is no reason to set it against a real tenant. |
| `JIRA_OAUTH_GATEWAY_ORIGIN` | no | `https://api.atlassian.com` | Origin of the OAuth API gateway `oauth`-mode requests are routed through instead of the site host. Same origin rules and same test-harness reason as `JIRA_OAUTH_AUTH_ORIGIN`. Every Jira call goes to this host, so it must not be loopback, private, link-local or a metadata address — the SSRF blocklist refuses those even when allowlisted, and the resolver says so before anything is sent (CC-230). In `oauth` mode the hostnames of both origins are appended to the effective egress allowlist, so a redirected flow still cannot reach a host you did not configure; in `basic` mode the allowlist is byte-for-byte what `JIRA_ALLOWED_HOSTS` says. |

## Jira Data Center (Phase 13 — unverified read-only preview)

The Data Center adapter is being built in stages (D106, D107,
IMPLEMENTATION-PLAN.md Phase 13). Stage 13.3 serves a **read-only** subset of
the tools (`jira_capabilities` lists them; the rest are excluded as
`deployment_unsupported`), built from Atlassian's Data Center documentation and
**never run against a Data Center instance**. It therefore fails closed:
selecting `datacenter` is a startup error (`deployment_unavailable`) unless
`JIRA_DATACENTER_PREVIEW=true` says you accept that, in which case the server
starts with a `deployment_unverified` warning. `jira-mcp-ai doctor` probes a
Data Center site either way (`/rest/api/2/myself` and `/serverInfo`, with the
PAT), which is the way to check a site before turning the preview on.

| Variable | Required | Default | Description |
|---|---|---|---|
| `JIRA_DEPLOYMENT` | no | `cloud` | `cloud` or `datacenter`. `datacenter` requires `JIRA_AUTH_MODE=pat`, and `pat` requires `datacenter` — each other combination is a startup error (`auth_mode_deployment`), because the two products share no credential. Under `datacenter`, `JIRA_SITE` must name a host listed in `JIRA_ALLOWED_HOSTS` (an `.atlassian.net` host is refused, `host_deployment_mismatch`); a dot-less name is never completed to `.atlassian.net`; and a **context path is kept** — `https://jira.example.com/jira` sends requests under `/jira` — where on Cloud it is stripped. A context path containing the REST root (`/rest/…`) or a path that could not be a request prefix is a startup error (`site_context_path`). |
| `JIRA_PAT` | no | — | **Required when `JIRA_AUTH_MODE=pat`**. A Data Center personal access token, sent as `Authorization: Bearer` to the site host (secret; registered with the redactor whenever it is set). Set under any other mode it is ignored with a warning (`pat_ignored`). |
| `JIRA_DATACENTER_PREVIEW` | no | `false` | Required for `JIRA_DEPLOYMENT=datacenter` to start: your acknowledgement that the Data Center adapter is an unverified read-only preview (D107). Set with `cloud` it is ignored with a warning (`datacenter_preview_ignored`). |

## Profiles

| Variable | Default | Description |
|---|---|---|
| `JIRA_PROFILE_<NAME>_SITE` / `_EMAIL` / `_API_TOKEN` | — | Named profile credentials. `<NAME>` is case-insensitive; two spellings of one variable are refused. |
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
| `JIRA_ALLOW_IRREVERSIBLE` | `false` | Opt-in for the irreversible write tier (the deletes, D45 and D102, and the bulk delete/edit pair, D103). Without it those tools refuse even under `JIRA_WRITE_MODE=apply` — blanket write mode never covers the tier. |

## HTTP behaviour

| Variable | Default | Description |
|---|---|---|
| `JIRA_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout via injected clock/AbortSignal. Integer in 1–600000. |
| `JIRA_CALL_BUDGET_MS` | `120000` | Wall-clock budget for one tool call's total HTTP activity — retry waits and semaphore queueing count against it. On breach: abort with `kind=budget_exceeded` (OBSERVABILITY.md §Call budget). Integer in 1–3600000. |
| `JIRA_HOST_CONCURRENCY` | `4` | Per-host semaphore slots. Integer in 1–64. |
| `JIRA_RETRY_ATTEMPTS` | `3` | Max retry attempts (policy in JIRA-API.md). Integer in 0–10; `0` disables retries. |
| `JIRA_MAX_RESULT_CHARS` | `25000` | Truncation budget for tool results, measured on the serialized `structuredContent`. The text channel of an untrusted result can be longer: it adds the taint banner, and each fence bracket inside tenant text becomes a six-character `\uXXXX` escape. Integer in 500–10000000. |
| `JIRA_MAX_PAGES` | `20` | Loop guard for `fetchAll`/`searchPages`. Integer in 1–1000. |
| `JIRA_MEDIA_DIR` | — | Directory attachment downloads land in (and uploads are read from). Unset ⇒ the binary attachment tools refuse with a `config` error; metadata listing needs no directory (D45). A leading `~` is expanded and a relative path is resolved against the cwd, as for `JIRA_ENV_FILE` (CC-184). |

The ranges above are inclusive, and a value is plain decimal digits: `3e4`,
`0x10` or `4.0` — or anything outside the range — is an `invalid_number`
startup error, never a silent clamp (CC-141).

## Transport

| Variable | Default | Description |
|---|---|---|
| `JIRA_TRANSPORT` | `stdio` | `stdio` (default) or `http` — the loopback Streamable HTTP transport (D101). |
| `JIRA_HTTP_PORT` | `3334` | Loopback port the `http` transport binds — `127.0.0.1` only, never another interface (CC-115). Integer in 1–65535. |
| `JIRA_HTTP_TOKEN` | — | Bearer token (secret; registered with the redactor) required on every `http` request (CC-114). Required whenever `http` is selected — settings refuse that combination without it (CC-30). |

## Diagnostics

| Variable | Default | Description |
|---|---|---|
| `JIRA_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`; all output to stderr. |
| `JIRA_JOURNAL_PATH` | — | Optional write-journal (JSONL of every write tool call: tool, args hash, result, timestamp). A leading `~` is expanded and a relative path is resolved against the cwd (CC-184). |

## Test-only variables

Not read by the server; listed here so the env ↔ docs sync test (TESTING.md)
knows they are deliberately outside the runtime surface.

| Variable | Default | Description |
|---|---|---|
| `JIRA_LIVE_TEST` | — | `1` makes the unit-test network fence (`src/testing/network-fence.ts`) keep ambient `JIRA_*` variables and skip the fence. No test uses it and CI does not set it; the live read suite is `scripts/verify-live.mjs` (TESTING.md suite 9), which does not read this variable. |

## Claude Code registration (example)

Put this in `.mcp.json` (project scope), or paste the inner `"jira"` object
into `claude mcp add-json jira '<object>'` — `claude mcp add` takes CLI
arguments, not JSON.

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "jira-mcp-ai@0.9.4"],
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
