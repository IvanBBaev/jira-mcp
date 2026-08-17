# Jira Cloud API notes

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns the **wire constants**: endpoints,
> pagination models, retry numbers. Other docs point here instead of restating
> them.

Everything in this file is a hard constraint discovered from Atlassian docs,
changelogs and community reports as of 2026-08. The HTTP client and api/ layer
must encode these rules.

## Base URLs and versions

- Platform REST API v3: `https://<site>.atlassian.net/rest/api/3/...`
  (v3 = ADF bodies; v2 returns wiki-markup strings — we use **v3 only**).
- Agile API: `https://<site>.atlassian.net/rest/agile/1.0/...` (boards, sprints,
  backlog). Separate root, same auth, classic pagination.
- Auth (v1): HTTP Basic — `Authorization: Basic base64(email:apiToken)`.
  API tokens are created at https://id.atlassian.com/manage-profile/security/api-tokens.

## Hosts

- Site host canonical suffix: `.atlassian.net`. Anything else — Server/DC,
  vanity domains — requires explicit `JIRA_ALLOWED_HOSTS` opt-in (SSRF guard,
  see THREAT-MODEL.md §SSRF / egress).
- Matching is exact host or anchored regex. Suffix matching (`endsWith`) is
  banned: `evil-atlassian.net` ends with the donor's check string.
- This is the wire rule; the env var that carries the opt-in is
  CONFIGURATION.md's.

## Search: the 2025 migration (critical)

Atlassian **removed** the legacy search endpoints (`GET/POST /rest/api/3/search`,
`/rest/api/2/search`, and related pickers) on **2025-08-01**. The replacement is:

- `GET/POST /rest/api/3/search/jql`
  - pagination is **token-based**: request `maxResults` (endpoint cap 5000; our
    tool default is 25, tool cap 100 — see TOOLS.md) and pass back the returned
    `nextPageToken`; `startAt` does not exist;
  - there is **no `total`** in the response; use
    `POST /rest/api/3/search/approximate-count` (body: `{ jql }`) for counts;
  - `fields` defaults to a minimal set (essentially `id`) — the client MUST send
    an explicit `fields` list (our default:
    `summary,status,assignee,priority,issuetype,updated`);
  - `expand` is a comma string; `reconcileIssues` accepts up to 50 issue IDs for
    read-after-write consistency (use after create/update in the same session);
  - the endpoint is **eventually consistent** — a just-created issue may not
    appear in search immediately (hence `reconcileIssues` and tool hints).
- `nextPageToken` semantics (community-verified, panel-corrected):
  - tokens are **one-time-use** and are **invalidated if the JQL or `fields`
    change** between pages; expiry is roughly 7 days but community reports show
    occasional immediate expiry — treat every token as ephemeral;
  - never persist tokens across tool calls beyond a single paginate loop;
  - an invalid/expired token returns **HTTP 400** (NOT 410 — 410 is what the
    *removed legacy* endpoints return) with a message like "The provided next
    page token is invalid or expired". Disambiguate from a JQL-syntax 400 by
    that message substring; on token-400 restart the search from page one with
    a loop guard and surface hint `pagination_restarted`.

## Two pagination models

| Model | Where | Client helper |
|---|---|---|
| `nextPageToken` | `/search/jql` only | `searchPages()` — loop with token, `maxPages` guard, `truncated` flag |
| `startAt` / `maxResults` / `total` / `isLast` | almost everything else (comments, worklogs, project search, filter search, users, agile) | `fetchPage()` / `fetchAll()` with `DEFAULT_MAX_PAGES` and loop guard |

Never follow server-provided absolute `next` URLs; always rebuild requests from
path + params (host allowlist stays authoritative).

## ADF (Atlassian Document Format)

In v3, rich-text fields (`description`, `environment`, comment/worklog bodies)
are ADF JSON trees, not strings.

