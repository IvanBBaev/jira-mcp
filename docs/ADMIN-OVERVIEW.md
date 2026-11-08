# Admin overview

> Status: normative and implemented — a one-page summary for Jira site admins
> and security reviewers. Every fact here points at the document that owns it;
> where they disagree, the owner wins and this page is the bug.

`jira-mcp-ai` is a local MCP server: an AI client starts it on a user's machine
(or in a container) and it calls the Jira REST API with **one credential that
the operator supplies**. It can never do more than that credential can do in
Jira, and by default it does less: writes return a plan and change nothing
until the operator switches them on. It sends nothing anywhere except the
Jira site and Atlassian's own auth hosts.

## What it can do, and how to restrict it

| Control | Set by | What it enforces | What it does not |
|---|---|---|---|
| `JIRA_TOOL_PACKAGES=reader` | operator | A read-only surface: every write tool is removed, not just gated | Does not stop reads of anything the credential can see |
| `JIRA_PACKAGES_DENY` | operator | Removes whole packages (e.g. `collab`, `issues-delete`); `core` always stays | Package-grained: denying `collab` also drops watchers and votes |
| `JIRA_PACKAGES_READONLY` | operator | Keeps a package's reads, removes its writes | Same granularity |
| `JIRA_WRITE_MODE` | operator | `plan` (default): writes return a plan only. `apply` lets a call with `apply: true` execute | Not a human check: in `apply` mode the model can plan and apply on its own |
| `JIRA_ALLOW_IRREVERSIBLE` | operator | Deletes, unlinks and the bulk writes run only when it is set; `apply` alone never covers them | Planning a delete still works, by design |
| `JIRA_IRREVERSIBLE_CONFIRM=elicit` | operator | A human yes in the client UI for each irreversible apply; the model cannot answer it | A client that auto-accepts collapses it |
| `JIRA_WRITE_CONFIRM=elicit` / `tainted` | operator | A human yes in the client UI for every applied write (`elicit`), or for every write after the session read Jira content (`tainted`) | A client that auto-accepts collapses it; `tainted` sees tool results only, not resources or prompts |
| `JIRA_PROJECTS` | operator | Every call is confined to the listed project keys; out-of-scope calls are refused before anything is sent | Not a Jira permission boundary; global metadata and saved filters stay readable |
| `JIRA_LOCK_PROFILE` (on by default) | operator | One process, one tenant: a per-call profile switch is refused | Anyone who starts the process can unlock it |
| Jira permissions and project roles | Jira admin | The real boundary: the server acts as the credential's user | — |
| OAuth scopes | Jira admin / operator | A ceiling on what a token can call | A scope cannot separate edit from delete; the gates above do |

Details: [THREAT-MODEL.md](THREAT-MODEL.md#write-safety-normative-gate-contract-single-owner-this-document)
(the write-gate contract) and
[THREAT-MODEL.md](THREAT-MODEL.md#project-scope-and-profile-lock);
variables and defaults: [CONFIGURATION.md](CONFIGURATION.md).

## Whose identity

| Option | Acts as | Notes |
|---|---|---|
| API token (Basic, default) | the token's user, with all of that user's permissions | Simplest; tokens expire (max 1 year) |
| Scoped API token | the token's user, capped by the scopes picked at creation | Needs `JIRA_CLOUD_ID`; goes through the Atlassian gateway |
| OAuth 2.0 (3LO) | the consenting user, capped by the app's scopes | You register your own app; `login` stores a refresh token locally |
| Service account (`JIRA_OAUTH_GRANT=client_credentials`) | a dedicated Atlassian service account | Recommended for shared or unattended use and for attributable audit; needs Atlassian Guard |
| Data Center PAT (`JIRA_DEPLOYMENT=datacenter`) | the PAT's user | Preview, unverified against a live host |

Details: [AUTH.md](AUTH.md).

## Which scopes

[AUTH.md](AUTH.md#scopes) maps every tool to the scopes it needs; a test keeps
that map in step with the tool list. Two presets are ready to paste
([AUTH.md](AUTH.md#scope-presets)): **Reader** (no write scope at all, for
`JIRA_TOOL_PACKAGES=reader`) and **Core writes** (issue and sprint work, no
project configuration, no sprint deletion). The default `JIRA_OAUTH_SCOPES`
list is broader and leaves out global admin and sprint deletion. Service
accounts have a scope checklist in
[AUTH.md](AUTH.md#oauth-20-client-credentials-service-accounts).

## Where data goes (egress)

| Destination | When |
|---|---|
| The Jira site (`<site>.atlassian.net`, or a host in `JIRA_ALLOWED_HOSTS`) | Basic auth with a classic token; Data Center |
| `api.atlassian.com` | OAuth and scoped tokens: every Jira call goes through this gateway |
| `auth.atlassian.com` | OAuth only: `login`, token refresh, service-account token mint |
| One Atlassian media host, one hop, no credential | `jira_download_attachment` only, when Jira redirects to a signed URL |

Nothing else: no telemetry, no update check. Hosts are default-deny; server-sent
URLs are never followed. What the AI client then does with tool results
(sending them to its model provider) is outside the server and under the
client's terms. Details: [THREAT-MODEL.md](THREAT-MODEL.md#ssrf-egress) and
[THREAT-MODEL.md](THREAT-MODEL.md#data-handling-acceptable-use).

## Data at rest

The four tenant-data sinks are off until their variable is set (exports
default to a subdirectory of the media directory); the OAuth token store
exists only in oauth mode. Every file is `0600`; retention of the four sinks
is the operator's job, as the server never deletes them.

| Sink | Variable | Holds |
|---|---|---|
| Write journal | `JIRA_JOURNAL_PATH` | Metadata of executed writes: time, tool, argument hash, outcome, issue key. No field values |
| Attachment downloads | `JIRA_MEDIA_DIR` | Attachment bytes as stored in Jira |
| File exports | `JIRA_EXPORT_DIR` | Pages of issue, comment, changelog, worklog or sprint rows |
| Portfolio reports | `JIRA_REPORT_DIR` | Markdown reports with issue keys and summaries |
| OAuth token store | `JIRA_OAUTH_TOKEN_FILE` | 3LO refresh and access tokens, no tenant content |

Logs go to stderr, through the redactor; credentials never appear in them. The
metadata cache is in memory only. Details:
[THREAT-MODEL.md](THREAT-MODEL.md#local-filesystem).

## What the audit trail shows

- **In Jira:** every write appears in the issue history as the credential's
  user. The server adds no marker (no custom User-Agent, label or comment
  footer), so an agent's edit looks exactly like that user's own edit. For
  attributable audit, run the server as a **service account**.
- **Locally:** the write journal (`JIRA_JOURNAL_PATH`) records every executed
  write with a correlation id that also appears in the stderr log. Plans are
  not journaled — nothing happened. Details:
  [OBSERVABILITY.md](OBSERVABILITY.md#write-journal).

## How to revoke

| Credential | Revoke it |
|---|---|
| API token or scoped token | Revoke it at id.atlassian.com (Security → API tokens) |
| OAuth 3LO grant | Remove the app's access from the user's Atlassian account, or rotate the app's client secret. `jira-mcp-ai logout` only deletes the local token file |
| Service account | Delete or rotate its OAuth credential in Atlassian Administration |
| Data Center PAT | Revoke it in the user's Jira profile |
| `JIRA_HTTP_TOKEN` (HTTP transport) | Change it and restart the server |

Stopping the process ends all access that is held only in memory. Details:
[AUTH.md](AUTH.md#logout-deletes-local-tokens-it-does-not-revoke-them).
