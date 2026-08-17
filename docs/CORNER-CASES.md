# Corner cases

> Status: normative and implemented — this document and the code ship together;
> drift is a bug.

Enumerated behaviours the implementation must get right. Each becomes at least
one test. IDs (`CC-01`…`CC-75`) are **stable**: test names reference them, so
they are never renumbered — new cases append, dead cases are struck through
with a note, and gaps stay gaps.

## Search

- **CC-01** `nextPageToken` expired/invalid mid-loop → Jira returns **400**
  with message substring "next page token is invalid or expired" (NOT 410;
  disambiguate from JQL-syntax 400 by the substring) → restart from page one,
  single retry, loop guard; surface hint `pagination_restarted`.
  Caller-supplied expired token (not mid-loop) → fail fast with remediation,
  no silent restart.
- **CC-02** Search is eventually consistent → after create/update,
  `jira_search` results may lag. The server keeps a session registry of the
  numeric issue ids its APPLIED writes touched (last 50, insertion-ordered,
  `mcp/recent-writes.ts`) and passes them as `reconcileIssues` when the caller
  supplies none; caller-supplied ids always win. The `eventual_consistency`
  hint on an empty result right after a write stays caller-triggered (D27/D32).
- **CC-03** Empty `fields` from caller → inject default field set, never send
  none.
- **CC-04** `maxResults` > cap → clamp to 100, note in result.
- **CC-05** JQL syntax error → Jira 400 with `errorMessages` → verbatim
  passthrough + remediation "check quoting; strings with spaces need double
  quotes".

## ADF

- **CC-06** Unknown node types (new Atlassian nodes) → recurse children, never
  throw.
- **CC-07** `mention` without displayName attr → render accountId.
- **CC-08** Empty doc / null description → empty string, not "undefined".
- **CC-09** Deeply nested lists → flatten with indentation, depth cap (guard
  against pathological trees).
- **CC-10** Text → ADF: CRLF input normalized; single \n = hardBreak, blank
  line = new paragraph; leading/trailing blank paragraphs trimmed.

## HTTP / retry

- **CC-11** 429 on POST → retried (429 is retried for ALL methods),
  Retry-After honoured, capped at 60 s.
- **CC-12** 503 on an unsafe POST (a write) → NOT retried; `JiraError
  kind=ambiguous_write` with "verify before retrying" remediation. 503 on a
  `safe: true` POST (`/search/jql`, `/approximate-count`) → retried.
- **CC-13** Timeout after request sent: GET or `safe: true` → retried; unsafe
  write → ambiguous_write. PUT is NOT retried (GET-only idempotence — see
  JIRA-API.md).
- **CC-14** Retry-After absurdly high (e.g. 3600) → capped at 60 s and the
  retry proceeds after the capped wait (cap-and-retry, donor semantics); the
  real server value is logged.
- **CC-15** Non-JSON error body (HTML from proxy) → status-based error, body
  snippet (bounded, redacted) in detail. This snippet is the sole exception to
  the never-log list (OBSERVABILITY.md).

## Permissions / identity

- **CC-16** 404 on an existing issue → error text says "not found OR no
  permission".
- **CC-17** 401 → remediation mentions token expiry (Cloud tokens expire
  ≤ 1 year).
- **CC-18** 403 with `X-Failed-Login-Count` style responses → treated as auth,
  not generic.
- **CC-19** GDPR-masked email in user search → return accountId + displayName,
  note email hidden; never fail.

## Writes

- **CC-20** `plan` mode: write tool returns the exact method/path/body it
  WOULD send (redacted), plus a `plan` hint; nothing hits the network.
- **CC-21** Transition id stale (workflow changed between get_transitions and
  transition) → Jira 400 → remediation "re-fetch transitions".
- **CC-22** Assign with `unassign: true` AND `accountId` set → input
  validation error (strict schema, zod refinement).
- **CC-23** Worklog `started` without offset → formatter adds the offset of the
  authenticated user's Jira timezone (`/myself`, cached per process; host TZ as
  fallback — D16); `Z` suffix never sent. The offset source is injected, so the
  test pins it (e.g. `+05:30`) while the host runs UTC.