- **Read**: `adfToText(node)` flattens to plain text — handles `text`,
  `hardBreak`, `mention` (renders `@displayName`), `inlineCard`/`blockCard`
  (renders URL), recurses unknown node types instead of throwing. Ported from
  servicenow-mcp with existing tests. **Mandatory deltas over the donor** (each
  a named test): `mention` without `text` falls back to the accountId (CC-07);
  `emoji` renders its shortName, `status` its text, `date` its ISO value —
  the donor drops all three silently; `bulletList`/`orderedList` flatten with
  two-space indentation per level and a depth cap (CC-09); `table` renders
  row-per-line with `|`-joined cells; `codeBlock` keeps its content and names
  the language; `panel` prefixes its type; `mediaSingle`/`media` render a
  `[media: filename]` placeholder (no attachment fetching in v1);
  `taskList`/`taskItem` render `[x]`/`[ ]`.
- **Write (v1)**: `adfFromText(text)` — paragraphs split on blank lines,
  `hardBreak` for single newlines. Version pinned: `{ version: 1, type: "doc" }`.
  Since v1.5, write tools also accept `format: "markdown"`, which parses the
  string via `adfFromMarkdown` instead (D44; subset below).
- **Markdown subset (both directions, WP-60)**: `adfToMarkdown(node)` and
  `adfFromMarkdown(text)` in `api/adf.ts`. The subset is exactly: ATX headings
  (level clamped into 1..6), nested `bulletList`/`orderedList` (`start`
  honoured, `-` and `1.` markers, two spaces per level), fenced `codeBlock`
  with a language, inline `code`, `strong`, `em`, `link`. Marks nest in the
  fixed order code → em → strong → link. Anything outside the subset degrades
  EXACTLY as `adfToText` renders it — same string, same placeholders, same
  `MAX_NODE_DEPTH` / `MAX_LIST_INDENT_DEPTH` caps — and neither direction ever
  throws. The parser is hand-rolled and line-based: **no markdown dependency**
  (supply chain), and unrecognised constructs become paragraph text.
  `adfFromMarkdown` matches `adfFromText` byte-for-byte on markup-free input
  (CRLF normalisation, blank-line paragraph split, leading/trailing blank
  trimming — CC-10). Two rules that are not optional if the round trip is to
  hold: a fence's info string may contain no backtick (the language is
  sanitised and the fence widens past the longest backtick run in the body),
  and a code span binds tighter than a link or emphasis, so the inline parser
  steps over code spans when looking for a closing delimiter. The round trip is
  lossless only up to a normal form (marks sorted, adjacent same-mark text runs
  merged) and only over the subset; the losses are enumerated in CORNER-CASES.
- **Mentions are one-way by design**: `adfToMarkdown` renders `@displayName`
  (accountId fallback, CC-07), and `adfFromMarkdown` never produces a `mention`
  node. Creating one needs an accountId lookup, and the converters are pure and
  network-free (D38); a literal mention syntax would also let round-tripped
  untrusted text synthesise a mention of an arbitrary account.

## Custom fields

Every non-system field is `customfield_10xxx` and instance-specific. Consequences:

- `jira_list_fields` (GET `/rest/api/3/field`) is a first-class discovery tool —
  returns id, name, schema type, custom flag.
- `jira_get_create_meta` uses the **new** per-project endpoints
  (`GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` and
  `.../issuetypes/{issueTypeId}`) — the old all-projects `createmeta` was
  deprecated for performance.
- `jira_create_issue` / `jira_update_issue` accept a passthrough `fields` object
  for custom fields; the tool description tells the model to discover ids first.

## Users (GDPR mode)

Cloud identifies users **only by `accountId`** — no usernames, no user keys.
- Assignee/reporter payloads: `{ "assignee": { "accountId": "..." } }`.
- `jira_search_users` (GET `/rest/api/3/user/search?query=`) resolves display
  name/email → accountId. Email may be masked depending on privacy settings —
  masking is server-side; the `includeEmail` input is pure tool-ring shaping
  (there is no Jira parameter for it).
