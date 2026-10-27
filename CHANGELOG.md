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

- `JIRA_PROJECTS` (D400): a comma-separated list of project keys that scopes
  every tool. Searches are narrowed to those projects, anything addressed by
  key or id outside them is refused with a `permission` error (before a write
  plan is made), and project and board lists are filtered. Attachments by id
  are refused while a scope is set. Unset keeps today's behaviour.
- `jira_create_filter` and `jira_update_filter` (D147) in the `search`
  package: save JQL as a new private filter, and change a filter's name, JQL
  or description. Sharing is never sent or changed; the update plan shows a
  before/after diff.
- `jira_parse_jql` (D146) in the `search` package: check up to 20 JQL
  queries against Jira's strict parser without running them; each comes back
  with `valid`, `errors` and `warnings`.
- `jira_delete_remote_link` (D145) in the `issues-delete` package: remove one
  remote link from an issue by its id. Irreversible: the plan names the link's
  title and target before anything is deleted.
- `jira_delete_attachment` (D144) in the `issues-delete` package: delete one
  attachment by id. Irreversible: the plan names the file, its size and its
  author before anything is deleted. Needs no `JIRA_MEDIA_DIR`.
- `jira_unlink_issues` (D143) in the `issues-delete` package: remove a link
  between two issues by its id. Irreversible: the plan names the link type
  and both issues before anything is deleted.
- `jira_update_worklog` (D142) in the `issues-write` package: correct a
  worklog entry's duration, start or comment. Only the fields you name are
  sent, and the entry's visibility restriction is kept.
- `jira_get_remote_links` (D141) in the `issues` package and
  `jira_add_remote_link` in `issues-write`: read the web links on an issue,
  and attach one — a pull request, a Confluence page. A `globalId` makes the
  add repeatable: a link with the same `globalId` is replaced, not duplicated.
  Only absolute `http`/`https` URLs are accepted.
- `jira_get_timetracking_config` (D140) in the `meta` package: whether time
  tracking is on, the working day and week, and what "1d" and "1w" are in
  seconds. Needs no admin permission; served from the metadata cache.
- `jira_list_labels` (D139) in the `meta` package: the labels already in use
  on the site, with an optional case-insensitive substring filter. Never
  cached.
- `jira_list_priorities`, `jira_list_resolutions` and `jira_list_issue_types`
  (D138) in the `meta` package: the site's priority, resolution and issue type
  catalogues, served from the metadata cache.
- `jira_set_estimate` (D137) in the `agile` package: sets an issue's estimate
  in whichever field its board estimates with, so no custom field id is
  needed.
- `jira_rank_issues` (D136) in the `agile` package: ranks up to 50 issues
  directly before or after another, and names the issues Jira refused when it
  ranks only some of them.
- `jira_update_sprint` (D135) in the `agile` package: edits a sprint's name,
  goal or dates through the partial update, leaving the state to the
  lifecycle tools.
- `jira_get_backlog` (D134) in the `agile` package: one page of a board's
  backlog in rank order, rows shaped like `jira_search`, with `fields`, `jql`
  and `startAt` as on `jira_get_sprint_issues`.
- `jira_get_board_config` (D133) in the `agile` package: a board's filter id,
  columns with the status ids each one holds, column constraint, estimation
  field (the story-point field on most Scrum boards) and rank field.
- Prompts (D125): the server advertises `prompts` and serves four read-only
  workflows on `prompts/list` — `jira_sprint_review` (optional `board`,
  `sprint`), `jira_standup` (optional `project`, `since`),
  `jira_triage_unassigned` (optional `project`) and `jira_release_notes`
  (required `version`, optional `project`). A prompt is listed only when
  every tool it uses is registered; the `initialize` instructions name the
  listed prompts.
- Package `portfolio` (D126), in the `all` profile: `jira_portfolio_analyze`
  compares several projects or boards in one sweep and returns the epic/story
  hierarchy per project, likely duplicate and overlapping open work across
  boards, reuse candidates (open work resembling finished work elsewhere),
  cross-project blockers and shared component/label hotspots, each finding with
  the summary terms it rests on. `jira_portfolio_report` writes the same
  analysis as a Markdown report with Mermaid diagrams and tables into the new
  `JIRA_REPORT_DIR` setting and returns the file path. Neither changes Jira.