- **CC-24** Create with unknown custom field id → Jira 400
  `errors{customfield_x}` → field-level message passthrough + hint to call
  `jira_list_fields`.

## Envelope / truncation

- **CC-25** Result over budget → drop whole issues/comments from the tail, set
  `_truncation {dropped, of}`; JSON always parseable; `ok` and `hints` always
  survive.
- **CC-26** Single item alone over budget (huge description) → truncate that
  field with ellipsis marker, note in `_truncation`.

## Config

- **CC-27** `JIRA_SITE` given as full URL with path → path stripped, warning
  in report.
- **CC-28** Site host not `.atlassian.net` and not allowlisted → startup error
  naming `JIRA_ALLOWED_HOSTS`.
- **CC-29** `JIRA_TOOL_PACKAGES=reader` + `JIRA_PACKAGES_DENY=core` → core
  force-re-added (capabilities/doctor must always exist).
- **CC-30** http transport without `JIRA_HTTP_TOKEN` → refuse to start (fail
  closed).

## Appended after the 2026-08-07 panels

- **CC-31** `jira_update_issue` with `description` (text or raw ADF) replaces
  the whole rich-text field — tables/panels in the previous value are lost.
  The tool description states it; incremental label edits use
  `labelsAdd`/`labelsRemove` instead of `labels` (TOOLS.md).
- **CC-32** `apply: true` with a missing, stale or mismatched `plan_id` →
  `JiraError kind=write_gated`, nothing sent; remediation says re-plan.
- **CC-33** Journal write fails (disk full, path unwritable) after a successful
  write → tool still returns `ok: true` + hint `journal_unavailable` +
  `journal_write_failed` event. A journal failure never fails a tool.
- **CC-34** Agile root returns 403/404 (Agile API not enabled or not
  permitted) → `kind=unsupported` naming the Agile permission, not a generic
  `not_found` that reads like "board doesn't exist". Owner: `api/agile.ts`
  (`asAgileError`) — the only layer that can tell a root probe from an
  id-bearing route. Root probe (`/board` list): 403/404 → `unsupported`.
  Id-bearing route (`/board/{id}`, `/sprint/{id}`): the kind is KEPT (the id
  really may be wrong) and the remediation additionally names the
  licence/permission possibility. `core/http.ts` stays root-agnostic.
- **CC-35** A content-bearing read that is also truncated keeps both markers:
  the injection warning and `_untrusted: true` survive alongside `ok`/`hints`
  while items are dropped from the body. Rendering un-branded content through
  the taint renderer throws (donor semantics) — silent unwrapping is a bug,
  not a fallback.
- **CC-36** A sprint lifecycle call is refused because the state moved on
  (400: already active, already completed, a second active sprint on a board
  without parallel sprints) → the error KEEPS Jira's own words
  (`jiraMessages`, `detail`, `httpStatus`, `kind`, `cause`) and only the
  remediation is replaced, with a state-specific one that names
  `jira_list_sprints` and says whether a retry can ever succeed (for a closed
  sprint it cannot). Owner: `api/agile.ts` (`staleSprintState`). 400 ONLY —
  403/404 stay CC-34's business and 5xx propagates untouched. This is an
  error rewrite rather than a hint because the hint vocabulary is closed and
  no code means "the sprint moved on".
- **CC-37** A sprint state change succeeds but the echoed body cannot be read
  (proxy stripped it, upstream shape change) → the tool still returns
  `ok: true` with `{ sprintId, state, status }` and simply omits `sprint`.
  The write has already been applied, so reporting `unexpected_shape` here
  would tell the caller a started sprint was not started. The create path is
  the opposite by design: a created sprint whose `id` cannot be read IS
  `unexpected_shape`, because no caller can use the result.
- **CC-38** A saved filter read (`jira_list_filters`, `jira_get_filter`) must
  never surface `sharePermissions`, `editPermissions`, `subscriptions` or
  `sharedUsers` — Jira returns them unasked, and they are a roster of
  accountIds, groups and project roles. `api/filters.ts` maps to an allowlist
  of six fields by construction (build, never spread), so a new Jira field
  cannot leak by default; the test asserts both the exact key set and the
  absence of the forbidden substrings in the rendered result.
