# Troubleshooting

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns the **operator-facing fix for each error
> kind**: what you see, the likely cause, what to do, and which `doctor` check
> covers it. The kinds themselves are defined in
> [TOOLS.md §Error-kind catalog](TOOLS.md#error-kind-catalog); `doctor`,
> startup errors and `--help` link here through `src/core/doc-url.ts` (D545).

Start with `npx -y jira-mcp-ai doctor` in the same environment the client uses:
it checks the configuration, probes the site and prints one finding per problem.
The `doctor` check ids named below are the ones its report prints.

## The client shows no server

The process never started, so this server printed nothing. It is almost always
PATH: see
[CONFIGURATION.md §When the client shows no server](CONFIGURATION.md#when-the-client-shows-no-server),
which also lists where each client keeps the server's stderr log.

## The server exits at startup

A configuration problem stops the server before it serves anything, with every
problem in one report on stderr and exit code 2. Run `doctor` to print the same
report without starting the server, fix the variables it names (names and
defaults: [CONFIGURATION.md](CONFIGURATION.md)) and restart the client.

## Error kinds

Every failed tool call carries one `kind`. The model reads the same remediation
text; the entries below are for the person who runs the server.

### `config`

- **You see:** the server will not start, or a tool fails with a configuration
  message.
- **Likely cause:** a missing or inconsistent `JIRA_*` variable: no site, no
  credential, a malformed value, an auth mode whose other half is unset.
- **Fix:** run `doctor`, fix every variable it lists, restart the client.
- **`doctor` check:** `settings`, `host`, `env-file`.

### `auth`

- **You see:** every call fails with 401, including reads.
- **Likely cause:** the API token was revoked or expired (Atlassian Cloud tokens
  last a year at most), `JIRA_EMAIL` is not the token's owner, or, with OAuth,
  the stored refresh token is gone.
- **Fix:** issue a new API token and restart, or run `jira-mcp-ai login` again
  under OAuth. A scoped token sent to the site host instead of the gateway also
  fails here: see [AUTH.md §Scoped API tokens](AUTH.md#scoped-api-tokens).
- **`doctor` check:** `identity`, `token-expiry`, `oauth`.

### `permission`

- **You see:** a 403 on one project or resource while others work, or a refusal
  that names the project scope.
- **Likely cause:** the account lacks a Jira permission, a scoped token or OAuth
  grant lacks a scope, or the request falls outside `JIRA_PROJECTS`.
- **Fix:** ask a Jira administrator for the permission, re-create the token with
  the missing scope, or widen `JIRA_PROJECTS` if the call is meant to be
  allowed. Repeating the call unchanged fails again.
- **`doctor` check:** `identity`, `search`.

### `not_found`

- **You see:** an issue, project or board that you know exists is reported as
  not found.
- **Likely cause:** Jira answers 404 both for something that does not exist and
  for something this account may not see.
- **Fix:** confirm the key, then check that the server's account can browse the
  project (open it in Jira as that user).
- **`doctor` check:** `search`.

### `validation`

- **You see:** Jira rejected a request as invalid: JQL syntax, an unknown
  field, a value the field does not accept.
- **Likely cause:** the request does not match this site's fields, screens or
  workflow.
- **Fix:** nothing to configure; the model is expected to correct the request.
  If it keeps failing, check the field on the issue's create or edit screen.
- **`doctor` check:** none.

### `rate_limited`

- **You see:** calls fail with 429 after the server's own retries.
- **Likely cause:** too many requests from this account, often several agents or
  scripts sharing one token.
- **Fix:** wait, then lower the request rate: fewer parallel sessions, smaller
  pages. Retry tuning is in
  [CONFIGURATION.md §HTTP behaviour](CONFIGURATION.md#http-behaviour).
- **`doctor` check:** none.

### `transport`

- **You see:** network, DNS or TLS failures after retries.
- **Likely cause:** no route to the site, a proxy Node's fetch does not use, or
  a TLS-inspecting proxy whose CA Node does not trust.
- **Fix:** check connectivity and https://status.atlassian.com; behind a proxy,
  follow [CONFIGURATION.md §Proxy and custom CA](CONFIGURATION.md#proxy-and-custom-ca).
- **`doctor` check:** `network`, `host`.

### `timeout`

- **You see:** a single request ran out of time.
- **Likely cause:** a slow site or a large request (many fields, large pages).
- **Fix:** narrow the request, or raise the per-request timeout
  ([CONFIGURATION.md §HTTP behaviour](CONFIGURATION.md#http-behaviour)).
- **`doctor` check:** `network`.

### `ambiguous_write`

- **You see:** a write failed in a way that leaves its outcome unknown.
- **Likely cause:** the connection dropped or timed out after Jira may already
  have applied the change. The server never replays such a write.
- **Fix:** open the issue in Jira and check whether the change landed before
  asking for it again; a blind retry can duplicate a comment, a link or an
  issue.
- **`doctor` check:** none.

### `budget_exceeded`

- **You see:** one tool call stopped before it finished.
- **Likely cause:** the whole call, across all its pages and retries, outlived
  the per-call budget.
- **Fix:** narrow the request (fewer pages, fewer fields), or raise the call
  budget ([CONFIGURATION.md §HTTP behaviour](CONFIGURATION.md#http-behaviour)).
- **`doctor` check:** none.

### `write_gated`

- **You see:** a write was refused, or only a plan came back.
- **Likely cause:** working as designed. In `plan` mode a write returns a plan
  and changes nothing; it runs only when the server is in `apply` mode and the
  call repeats with `apply: true` and the plan's `plan_id`. A tool in a
  read-only package, a stale or foreign `plan_id`, and an irreversible tool that
  is not enabled are refused the same way.
- **Fix:** set `JIRA_WRITE_MODE=apply` if writes are meant to run, and enable
  the package or tier the tool needs
  ([CONFIGURATION.md §Tool surface gating](CONFIGURATION.md#tool-surface-gating)).
  The full contract is
  [THREAT-MODEL.md §Write safety](THREAT-MODEL.md#write-safety-normative-gate-contract--single-owner-this-document).
- **`doctor` check:** `gating`.

### `unexpected_shape`

- **You see:** a call failed because Jira's answer could not be read.
- **Likely cause:** a proxy or gateway answered instead of Jira, or the Jira API
  changed.
- **Fix:** retrying unchanged will not help. If it persists, open an issue with
  the tool name and the request (never the token).
- **`doctor` check:** `network`, `deployment`.

### `unsupported`

- **You see:** board, sprint or backlog tools fail while issue tools work.
- **Likely cause:** the Jira Software (Agile) API is unlicensed, disabled or
  invisible to this account, or the endpoint does not exist on this deployment.
- **Fix:** use the platform tools instead, or ask an administrator to enable
  Jira Software for the account.
- **`doctor` check:** `agile`, `deployment`.