- Assignable variants (the `issue?`/`project?` inputs of `jira_search_users`,
  O-5): GET `/rest/api/3/user/assignable/search?query=` with `issueKey=` or
  `project=`. Exactly one scope is sent; when both are supplied, `issueKey`
  wins (server precedence is undocumented, so the choice is fixed client-side).
- `GET /rest/api/3/myself` verifies credentials and returns the caller identity —
  the doctor probe and `jira_get_myself` use it.

## Transitions

Status cannot be set via update. Flow: `GET /rest/api/3/issue/{key}/transitions`
→ pick transition id → `POST` with `{ transition: { id }, fields?, update? }`.
Transition screens may require fields (e.g. resolution) — pass through and
surface Jira's validation errors verbatim.

## Saved filters

- Search: `GET /rest/api/3/filter/search` — classic `startAt`/`maxResults`
  pagination (PageBean with `isLast`). It returns almost nothing without an
  `expand`; the server asks for exactly `description,owner,jql`. Filter matching
  uses `filterName` (case-insensitive substring) and `accountId` (owner);
  Cloud has no usernames, so an owner is only ever addressed by accountId.
- One filter: `GET /rest/api/3/filter/{id}` — no expand is sent; the route
  returns `description`, `owner`, `jql` and `favourite` by default, and its only
  expand options are share-scope internals.
- **Never surfaced:** `sharePermissions`, `editPermissions`, `subscriptions`,
  `sharedUsers`. Both routes return them (the single-filter route always) and
  they are a roster of accountIds, groups and project roles no tool asked for.
  `api/filters.ts` maps to an allowlist of six fields by construction rather
  than deleting keys, so a field Jira adds later cannot leak by default.
- Filter ids are positive integers; they arrive as **numbers** in search rows
  and as **strings** on `/filter/{id}`, so the client normalises to string.
- A filter that does not exist and one the caller may not see are both a 404.
- Filters are never executed server-side by this MCP: `/filter/{id}/results`
  and the `jql` shortcut are not used — the stored JQL goes through the search
  endpoint like any other query.

## Attachments

| Route | Used for | Pinned facts |
|---|---|---|
| `GET /rest/api/3/issue/{issueIdOrKey}?fields=attachment` | the listing | One call per issue. The array lives at `fields.attachment`; a project with attachments disabled simply has no such field — not an error. |
| `GET /rest/api/3/attachment/{id}` | one record | "Returns the metadata for an attachment. Note that the attachment itself is not returned." Fields: `id, self, filename, author, created, size, mimeType, content, thumbnail`. `404` also means "attachments are disabled in the Jira settings", not only "not found". |
| `GET /rest/api/3/attachment/content/{id}` | the bytes | Query `redirect`, **default `true`**: with the default Jira answers **303** ("See the `Location` header for the download URL") pointing at a signed, short-lived URL on an Atlassian media host. With `redirect=false` it answers **200** with the content (and **206** for a `Range` request). Other documented statuses: 400 (malformed `Range`), 401, 403, 404, 416. This client always sends `redirect=false`, so on this client the 303 hop is a **fallback, not the normal path** — a live run that never exercises it is the expected outcome, not a gap in coverage. It keeps `redirect: 'manual'` on every fetch and follows at most ONE hop — https only, SSRF blocklist applied, no credentials, media URL never logged (D46). |
| `POST /rest/api/3/issue/{issueIdOrKey}/attachments` | the upload | `multipart/form-data` (RFC 1867). Two non-negotiable details, both from the docs: "The request must have a `X-Atlassian-Token: no-check` header, if not it is blocked" and "The name of the multipart/form-data parameter that contains the attachments must be `file`". The response is an ARRAY of the created attachment records. Documented statuses: 200, 403, 404, **413** ("the attachments exceed the maximum attachment size for issues" or "more than 60 files are requested to be uploaded") — 413 maps to `kind=validation`. Never set `content-type` by hand: only `fetch` knows the boundary it generated. |

Size: this server caps ONE transfer at `MAX_ATTACHMENT_BYTES` (50 MiB,
`core/http-util.ts`) in both directions, enforced during the transfer, no
environment override. Jira Cloud's own default per-file limit is 10 MB and is
site-configurable, so the tenant limit — a 413 — can still be the binding one.