- Reference resources (D124): the server advertises `resources` and serves
  `jira://reference/tools` (every tool by package, whether this configuration
  registered it, and the documents below), `jira://reference/tools/{name}`
  (one tool's full schema, annotations, tier and an example call),
  `jira://reference/write-mode` (the plan/apply contract),
  `jira://reference/jql` (JQL idioms) and `jira://reference/markdown` (the
  markdown subset the write tools accept). An unknown URI is the protocol's
  resource-not-found error, not a tool envelope.
- `initialize` returns server `instructions`: the product, the tool count, the
  live write mode and irreversible flag, the profile-lock line, the reference
  URIs, paging and the untrusted-content rule. The server used to send none.
- Every tool carries an example call, checked against its own schema at import
  time and served by the per-tool reference resource.
- A session cache for the metadata catalogues (D123): a repeat `jira_list_fields`,
  `jira_list_link_types`, `jira_list_statuses` or `jira_get_create_meta` within
  `JIRA_META_CACHE_TTL_S` seconds (default `300`) is answered from memory instead
  of a round trip. Per profile, in-process only, never a failed fetch; transitions,
  projects, identity and permissions are never cached. `JIRA_META_CACHE_TTL_S=0`
  switches it off. `jira_capabilities` reports the TTL under
  `limits.metaCacheTtlS`.
- `jira_get_my_permissions` (package `core`, read-only, D122): checks whether the
  configured account holds the named permission keys globally, in a project or on
  one issue — "what may I do here?" before a write, instead of a 403 on apply.
  `issue` wins over `project`; a key Jira did not answer is listed under
  `unanswered`, never reported as denied. 59 tools, 29 reads. Served on Data
  Center too. Not yet proven live (Gate C claim C44 waits for the next run).

### Changed

- `tools/list` is smaller (D124): schemas no longer carry `$schema` or the
  `±(2^53 − 1)` bounds the converter put on every integer, the `apply`,
  `plan_id` and `profile` descriptions are one line each, the `format` and
  `resolveMentions` arguments point at `jira://reference/markdown` instead of
  repeating it, and 19 tool descriptions were rewritten. No argument, default
  or result shape changed. Measured over the full surface: 107,073 → 93,722
  characters.

### Fixed

- `jira_create_component`, `jira_create_version` and `jira_create_sprint`
  report a 2xx answer whose echo cannot be read (no body, not an object, no
  id or name) as `ambiguous_write`: the record was most likely created, the
  request was not retried, and the remediation says to check the matching
  list tool before creating it again. It used to be `unexpected_shape` — for
  components and versions with "Re-run the call", which sends a second
  create (CC-1220, CC-1221).
- A credential holding a lone UTF-16 surrogate no longer breaks redaction: it
  used to make every later credential registration fail, so a refresh token
  stored after it reached the logs unmasked (CC-1300).
- Redaction never throws on a value it cannot read (an array index getter, a
  throwing or revoked proxy); that part becomes `[UNREADABLE]` and the rest of
  the log line is kept (CC-1301).

## [1.0.0] — 2026-10-19

The first stable release, cut by owner decision (D121) from the same code as
`1.0.0-beta.1`. From this version the tool surface follows semver. 40 of the
58 tools are proven against a live tenant; the other 18 are verified offline
only (see the implementation plan, R03–R05).

### Changed

- **The license is now GPL-3.0-only** (was MIT). Using the server is
  unaffected; distributing a modified copy now requires releasing it under the
  GPL as well. Versions up to and including 1.0.0-beta.1 were published under
  MIT and remain available under it.

## [1.0.0-beta.1] — 2026-10-19

### Added

- **Jira Data Center, as an unverified preview.** Set
  `JIRA_DEPLOYMENT=datacenter`, `JIRA_AUTH_MODE=pat` with `JIRA_PAT` (a Data
  Center personal access token), and `JIRA_DATACENTER_PREVIEW=true`. The
  server then serves 47 of the 58 tools — 27 reads and 20 writes;
  `jira_capabilities` lists them and names the rest as unavailable. A
  context path such as `https://jira.example.com/jira` is kept.
  - Reads: everything but the bulk-task status — search and count,
    the issue, comment, transition, changelog and worklog reads, projects,
    fields, statuses, link types, user search, project roles, watchers,
    components, versions, boards, sprints and sprint issues, the saved
    filters (the list is scoped to your favourites), the create metadata (Data
    Center 8.4 or later), and the attachment list and download.
  - Writes, behind the usual `JIRA_WRITE_MODE` gate: issue create, update and
    transition, comment add and edit, worklog add, issue link; assign,
    watchers and votes; component and version create and update; sprint
    create and start, and the moves to a sprint or the backlog. The sprint
    close, every delete, the bulk tools and the attachment upload are not
    served.
  - Users come back as `name`/`key`, and the user writes take `username` in
    place of `accountId`. Rich text is flattened from wiki markup to text on
    read (`raw: true` returns the markup) and rendered to wiki markup on
    write; `resolveMentions` writes `[~username]`.

  **It has never been run against a Data Center
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
- `@modelcontextprotocol/sdk` resolves to 1.32.1 (was 1.30.0), which clears
  the SDK's OAuth-client advisory GHSA-6qxp-vccf-f47h and pulls patched
  `proxy-addr`, `ip-address` and `fast-uri` transitively. This server
  uses none of the affected code paths (its HTTP transport is bare `node:http`,
  its OAuth client its own), but `npm audit --omit=dev` is now clean.
- The `zod` floor is now 4.6.5 (was 4.4.3); tool schemas and their published
  JSON Schema are unchanged.

### Fixed

- The HTTP transport reads a POST body that starts with a UTF-8 byte order
  mark, as the SDK did before the transport took over the body read, instead
  of answering a parse error (CC-1060).
- The HTTP transport no longer counts a session twice against its cap of 32
  while that session is still answering its initialize, which refused a
  32nd session early with a 503 (CC-1061).
- `jira_capabilities` names the site requests actually go to — the active
  profile's site when it sets one, normalised, with a Data Center context
  path — instead of the raw `JIRA_SITE`, which named another site, or none,
  under `JIRA_ACTIVE_PROFILE`.
- `jira_list_filters`, `jira_list_projects`, `jira_list_fields`,
  `jira_list_components` and `jira_list_versions` refuse a whitespace-only
  `query`, `filterName` or `accountId` instead of silently listing everything
  and echoing the blank value as if it had narrowed the result.
- `resolveMentions`: a name whose only exact match is an inactive account or
  an app is refused instead of resolving to a different person whose name
  merely starts the same way.
- An OAuth token or resources response over the response size limit is
  refused instead of being read as an empty success; a token refresh then
  says to run `jira-mcp-ai login` again rather than failing as an unexpected
  shape.
- Data Center preview: `jira_download_attachment` no longer saves a login or
  proxy page as the attachment — a body whose size differs from the stated
  one, or an HTML page for a non-HTML file, is refused and nothing is written.
- Data Center preview: inline code that spells a macro name (`` `quote` ``,
  `` `code` ``…) is written so it cannot open a wiki tag, the reader keeps
  `{{quote}}` as text, and long named entities (`&rightarrow;`) are escaped
  like short ones.
- `jira_bulk_edit_issues` drops repeated `labels` and `fixVersionIds` before
  planning, so the plan shows the values apply sends.
- The redactor's shape pass now masks prefixed credential parameters
  (`auth_token=`, `x-api-token=`, `api_key=`, `id_token=`) and ones in a URL
  fragment (`#access_token=`), which it used to pass through.
- An `Authorization: Negotiate …` or `Authorization: Token …` echo is now
  masked; only Basic, Bearer and Digest were recognised before.
- A configured secret is now redacted when it appears percent-encoded with
  lowercase hex or form-encoded, not only in the uppercase-hex spelling.
- HTTP transport: a `JIRA_HTTP_TOKEN` with non-ASCII characters now
  authenticates; every request carrying it was refused with 401.
- A malformed OAuth origin setting no longer echoes a password in its error
  when the value is written without `//` (`https:user:pw@host`).
- `jira-mcp-ai login` and `logout` refuse a malformed setting with the same
  report the server prints, instead of running on its default (a mistyped
  `JIRA_OAUTH_REDIRECT_PORT` listened on the default port).
- Markdown: a paragraph or code block after a nested list inside a numbered
  item stays in the numbered item when the markdown is read back; it used to
  move into the nested list.
- The `truncated` hint on a cut `jira_search` page no longer points at a
  `startAt` the tool does not take; it says to repeat the call with a smaller
  `maxResults`.
- Markdown: two adjacent code spans no longer read back as one span with a
  stray pair of backticks in the middle.
- Markdown: a link whose address ends in a backslash no longer reads back as
  plain text.
- Markdown: a list item that starts with a code block no longer reads back
  as literal backticks.
- `JIRA_TOKEN_EXPIRES` refuses a date that is not on the calendar instead of
  rolling it over into the next month.
- A write cancelled by the caller after Jira answered 2xx now says it was
  applied and must not be sent again.
- A write cancelled before it reached Jira (already cancelled, queued, or
  waiting out a 429) now says it was not applied.
- Data Center: inline code reading `info`, `note`, `tip` or `warning` no
  longer opens a panel macro.
- Data Center: text after a closing `{code}`/`{noformat}` tag on the same
  line is kept instead of dropped.
- Data Center: a stray or escaped `[` in a table cell no longer merges the
  cells after it.
- A downloaded attachment whose Jira filename holds a lone surrogate reports
  the name actually written to disk, and `renamed: true`.
- A long downloaded filename no longer truncates to a Windows device name
  such as `nul`.
- `JIRA_MEDIA_DIR=/` (or a drive root) no longer refuses every file as
  outside the media directory.
- An upload with a blank `contentType` sends `application/octet-stream`
  instead of an empty part header.
- The permissive env-file warning prints the file mode in full (`0004`, not
  `04`).
- An upload whose file changed between plan and apply is refused instead of
  uploading content the plan never showed.
- An oversized search result with a single issue trims that issue's comments or
  worklogs instead of shortening every string or dropping `data`.
- `jira_transition_issue` refuses a transition name that several transitions
  share, listing each one's target status, instead of picking the first.
- `jira_update_comment` without `visibility` keeps a role- or group-restricted
  comment restricted. Jira reads an edit that omits visibility as public, so a
  body-only edit used to publish the comment; the stored restriction is now
  resent, an edit that cannot restate it is refused, and `visibility: null`
  still lifts it on purpose.
- `jira_upload_attachment` refuses a hard link in `JIRA_MEDIA_DIR` — its
  bytes may live outside the directory, so a hard-linked private key used to
  upload like any other file. Copy the file in instead. The checks and the
  read now share one descriptor opened without following symlinks.
- `jira_upload_attachment` refuses a `contentType` that is not a printable
  ASCII `type/subtype` mime type; one with a non-ASCII character used to be
  shown in the plan and then sent as `application/octet-stream`.
- `JIRA_ALLOWED_HOSTS`: a regex entry with a top-level alternation is
  anchored as a whole on every request, as it already was at startup; the
  attachment host check used to admit hosts such as
  `jira.a.com.attacker.net`. A comma inside a `/…/` regex entry no longer
  splits it in two.
- A write that Jira answers 2xx with a body that is not JSON is reported as
  an ambiguous write — it may have landed, it was not retried, read the issue
  back before resending — instead of an unexpected shape.
- `jira_bulk_delete_issues` and `jira_bulk_edit_issues` report a 2xx submit
  without a usable `taskId` as an ambiguous write and say not to resend; they
  used to say "Re-run the call", which would enqueue a second irreversible
  operation over the same issues.
- Retries honour the longest wait of a repeated `Retry-After` header (`5, 5`)
  instead of reading the list as a date and retrying at once.
- An OAuth token lifetime above 24 hours is capped at 24 hours, so a
  nonsensical `expires_in` no longer keeps a dead access token in use until the
  next `login`, or leaves a token store the next read refuses as damaged.
- With the profile lock off, a call naming a profile that sets no site of its
  own goes to `JIRA_SITE`, as AUTH.md says; it used to go to the active
  profile's site, signing one profile's credentials to another tenant.
- `JIRA_SITE` with a mistyped scheme is refused instead of being completed to
  a different Cloud site, and one the URL parser would read as an IPv4 address
  (`12345`, `10.1`) is refused as malformed, naming what you wrote, instead of
  failing the allowlist on an address you never typed.
- `jira-mcp-ai login`: on Windows the browser is opened without `cmd`, which
  cut the authorize URL at the first `&`; `--json` prints the authorize URL
  even when a browser was reported launched, so a headless machine is not left
  waiting; and a scope list the authorize URL cannot carry is refused as
  configuration with a `--json` report instead of a bare crash.
- The `.env` save and the OAuth token store finish a short write on a nearly
  full disk instead of renaming a truncated file over the original.
- `jira_add_worklog`: a `started` time without an offset near a daylight
  saving change takes the offset of its own side of the change; it was logged
  an hour off.
- `jira_search` and `jira_count` refuse a whitespace-only `jql`,
  `jira_get_sprint_issues` a whitespace-only `jql`, and `jira_list_boards` a
  blank `projectKeyOrId` (a padded one is trimmed), instead of reading
  everything in scope. A whitespace-only `jira_search` page token is refused
  instead of restarting at page 1.
- `jira_get_issue` refuses a blank entry in `fields`, `expand` or
  `properties`.
- `jira_update_issue` refuses a label that is both added and removed in one
  call.
- The `issue` argument is trimmed at the schema, so write results echo the key
  actually written to.
- `jira_list_boards` with a project filter reports an unknown or hidden
  project as such, not as "Jira Software is not available".
- Data Center preview: `jira_list_components` and `jira_list_versions` honour
  `startAt` and `maxResults` instead of returning the whole list every time.
- `doctor` no longer prints a green token-expiry countdown for a
  `JIRA_TOKEN_EXPIRES` the loader refuses (`2027-02-30`, `01/02/2027`); only
  the failure is shown.
- `doctor --save` with the expiry left blank removes the previous
  `JIRA_TOKEN_EXPIRES` instead of keeping it beside the new token, where the
  next check warned that the token just created had already expired.
- `doctor --save` refuses, before writing, a site, email or token that the
  environment already sets to something else. The env file never overrides a
  variable that is already set, so "Saved." printed over credentials the next
  start ignored.
- `doctor`'s env-file line names only the `JIRA_ENV_FILE` path when that file
  is missing, and says no other location is tried, instead of also listing the
  fallbacks the loader never read.
- The `enqueued` hint on `jira_bulk_delete_issues` and `jira_bulk_edit_issues`
  names every status that ends a bulk task (COMPLETE, FAILED, CANCELLED, DEAD)
  and says to check `failedCount`, so a client polling to its letter no longer
  waits forever on a cancelled or dead task.
- `jira_add_worklog` with a `started` in the years 0000–0099 renders it in the
  user's zone instead of failing with a "utcOffsetMinutes … ±14 hours" error
  about an argument the caller never passed.
- A `JIRA_SITE` whose site name is longer than 63 characters is refused at
  startup as malformed. It used to pass startup and `doctor`, then fail every
  call with "not a Jira Cloud site".
- An exact `JIRA_ALLOWED_HOSTS` entry, `JIRA_OAUTH_AUTH_ORIGIN` or
  `JIRA_OAUTH_GATEWAY_ORIGIN` written with a trailing dot
  (`jira.example.com.`) is accepted. In oauth mode such an origin used to block
  startup with an error about a `JIRA_ALLOWED_HOSTS` entry you never wrote.
- A long Jira error message or proxy error page that is cut short no longer
  splits an emoji in half, which left text that strict JSON decoders refuse.
- Applying a `plan_id` that expired because more than 64 newer plans were made
  first is refused with a message that says so. It used to claim the plan came
  from an earlier process or was already used.
- A profile named after an `Object.prototype` member, such as `constructor`,
  is refused as unknown. `JIRA_ACTIVE_PROFILE=constructor` used to pass, and a
  call naming that profile was signed with the default credentials.
- A profile named `__proto__` is kept, and its API token is redacted from logs
  and errors. The profile used to vanish and its token was never registered
  with the redactor.
- A temp file left by a run killed mid-write no longer blocks later writes of
  the env file or the OAuth token store. Every later run's first write used to
  fail until the leftover was deleted by hand, so a rotated refresh token was
  never saved.
- `JIRA_ACTIVE_PROFILE` with `JIRA_AUTH_MODE=pat` is refused at startup. The
  server used to report itself healthy and then fail every call.
- A `JIRA_TOKEN_EXPIRES` date-time without a zone (`2027-01-31T12:00`) is read
  as UTC, like a bare date, instead of in the host's local time, which moved
  the expiry warning by up to a day from one machine to the next.
- A closed stderr or stdout pipe no longer crashes the server with an uncaught
  `EPIPE`. A lost stderr drops diagnostics silently; a lost stdout shuts the
  server down cleanly with a `fatal` shutdown event.
- Under `JIRA_WRITE_MODE=plan` a write's `plan` hint no longer tells the model
  to re-invoke with `apply: true`, which could only plan again; it says an
  operator has to restart the server with `JIRA_WRITE_MODE=apply` and the
  tool then has to be planned afresh.
- An apply that names the plan's `profile` in a different case or with
  surrounding spaces (`"EU"` against `"eu"`) is no longer refused as drifted;
  it targets the same site, and the plan fingerprint now spells the profile
  the way credentials resolve it.
- `jira_search_users` refuses a whitespace-only `issue` or `project` instead
  of silently widening the lookup to every user matching the name, and echoes
  the trimmed `query`.
- `jira_get_project` and `jira_get_create_meta` echo the trimmed `project` and
  `issueTypeId` rather than the padded input.
- When a large result is truncated, strings are cut at a character boundary,
  so an emoji can no longer leave a lone surrogate that strict clients refuse
  to decode.
- Credentials in tool results, plan previews and logs are masked in three more
  shapes: a value under a credential or header key (`password`, `x-api-key`,
  `Authorization`), URL userinfo whose password contains `@` or that is a bare
  token, and a credential parameter percent-encoded inside another URL
  parameter.
- `login --cloud-id` that contradicts `JIRA_OAUTH_CLOUD_ID` is refused before
  the browser opens. It used to store a grant that the server then refused on
  every call.
- `login --timeout` is capped at about 24 days, the longest wait the clock can
  honour. A longer value used to end early while still reporting the requested
  wait.

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
