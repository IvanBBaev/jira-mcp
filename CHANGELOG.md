# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because registrations pin an exact version (see README), this file is the thing a
user reads before bumping the pin. Entries describe what changes for **them** —
new or renamed tools, changed tool input/output shapes, changed defaults, changed
env var names — not internal refactors.

## [Unreleased]

### Added

- **Jira Data Center, as an unverified read-only preview.** Set
  `JIRA_DEPLOYMENT=datacenter`, `JIRA_AUTH_MODE=pat` with `JIRA_PAT` (a Data
  Center personal access token), and `JIRA_DATACENTER_PREVIEW=true`. The
  server then serves 15 read tools — `jira_get_myself`, `jira_search`, the
  issue, comment, transition and worklog reads, projects, fields, statuses,
  link types, boards, sprints and sprint issues; `jira_capabilities` lists
  them and names the rest as unavailable. A context path such as
  `https://jira.example.com/jira` is kept. Users come back as `name`/`key`,
  rich text as wiki markup. **It has never been run against a Data Center
  instance** — which is why it needs the preview flag, and why
  `jira-mcp-ai doctor` (which probes a Data Center site with your PAT) is the
  first thing to run. **Nothing changes for a Cloud setup** unless you set
  `JIRA_PAT` or `JIRA_DATACENTER_PREVIEW` there, which are reported as
  ignored.

- **OAuth 2.0 (3LO) as an alternative to the API token.** Set
  `JIRA_AUTH_MODE=oauth`, register a 3LO app in the Atlassian developer console,
  and run `jira-mcp-ai login`; the server then authenticates with a rotating
  access token through `https://api.atlassian.com/ex/jira/{cloudId}` instead of
  sending your email and API token to the site host. `jira-mcp-ai logout`
  removes the stored grant locally — it does **not** revoke it, and the command's
  `--help` says so, because Atlassian documents no revocation endpoint.

  Basic auth is unchanged and remains the default. If you set no `JIRA_OAUTH_*`
  variable, nothing about your setup moves: the egress allowlist, the request
  host and the credential path are byte-for-byte what they were.

  Two things to know before switching. Each operator registers their own 3LO
  app, because Atlassian authenticates the client on every token call and
  publishes no public-client mode — the client secret is required, and PKCE
  supplements it rather than replacing it. And the scope list is fixed at first
  consent: widening `JIRA_OAUTH_SCOPES` later forces everyone to log in again,
  which is why the default set is slightly wider than the tools strictly need.

- Nine environment variables, all optional and all inert in `basic` mode:
  `JIRA_AUTH_MODE`, `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`,
  `JIRA_OAUTH_SCOPES`, `JIRA_OAUTH_CLOUD_ID`, `JIRA_OAUTH_TOKEN_FILE`,
  `JIRA_OAUTH_REDIRECT_PORT`, `JIRA_OAUTH_AUTH_ORIGIN`,
  `JIRA_OAUTH_GATEWAY_ORIGIN`. CONFIGURATION.md documents each.

- `jira-mcp-ai doctor` gained an eleventh probe, `oauth token store`, which
  reports the stored grant's site, scopes and refresh horizon and warns when the
  store is not `0600`. It makes no network call, so it runs under `--offline`,
  and it prints nothing from which a token could be reconstructed.

- **Mention resolution on the markdown write path.** The seven rich-text
  write tools — `jira_create_issue`, `jira_update_issue`,
  `jira_transition_issue`, `jira_add_comment`, `jira_update_comment`,
  `jira_add_worklog`, `jira_link_issues` — take `resolveMentions?: boolean`,
  off by default. With `format: "markdown"`, `@[Display Name]` tokens become
  real mention nodes: each distinct name is looked up through user search, and
  the call refuses before anything is written when a name matches no active
  user or more than one (the refusal lists the candidates), or when one call
  carries more than 20 distinct names. Without the flag the tokens stay literal
  text and the result carries a `mentions_skipped` hint, and
  `resolveMentions: true` without `format: "markdown"` is refused at the
  schema. The bracketed spelling is deliberately not what reads render
  (`@Name`), so text round-tripped through a read never re-resolves by
  accident.

- **Loopback Streamable HTTP transport.** `JIRA_TRANSPORT=http` serves MCP
  over HTTP on `127.0.0.1` only, never another interface, on `JIRA_HTTP_PORT`
  (default `3334`), at the single path `/mcp`. `JIRA_HTTP_TOKEN` is required:
  settings refuse `http` without it, and every request must carry it as a
  bearer. One session per `Mcp-Session-Id`, created on `initialize`, closed on
  `DELETE` or after 30 minutes without a request (a client holding the SSE
  stream open is connected, not idle); tearing a session down discards its
  armed plans. `stdio` stays the default and is unchanged.

- **Three more irreversible deletes** in the `issues-delete` package, behind
  the same ceremony as the existing three — `JIRA_ALLOW_IRREVERSIBLE`, the
  plan/apply gate, a `before` snapshot that carries the issue counts Jira will
  rewrite:
  - `jira_delete_component` — `componentId`, optional `moveIssuesTo` (another
    component every affected issue is reassigned to; absent simply removes the
    component from them). Needs Administer Projects.
  - `jira_delete_version` — `versionId`, optional `moveFixIssuesTo` and
    `moveAffectedIssuesTo`. Goes through `removeAndSwap`, never the deprecated
    bare `DELETE`; an absent swap target **clears** that occurrence from every
    issue rather than failing the call. Needs Administer Projects.
  - `jira_delete_sprint` — `sprintId`; open issues in the sprint move to the
    backlog. Needs the board's manage-sprints permission.