Retries: a download is a plain GET and follows §Rate limiting and retries
unchanged. An upload is an unsafe write: an ambiguous failure surfaces as
`ambiguous_write` and is NEVER replayed automatically — a replay is how an
issue gets two copies of the same file.

Timeouts: `JIRA_REQUEST_TIMEOUT_MS` bounds one ATTEMPT **including body
consumption**, and the two legs of the 303 media hop share that single
attempt timeout — a redirect followed is still one attempt. The per-host
semaphore slot is likewise held until the body settles, so a long transfer
keeps counting against the concurrency cap for its whole duration.

## Issue links, worklogs, changelog

- Links: `POST /rest/api/3/issueLink` with `{ type: { name }, inwardIssue,
  outwardIssue }`; link type names via `GET /rest/api/3/issueLinkType`.
- Worklogs: `POST /rest/api/3/issue/{key}/worklog` — `timeSpentSeconds` (prefer)
  or `timeSpent` string; `started` is ISO-8601 with milliseconds and offset
  (`2026-08-07T10:00:00.000+0000`) — a formatting helper is mandatory (Jira
  rejects `Z`-suffix timestamps here). The offset itself is **not** the host's:
  it comes from the authenticated user's Jira timezone (`GET /rest/api/3/myself`
  → `timeZone`, fetched once and cached per process), falling back to the host
  TZ if that call fails (D16). The source is injectable, so tests pin an offset
  without touching the host clock.
- Changelog: `GET /rest/api/3/issue/{key}/changelog` (classic pagination).
- Comment edit: `PUT /rest/api/3/issue/{key}/comment/{id}` with `{ body: <ADF>,
  visibility? }`. The body is a **whole-document replacement** — Jira has no
  partial comment edit — and the response echoes the stored comment (same shape
  as the `POST`), so no re-read is needed. The comment id is a path segment and
  is validated as a positive integer before the request. A comment that does not
  exist, one on another issue and one the caller may not edit are all a 404.

### Deletes (D45)

Verified against the Cloud reference on 2026-08-13:
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/`
and
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/`

- `DELETE /rest/api/3/issue/{issueIdOrKey}` — query `deleteSubtasks` (string
  `"true"`/`"false"`, **default `false`**). Atlassian: "An issue cannot be
  deleted if it has one or more subtasks. To delete an issue with subtasks, set
  `deleteSubtasks`." So the 400 on an issue with subtasks is a documented
  server behaviour, not a validation quirk — we send the parameter explicitly on
  every call rather than relying on the default, and we never flip it silently.
  Deleting an issue also destroys its comments, worklogs and attachments; there
  is no trash and no undo.
- `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{id}` — no query parameters
  we send. Not recorded in the issue changelog.
- `DELETE /rest/api/3/issue/{issueIdOrKey}/worklog/{id}` — query
  `notifyUsers`, `adjustEstimate`, `newEstimate`, `increaseBy`,
  `overrideEditableFlag`. `adjustEstimate` **defaults to `auto`**, which gives
  the deleted time back to the remaining estimate. We send none of them: `auto`
  is the behaviour a human expects from "undo this log", and the alternatives
  (`new`/`manual`) turn a delete into a silent estimate rewrite. If that ever
  becomes configurable it must be an explicit tool input, shown in the plan.

All three answer **`204 No Content`** on success. All three are unsafe, so the
retry rules in §"Rate limiting and retries" apply unchanged: they are never
replayed on an ambiguous failure — a replayed delete cannot be distinguished
from a 404 that means "already gone".

## Agile writes (sprints and the backlog)

Verified against the Cloud reference on 2026-08-13:
`https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/`
and `https://developer.atlassian.com/cloud/jira/software/rest/api-group-backlog/`.

- **Partial vs full sprint update.** `POST /rest/agile/1.0/sprint/{sprintId}`
  is "partially update sprint" and is the ONLY shape this server sends.
  `PUT /rest/agile/1.0/sprint/{sprintId}` is a full update whose documented
  behaviour is "any fields not present in the request JSON will be set to
  null" — starting a sprint with it erases the sprint's name and goal.