- **CC-39** `jira_update_comment` replaces the WHOLE comment body — Jira has no
  partial comment edit — so a model that "adds a line" by sending one sentence
  destroys the rest of the comment. Same hazard as CC-31, one level down: the
  tool description says so, the annotation is `destructiveHint: true`, and the
  request body carries `body` (+`visibility` when given) and nothing else.
- **CC-40** A saved filter's `jql` is tenant-user-authored text that the model
  is expected to execute. The filter tools are therefore content-bearing
  (`_untrusted: true` + `untrusted_content`) and never run the filter
  themselves: the JQL reaches the search endpoint only through a separate,
  deliberate `jira_search` call.
- **CC-41** `adfToMarkdown` must degrade OUTSIDE its subset exactly as
  `adfToText` does — tables, panels, media, task lists, cards, emoji, status,
  date, unknown containers and unknown leaves produce the identical string, and
  the `MAX_NODE_DEPTH` / `MAX_LIST_INDENT_DEPTH` caps and `DEPTH_LIMIT_MARKER`
  behave identically (CC-06/07/08/09 parity). A markdown renderer that is
  merely "richer" is not acceptable: two renderers that disagree about the same
  node are two behaviours a caller must learn. Neither converter ever throws —
  `null`, a cycle and a 200-deep tree all terminate.
- **CC-42** Text that LOOKS like markup must survive `adfToMarkdown` →
  `adfFromMarkdown` unchanged: `\`, `` ` ``, `*`, `[`, `]` are escaped inline,
  and a paragraph opening with `- `, `1. `, `# `, `>` or a fence has its leading
  marker escaped. Otherwise an issue description containing "1. do this"
  silently becomes an ordered list on the next write.
- **CC-43** `adfFromMarkdown` never emits a `mention` node, and a markdown link
  whose scheme is not `http(s):` or `mailto:` renders as plain text with the
  href dropped. Mentions need an accountId lookup that a pure converter cannot
  do (D38); an unrestricted href would let Jira-authored content carry a
  `javascript:`/`data:` URL into whatever renders the markdown.
- **CC-44** The markdown round trip is lossless only up to a normal form and
  only over the subset. Enumerated losses, each a test: an empty paragraph
  disappears; `rule` returns as a `---` paragraph; a mention returns as literal
  text; tables/panels/media/task lists/cards return as their text rendering; an
  unsafe-scheme link keeps its text and loses its href; mark order and adjacent
  same-mark text runs are normalised (markdown cannot spell the difference —
  `**a****b**` is one bold run).
- **CC-45** `format` on a read tool is a RENDERING choice, never a shape change
  and never a second request: the same bytes go to Jira with and without it,
  the field set / paging facts / user projection are identical, `format` is
  never forwarded as a query parameter, and the D15 taint envelope
  (`_untrusted`, the `untrusted_content` hint, the `TAINT_BEGIN`/`TAINT_END`
  fence) is unchanged — markdown is Jira-authored text like any other and
  travels inside the fence. Omitting `format` is byte-identical to the
  pre-`format` output; `raw: true` + `format` is refused (CC-45 pairs with the
  §Read shaping rule).
