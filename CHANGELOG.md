# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because registrations pin an exact version (see README), this file is the thing a
user reads before bumping the pin. Entries describe what changes for **them** —
new or renamed tools, changed tool input/output shapes, changed defaults, changed
env var names — not internal refactors.

## [Unreleased] — 1.0.0 pending

The surface below is implemented and is what 1.0.0 will contain. **Nothing has
been published**: the package is still `private` at version `0.0.0`, and whether
to publish at all is an open owner decision. There is no release to bump a pin
to yet, so everything here is "added" relative to nothing.

### Added

- **52 tools in 10 packages**, registered as a set you choose with
  `JIRA_TOOL_PACKAGES`:
  - `core` (2) — `jira_capabilities`, `jira_get_myself`.
  - `search` (4) — JQL search and approximate count, plus the saved-filter
    reads `jira_list_filters` / `jira_get_filter`. Neither filter tool runs the
    stored JQL; `jira_search` is the only tool that executes one.
  - `issues` (5) — issue, comments, transitions, changelog and worklog reads.
  - `issues-write` (8) — create, update, transition, add comment, edit comment,
    assign, worklog, link.
  - `issues-delete` (3) — delete issue, comment and worklog, behind the
    irreversible tier below. Not in the `reader` profile and in no read-only
    selection; `JIRA_PACKAGES_DENY=issues-delete` removes the surface entirely.
  - `attachments` (3) — list attachment metadata, download a file to disk,
    upload a file from disk.
  - `collab` (12) — watchers, votes, components, versions and project roles:
    the surface around an issue rather than inside it. Nothing in this package
    deletes anything — "remove watcher" and "remove vote" are links their `add`
    twin restores exactly.
  - `meta` (6) — projects, fields, create-meta, statuses and link types.
  - `users` (1) — `jira_search_users`.
  - `agile` (8) — boards, sprints, sprint issues, move to sprint and to
    backlog, plus the sprint lifecycle (create, start, close).
- **Markdown on the way in and on the way out.** `jira_get_issue` and
  `jira_get_comments` take `format: "text" | "markdown"`, and every rich-text
  input on the 7 write tools that has one (`description`, `body`, `comment`)
  takes the same option. The default is `text` and its output is byte-identical
  to having no option at all, so nothing you already call changes. The dialect
  is deliberately narrow — headings, lists, fenced code, inline code, bold,
  italic, links — and anything outside it degrades exactly the way plain-text
  flattening always did. Two safety rules travel with it: a mention renders
  one-way (`@name` out, literal text back in), and only `http(s):` and
  `mailto:` links keep their href.
- **A plan/apply gate on all 25 write tools.** `JIRA_WRITE_MODE` defaults to
  `plan`, where a write tool describes the change and returns a single-use
  `plan_id` instead of performing it. Executing takes all three:
  `JIRA_WRITE_MODE=apply`, an explicit `apply: true`, and that `plan_id` echoed
  back with identical arguments. Ids die with the server process, and unsafe
  writes are never replayed after an ambiguous failure.
- **An irreversible tier for the three deletes**, which the normal gate does
  not cover. On top of plan → apply they need `JIRA_ALLOW_IRREVERSIBLE=true`:
  a blanket `JIRA_WRITE_MODE=apply` is never enough, because the variable is
  set by the person who starts the server and the model cannot fill it in.
  Planning a delete always works, even on a server that will never permit the
  apply, and a refusal costs you nothing — no request is made and the
  `plan_id` is not consumed, so flipping the variable and restarting does not
  mean re-planning. The plan carries a `before` snapshot of what the apply
  would destroy (for an issue: its summary, status and subtask keys; for a
  comment or worklog: author, timestamps and an excerpt of the text), and a
  successful apply echoes that same snapshot back — Jira answers a delete with
  an empty 204, so this is the only receipt there is.