- **Sprint dates are ISO-8601 with a UTC offset**, e.g.
  `2026-01-31T09:00:00.000+02:00` (the reference's own example body uses
  `2015-04-11T15:22:00.000+10:00`). The format is
  `YYYY-MM-DDTHH:mm:ss.sss±HH:mm`; the value is forwarded VERBATIM — the
  worklog `started` rule (D16/CC-23) belongs to a different endpoint and does
  not apply here.
- **Lifecycle preconditions.** A sprint is created in state `future`
  (`POST /rest/agile/1.0/sprint`, requires `name` + `originBoardId`, answers
  201 with the created sprint). `state: "active"` requires a `future` sprint
  plus `startDate` and `endDate`; a board refuses a second active sprint
  unless parallel sprints are enabled. `state: "closed"` requires an `active`
  sprint, stamps `completeDate`, and moves every not-done issue out of the
  sprint per board configuration. A closed sprint cannot be reopened or
  updated through this API.
- **Backlog move.** `POST /rest/agile/1.0/backlog/issue`, body
  `{ "issues": ["ABC-1", ...] }`, answers 204 with no body. Jira defines it as
  "removing the future and active sprints from a given set of issues", so it
  takes no board id. The sibling `POST /rest/agile/1.0/backlog/{boardId}/issue`
  differs only by accepting ranking arguments and is not used.
- **The 50-issue cap is Jira's own**, identical on the sprint move and the
  backlog move, and it is enforced client-side (D22): an over-cap batch is
  refused with nothing sent, rather than half-applied upstream.

## Watchers, votes, components, versions and roles