- **CC-46** `format` on a write tool interprets the STRING form of a rich-text
  input only. `format: "markdown"` parses via `adfFromMarkdown` in the tool
  ring, so plan mode shows the exact ADF an apply would send (CC-20). A raw ADF
  document needs no interpreting, so `format` alongside one is refused — the
  write-side twin of CC-45's `raw` × `format`. `format` with `description:
  null` is allowed (null still clears the field, CC-31); `format` with no
  rich-text input at all is a no-op; omitting `format` is byte-identical to the
  v1 `adfFromText` behaviour.

## Appended with the D45 graduation (2026-08-13)

- **CC-47** `jira_list_watchers` on an issue whose watcher list the caller may
  not see → Jira answers **200** with `watchCount` present and the `watchers`
  array ABSENT. That must never be reported as "nobody is watching": the result
  carries `watchersVisible: false` and a plain-language `note` saying the list
  was withheld by the "View voters and watchers" permission. An empty list with
  `watchersVisible: true` is the genuinely-nobody case and carries no note.
- **CC-48** A `DELETE` in the `collab` package destroys nothing.
  `jira_remove_watcher` and `jira_remove_vote` are reversible links restored
  exactly by their `add` twin, so both are standard tier with
  `destructiveHint: false` (D50). The rule is about what a call can lose, not
  about its HTTP verb — and the counter-example is in the same wave:
  `jira_delete_comment` is a `DELETE` that belongs to the irreversible tier.
- **CC-49** `jira_update_component` / `jira_update_version` are PARTIAL updates
  — the exact opposite of `jira_update_issue` (CC-31) and `jira_update_comment`
  (CC-39). Omitting a field keeps its stored value; it does not clear it.
  Clearing a description is `description: ""`, explicitly. A call that names no
  field to change is refused locally with nothing sent (D22) rather than
  dispatched as `PUT {}`.
- **CC-50** The project reference is asymmetric: `jira_create_component` takes
  the project **KEY** in its body, `jira_create_version` takes the **numeric
  projectId**. Passing a key where an id is wanted is a 400 whose message does
  not explain itself. The asymmetry is Jira's; it is passed through and
  documented rather than hidden behind a lookup that would add a request and a
  permission surface to every create (D52).
- **CC-51** Component and version `description` is **plain text, not ADF**, and
  neither endpoint has a `format` field — D44's write-side `format` argument
  deliberately does NOT appear on the four `collab` writes. Sending an ADF
  document here stores its JSON as literal text that a human then reads in the
  project settings screen. Version dates are calendar dates (`YYYY-MM-DD`) with
  no time of day: a timestamp is rejected locally rather than truncated against
  a timezone nobody chose.
- **CC-52** `GET /project/{key}/role` returns a name → URL map with no
  membership in it and no id field; the id is the last segment of the URL. The
  client flattens it to `[{id, name}]` sorted by name — unsorted output would
  inherit JSON key order and change between two calls against the same project.
  This is also why the role list and the role drill-down are one tool: neither
  call is useful without the other (D55).
- **CC-53** `?redirect=false` is what this client sends, but a 3xx is still
  handled: exactly ONE hop, only for a binary GET, only to an `https` host that
  is not private/link-local, carrying NO `Authorization`, no XSRF header and no
  cookies. The hop runs inside the attempt (it holds the semaphore slot, races
  the attempt timeout, spends no retry) and emits its own `http_response` event;
  the signed media URL is a bearer credential and is never logged. A second
  redirect, a missing/unparseable `Location`, a non-https target or a blocked
  host is `kind=config`, `retryable: false`. A JSON GET is never redirected —
  for it a 3xx stays the refusal it always was.
- **CC-54** The 50 MiB cap is enforced DURING the transfer, not after it: the
  download reader is cancelled at the byte that crosses the line (nothing
  buffers the whole oversized body first), and the upload is measured — file
  `stat` in the tool ring, summed part sizes in the client — before any `Blob`
  exists. Both breaches are `kind=validation`, `retryable: false`, the same
  kind an HTTP 413 maps to.
- **CC-55** A Jira filename is untrusted tenant text and never reaches a path
  unsanitized: separators of both families, `..`, control characters, `NUL`,
  Windows-forbidden characters and trailing dots/spaces are stripped; the
  Windows device names (`CON`, `nul.txt`) get an `_` prefix; the name is
  truncated to 120 characters keeping a short extension; an empty result
  becomes `attachment`. `../../etc/passwd` therefore lands at
  `<JIRA_MEDIA_DIR>/passwd`, and the untouched original is still reported as
  `filename` inside the taint envelope.
- **CC-56** A download NEVER overwrites: the file is opened `wx`, a collision
  uniquifies (`report.pdf` → `report-1.pdf`, up to 100 attempts, then
  `validation`), and the result carries `renamed: true` whenever the name on
  disk differs from Jira's. Downloading the same attachment twice leaves two
  files — which is why the tool is annotated `idempotentHint: false` (D47).
- **CC-57** `jira_upload_attachment` REFUSES a `name` that is not a plain
  basename instead of sanitizing it (D48) — `../secret`, `/etc/passwd`,
  `sub/dir/f`, backslash variants: `kind=validation`, no file opened, no
  request sent. Sanitizing would upload a different file than the one asked
  for; accepting a path would make the tool a file-exfiltration primitive. The
  store re-resolves and re-checks the prefix as an independent second lock, and
  a non-regular file (directory, device) is refused too.
- **CC-58** Without `JIRA_MEDIA_DIR` the two byte-moving tools answer
  `kind=config` naming the setting, having made ZERO Jira calls, while
  `jira_list_attachments` keeps working — metadata needs no directory. A
  directory that does not exist, or is not writable, is diagnosed at call time
  (`config`), not at startup: an operator typo must not stop the server.
- **CC-59** An upload that fails ambiguously (timeout, transport error
  mid-flight) is reported as `ambiguous_write` and is never retried
  automatically; the remediation names `jira_list_attachments` as the way to
  find out whether the file landed. A download, being a GET, retries normally.
- **CC-60** An apply refused by the irreversible tier does NOT consume the
  caller's `plan_id`. The config check sits after the plan branch and before
  plan-store consumption, so `JIRA_ALLOW_IRREVERSIBLE` being off is a property
  of the server, not a mistake by the caller: the operator flips the variable,
  restarts, and the plan the model was shown is still the plan. Every other
  refusal (unknown / mismatched / missing plan_id) still consumes, as D14
  requires.
- **CC-61** A delete PLAN is always allowed, on every server, including one
  that will never permit the apply. The plan is how a model finds out what a
  delete would cost; refusing to plan would push it towards guessing. When the
  opt-in is off the `plan` hint states that apply is disabled and names the
  variable — the warning rides inside the existing `plan` hint because
  `HINT_CODES` is a closed vocabulary.
- **CC-62** The before-state is captured by the HANDLER, not by the gate: each
  delete tool reads its target through `ctx.jira` (a GET, so plan mode lets it
  through) and calls `noteBeforeState` before issuing the delete. In apply mode
  the slot is unregistered and the same call is a silent no-op — one code path,
  no plan branch in any tool. Two notes in one call: the first wins, so a
  handler cannot overwrite the snapshot its plan already promised.
- **CC-63** `deleteSubtasks` is visible only in the before-state.
  `PlannedRequest` is `{method, path, body?}` and a DELETE has no body, so
  without the flag inside the snapshot the plan for "delete PROJ-1" and for
  "delete PROJ-1 and its 14 subtasks" would render identically.
- **CC-64** A delete result is `_untrusted` even though it is a write. Writes
  normally echo what the caller sent; a before-state is tenant-authored text
  (summary, comment body, display names) read out of a live project. Free text
  in a snapshot is excerpted at 500 characters with an explicit truncation flag
  and subtask keys at 20 with a count — a plan is a summary, not an export.
- **CC-65** An apply echoes the same snapshot the plan showed, because Jira
  answers 204 with no body and the journal line carries only an `argsHash`. It
  is the same expression in both modes, not a second code path.
- **CC-66** A thin issue still yields a valid snapshot: Jira omits
  `status`/`issuetype` from a projection the caller has no permission for, and
  a `subtasks` array can carry rows without a `key`. The snapshot drops the
  keys it cannot fill rather than inventing empty strings, and non-object
  subtask rows are skipped.

## Appended with the Wave-8 hardening (2026-08-14)

- **CC-67** `jira_get_issue` with `format: "markdown"` on a deeply nested
  document: rendering is a single shaping walk, so `format` selects the
  renderer without changing which values are visited or how deep the walk
  goes. Markdown and text hit `MAX_SHAPE_DEPTH` at the same node; below the
  cap the two renderings differ only inside the rich-text fields themselves.

## Appended with the Wave-9 adversarial pass (2026-08-15)

- **CC-68** A tool result or a planned body nested deeper than the redactor's
  cap used to come back with a subtree replaced by `[MAX_DEPTH]` — a
  `raw: true` ADF description lost its marks, and a planned comment lost the
  `attrs` of its links, so the operator approved a body whose URLs they were
  never shown. The cap is now 128 (`core/redact.ts`), justified as stack
  safety rather than as a log-field bound (D64).
- **CC-69** A symbolic link inside `JIRA_MEDIA_DIR` pointing at a regular file
  elsewhere on the host used to be uploadable: `stat` follows links, and the
  path check only constrains the name. `createNodeMediaStore.read` now
  `lstat`s first and refuses any link whose `realpath` leaves the (also
  `realpath`-ed) root; a dangling link stays `not_found`. Downloads were never
  affected — `open(…, 'wx')` refuses to write through an existing link (D65).
- **CC-70** Jira text containing the literal closing taint delimiter used to
  close the D15 block early, so everything after it read to the model as this
  server's own output. `mcp/result.ts` now escapes the delimiter code points
  inside the fenced JSON; the escape is parse-identical, so the text channel
  still parses to exactly `structuredContent` (D66).
- **CC-71** A Jira display name shorter than four characters is deliberately
  *not* used as a free-text needle by `scripts/record-fixture.mjs` — sweeping
  every "Bob" out of an ADF body would corrupt the fixture it is trying to
  preserve. The `displayName` field itself is still replaced; only the prose
  sweep declines, and the fixture PII lint cannot see it either, because that
  lint knows email shapes, accountIds, hostnames and credential keys, not first
  names. The recorder now emits a warning naming the case, so the residue is a
  reviewed decision rather than a silent one (D70, D71).

## Appended in Wave 10 (2026-08-16)

- **CC-72** The hint-code table in TOOLS.md and the `HINT_CODES` catalog in code
  drift apart: a code is added to one and not the other, or removed from one and
  left in the other. A test parses the table out of TOOLS.md and asserts set
  equality with `HINT_CODES` in both directions — an undocumented code and a
  documented-but-dead one both fail, and a parser that matched nothing fails
  first. It cannot assert the *authoring order* TOOLS.md describes (that stays
  [honor], D77); it asserts only that the two agree once the dust settles.

- **CC-73** A fixture corpus that is empty, or nearly so, makes its own PII lint
  pass unconditionally — the walk finds no files, reports no findings, and the
  build goes green while the guard has never once executed its detector. The
  suite asserts the corpus is non-empty before asserting it is clean, and runs
  the same exported detector over 17 adversarial documents and 11 legitimate
  placeholder forms built inside the test, with a meta-test that fails if a
  `PiiRule` has no sample. Verified by planting a fixture carrying a real-shaped
  site host, `Authorization` key, accountId and email: the lint failed with all
  four rules and exact JSON paths (D75).
- **CC-74** A `JIRA_MEDIA_DIR` that is not what the config claims fails as
  `config`, never as a Jira problem and never as a missing file: a path running
  *through* a regular file reports the directory as non-existent on write and
  `failed (ENOTDIR)` on read; a directory the server cannot write to (`0o555`)
  says `is not writable by this server`; a file it cannot read (`0o000`) is
  explicitly **not** `not_found` — and nothing is sent to Jira in that case. An
  errno the store has no advice for is still named verbatim, e.g.
  `failed (ENAMETOOLONG)`, and a create that fails leaves the directory empty.
  Every one of these carries a remediation naming `JIRA_MEDIA_DIR` (D45, D49,
  D76).
- **CC-75** The server announces itself even when its own `package.json` is
  missing, truncated, a JSON scalar, or carries an empty `name` / a numeric
  `version`: the identity read falls back to `FALLBACK_SERVER_NAME` /
  `FALLBACK_VERSION` instead of throwing during import, because a server that
  throws at import is one the client never sees. The test proves it against a
  copied, map-free tree with a sentinel control case — without the sentinel the
  assertion would pass even if the read had silently succeeded, since the
  fallbacks equal the real package's own fields.