- **Attachments, with the bytes on disk instead of in the conversation.**
  `JIRA_MEDIA_DIR` is the one directory the server reads from and writes to.
  Unset, the download and upload tools refuse with a configuration error and
  make no Jira call at all; metadata listing needs no directory and keeps
  working. A download sanitizes the Jira-supplied filename (it is tenant-authored
  text, and `../../etc/passwd` lands as `passwd` inside your media directory),
  never overwrites — a collision gets a suffixed name and the result tells you
  it was renamed — and writes the file `0600`; the untouched original name is
  still reported. An upload takes a plain file name inside that same directory
  and **refuses** paths, `..` and subdirectories rather than rewriting them. Both
  directions are size-capped, and an upload that fails ambiguously is never
  retried for you.
- **Tenant text arrives branded.** Any result that can carry free text written
  inside Jira — issue and comment bodies, changelogs, worklogs, filter
  descriptions, attachment filenames, delete `before` snapshots — is marked
  `_untrusted` with a note that its content is data, never instructions.
- **`jira-mcp-ai doctor`** — checks the configuration and probes the site, with
  `--version` and `--help` alongside it. Its report goes to stdout only on these
  non-server paths; under the server, stdout is the MCP protocol and every
  diagnostic goes to stderr.
- **Credential profiles** — `JIRA_PROFILE_<NAME>_SITE` / `_EMAIL` /
  `_API_TOKEN`, selected with `JIRA_ACTIVE_PROFILE`. `JIRA_LOCK_PROFILE`
  defaults to `true`, so a single tool call cannot switch tenant unless you
  unlock it deliberately.
- **Package trimming** — `JIRA_PACKAGES_DENY` wins over the selection (`core` is
  force-re-added, so the server is never left with no tools), and
  `JIRA_PACKAGES_READONLY` drops just the write-tier tools out of a package it
  otherwise keeps.
- **Budgets and loop guards** — `JIRA_REQUEST_TIMEOUT_MS` (30000),
  `JIRA_CALL_BUDGET_MS` (120000), `JIRA_HOST_CONCURRENCY` (4),
  `JIRA_RETRY_ATTEMPTS` (3), `JIRA_MAX_RESULT_CHARS` (25000) and
  `JIRA_MAX_PAGES` (20). Results are truncated to a stated budget rather than
  returned whole.
- **Host allowlisting** — outbound requests go to the configured site and to
  `JIRA_ALLOWED_HOSTS` entries only, matched exactly or by anchored regex. No
  suffix matching. Redirects are not followed, with one deliberate exception:
  an attachment download follows exactly one hop to the signed media URL Jira
  answers with. That hop must be `https:` and not a private or link-local
  address, and it carries no credentials — your API token is never sent to it.
- **Secret redaction and an optional write journal** — the API token is
  registered with the redactor and never logged; `JIRA_JOURNAL_PATH` records
  every write tool call as JSONL.
- **API token expiry warnings** — `JIRA_TOKEN_EXPIRES` makes startup and
  `doctor` warn 30 days out.
- **Transport: stdio.** `JIRA_TRANSPORT`, `JIRA_HTTP_PORT` and `JIRA_HTTP_TOKEN`
  are still read and validated, but the HTTP transport is deferred past 1.0:
  starting with `JIRA_TRANSPORT=http` fails immediately with a message saying
  so, rather than silently falling back to stdio.
- Distribution manifests, all inert until publishing is decided: `server.json`
  for the MCP registry, `.claude-plugin/` for Claude Code, and a release
  workflow that publishes over GitHub OIDC with no npm token anywhere.
- Repository furniture: build, lint, format, coverage and CI configuration; the
  `npm run check` gate; the docs consistency linter (`scripts/docs-lint.mjs`)
  and the tarball-content assertion (`scripts/check-tarball.mjs`).

### Notes

- Jira Cloud REST v3 only, so issue and comment bodies are ADF. Users are
  addressed by `accountId`; there is no name or email lookup shortcut.
- Search runs on `/rest/api/3/search/jql` with `nextPageToken` paging. The
  legacy `/rest/api/3/search` endpoint was removed by Atlassian on 2025-08-01
  and is not called.