Reference groups consulted 2026-08-13:
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-watchers/`,
`.../api-group-issue-votes/`, `.../api-group-project-components/`,
`.../api-group-project-versions/`, `.../api-group-project-roles/`.

- **Watchers.** `GET /rest/api/3/issue/{issueIdOrKey}/watchers` is NOT
  paginated — it returns `{ isWatching, watchCount, watchers[] }` whole. It
  needs "View voters and watchers" on top of "Browse projects", and a caller
  without it gets a **200 with `watchers` absent and the count present**: an
  empty list and a withheld list are the same bytes unless the client tracks
  which happened (CC-47).
- **Watcher writes.** `POST /rest/api/3/issue/{key}/watchers` takes the
  accountId as a **bare JSON string body** (`"5b10a2…"`), not an object — the
  request builder passes the raw string and `core/http.ts` `JSON.stringify`s it,
  which is what puts the quotes on the wire. `DELETE` on the same path takes
  `?accountId=…` as a **query parameter and no body**: a DELETE body is what
  intermediaries drop silently and Jira does not read one here. Both answer
  **204 with no body**, so the tools synthesise their result from the input.
  Acting on another account needs "Manage watchers"; acting on your own does not.
- **Votes.** `POST|DELETE /rest/api/3/issue/{key}/votes` take **no body, no
  query and no accountId** — the vote is always the authenticated account's.
  There is no API for voting on someone else's behalf. Jira refuses a vote on an
  issue the caller reported and on a resolved issue, with a message worth keeping
  (`jiraMessages`). Both answer 204.
- **Components.** The paginated route is the **singular** one:
  `GET /rest/api/3/project/{projectIdOrKey}/component` (classic
  `startAt`/`maxResults` PageBean with `isLast`), optional `query` matched
  against name and description. `/project/{key}/components` returns every
  component in one unbounded array and is not used. Writes are
  `POST /rest/api/3/component` — project by **KEY, in the body**, the URL
  carries no project — and `PUT /rest/api/3/component/{id}`, which is a
  **partial** update: fields left out keep their stored value. `description` is
  a **plain string, not ADF**; there is no `format` field on these endpoints and
  an ADF document would be stored as literal JSON text. A component cannot be
  moved between projects.
- **Versions.** Same singular/plural split:
  `GET /rest/api/3/project/{projectIdOrKey}/version` is the paginated route,
  `/versions` the unbounded one. Filters: `query` (name + description) and
  `status` as a comma-joined subset of `released,unreleased,archived`. Writes
  are `POST /rest/api/3/version` — project by **numeric `projectId` in the
  body**, NOT a key, the asymmetry with components is Jira's — and
  `PUT /rest/api/3/version/{id}`, again partial. `startDate` and `releaseDate`
  are **calendar dates, `YYYY-MM-DD`**, with no time of day and no timezone;
  they are sent and returned verbatim. `released` and `archived` are booleans
  that flip in both directions, so cutting a release is reversible.
  `overdue` is Jira's own computed verdict and is read-only.
- **Project roles.** `GET /rest/api/3/project/{projectIdOrKey}/role` answers
  with a **map of role name → role URL** and no membership whatsoever; the role
  id exists only as the last segment of that URL
  (`{"Administrators": "https://site/rest/api/3/project/ABC/role/10002"}`), so
  the client parses it out and returns `[{id, name}]` sorted by name.
  `GET /rest/api/3/project/{projectIdOrKey}/role/{id}` is the only route with
  actors on it; a group actor carries no accountId and is reported as a group
  rather than as an identity. Both need "Administer projects".
- **Permissions are the dominant failure mode of this whole surface.** A 403
  here says nothing actionable on its own, so the api ring appends the missing
  permission by name to `remediation` — the CC-34 pattern — while leaving the
  Jira messages verbatim.

## Rate limiting and retries

- Jira Cloud rate limits per user/app; on breach returns `429` with
  `Retry-After` seconds header.
- Policy (canonical — matches donor semantics in `core/http-util.ts`, imported
  by `core/jira/http.ts`; corrected by the 2026-08-07 panel):
  - `429`: retried for ALL methods, honouring `Retry-After` capped at **60 s**
    (cap-and-retry, matching donor `MAX_RETRY_AFTER_MS`), plus **+0–20 %
    jitter** from the injected RNG — synchronized agents must not stampede the
    same tenant when the window reopens;
  - `502/503/504` + transport errors: retried only for **GET** requests
    (`isIdempotent` in the donor is deliberately GET-only — Jira PUTs can carry
    non-idempotent `update` add/remove clauses, so PUT is NOT replayed), plus
    requests explicitly marked `safe: true` per-request. The `safe` flag exists
    because `POST /search/jql` and `POST /search/approximate-count` are pure
    reads that deserve retries despite the POST verb;
  - unsafe writes are never replayed on 5xx/transport failure — an ambiguous
    write surfaces a `JiraError` with `kind: "ambiguous_write"` telling the
    model to verify state before retrying;
  - backoff `min(500·2^n, 8000) + jitter` (jitter from an injected RNG for test
    determinism), attempts capped (default 3);
  - per-host concurrency semaphore (default 4);
  - the whole tool call runs under a wall-clock budget `JIRA_CALL_BUDGET_MS`
    (default 120 s) — retry waits and semaphore queueing count against it; on
    breach the call aborts with `kind=budget_exceeded` instead of queueing
    retries forever (contract: OBSERVABILITY.md §Call budget).

## Error response shapes

Jira is inconsistent; the extractor must read, in order:
1. `errorMessages: string[]` (global errors),
2. `errors: { fieldId: message }` (field validation — join as `field: message`),
3. `message` (some agile/legacy endpoints),
4. fall back to HTTP status text.

Permission quirk: Jira returns **404 for issues you cannot see** (not 403).
Error remediation text must mention both possibilities ("not found or no
permission").

## Misc constraints

- `Accept: application/json` on all calls; write bodies `Content-Type:
  application/json`.
- `X-AACCOUNTID` response header can confirm acting identity in doctor.
- JQL strings are passed through verbatim — the server never builds JQL from
  fragments (injection surface belongs to the model, quoting rules documented in
  the tool description).
- Host rules (canonical suffix, allowlist matching) have their own section
  above — §Hosts.