- **Bulk delete and bulk edit**, also in `issues-delete`, plus a queue read:
  - `jira_bulk_delete_issues` — `issues` (1–1000 ids or keys), `notifyUsers?`.
    Subtasks of selected parents are deleted too and count against the cap.
  - `jira_bulk_edit_issues` — `issues` (1–1000), `notifyUsers?`, and at least
    one of four edit families: `labels` + `labelsAction`, `priorityId`,
    `assigneeAccountId` (`null` clears), `fixVersionIds` + `fixVersionsAction`;
    actions are `ADD`, `REMOVE`, `REPLACE`, `REMOVE_ALL`.
  - Both are asynchronous: Jira answers with a `taskId` that means _enqueued_,
    not done. `jira_get_bulk_status` (`taskId`) reads the queue — status,
    progress and the counts — and lives in the `issues` package rather than
    `issues-delete` because it is a safe read: it survives
    `JIRA_PACKAGES_DENY=issues-delete` and works for any bulk task the account
    may see, UI-submitted ones included.
  - The two bulk writes need the site-wide "Make bulk changes" permission on
    top of the per-project Browse and Delete/Edit issues.

### Changed

- The `issues-delete` package is now titled "Deletes and bulk changes
  (irreversible)". Its id is unchanged, so `JIRA_PACKAGES_DENY=issues-delete`
  still removes the whole irreversible surface — now eight tools rather than
  three.

58 tools in the same 10 packages, up from 52: six added, none removed or
renamed, and every existing input and output as it was. `resolveMentions` is a
new optional argument on seven tools and is off unless you set it.

**Not yet proven against a real tenant.** OAuth, the HTTP transport, mention
resolution, the three deletes and the three bulk tools are verified offline
only — the fake-Jira fixture and the unit suite, not a live site. For OAuth in
particular the loopback redirect URI is an assumption: Atlassian documents no
normative rule about registering one, so whether
`http://127.0.0.1:8250/callback` is accepted by the developer console is
untested. The deletes and the bulk writes additionally need permissions
(Administer Projects, manage sprints, Make bulk changes) that the account
behind the last live run did not have. Treat all of the above as unreleased
until a version note says otherwise.

## [0.9.4] — 2026-08-18

The first release with live evidence behind it. Every entry below comes from
running against a real Atlassian tenant. No fixture could have produced any of
them: one depends on the size of the site, one on a board type no fake was told
to have, and one on a status code Atlassian's own documentation does not lead
you to expect.

Nothing in the tool surface changed — same 52 tools, same 10 packages, same
inputs and outputs. What changed is that three of them stop giving wrong advice
when a real Jira site refuses them. Moving the pin from `0.9.0` is safe in both
directions; it is worth doing if you run `doctor` on a large site, or if you
have ever been told to regenerate a token that was fine.

(0.9.1 through 0.9.3 do not exist. The number was picked by the owner, not by
the diff — nothing was published under those versions and nothing ever will be,
since npm does not let a version be reused.)

### Fixed

- `jira-mcp-ai doctor` no longer reports `[FAIL] search` on a large site. Its
  search probe sent a JQL that restricted nothing (`order by created desc`),
  which Jira refuses with HTTP 400 "Unbounded JQL queries are not allowed here"
  once a site is past a size Atlassian does not publish. The probe now carries a
  lower bound that predates Jira, so it still matches every issue the token can
  see. Only the doctor's own probe changed — a JQL you pass to `jira_search` is
  sent exactly as written, then and now (D88).
- The sprint tools (`jira_list_sprints`, `jira_get_sprint_issues` and the sprint
  writes) now answer `unsupported` instead of `validation` when the board is
  kanban or team-managed, and say to pick a board of type `scrum`. Jira reports
  that case as HTTP 400 "The board does not support sprints", which read as
  "your arguments were wrong" — so a caller would keep retrying a call that
  cannot succeed on that board however it is phrased (D89).
- `jira_list_project_roles` (with or without `roleId`) no longer tells you to
  regenerate your API token when the account simply is not a project
  administrator. Jira refuses that read with HTTP 401 "You cannot edit the
  configuration of this project", which read as an authentication failure — so
  the advice was to replace a credential that was working perfectly. The result
  is now `permission` and names the "Administer projects" permission instead. A
  real credentials failure on the same route is unchanged: still `auth`, still
  telling you to check `JIRA_EMAIL` / `JIRA_API_TOKEN` (D90).

## [0.9.0] — 2026-08-17

The first release. Everything below is "added" relative to nothing, so this
entry is the whole surface rather than a diff — later entries will be diffs
against it.

It is `0.9.0` and not `1.0.0` deliberately. The surface is complete and the
gate is green, but this build has never been run against a real Atlassian
tenant — every test in it answers a fake. A pre-1.0 number is the honest way to
say so, and it keeps the semver promise unspent until a live run has been made:
under 1.0.0 the same discovery would have to arrive as a breaking major.

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
- Distribution manifests: `server.json` for the MCP registry, `.claude-plugin/`
  for Claude Code, and a release workflow that publishes with provenance — over
  GitHub OIDC once a trusted publisher can be registered, which for a package's
  own first version is not yet possible.
- Repository furniture: build, lint, format, coverage and CI configuration; the
  `npm run check` gate; the docs consistency linter (`scripts/docs-lint.mjs`)
  and the tarball-content assertion (`scripts/check-tarball.mjs`).

### Notes

- Jira Cloud REST v3 only, so issue and comment bodies are ADF. Users are
  addressed by `accountId`; there is no name or email lookup shortcut.
- Search runs on `/rest/api/3/search/jql` with `nextPageToken` paging. The
  legacy `/rest/api/3/search` endpoint was removed by Atlassian on 2025-08-01
  and is not called.
