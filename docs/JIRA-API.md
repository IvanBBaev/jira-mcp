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
- Auth, basic mode: HTTP Basic — `Authorization: Basic base64(email:apiToken)`.
  API tokens are created at https://id.atlassian.com/manage-profile/security/api-tokens.
- Auth, oauth mode: `Authorization: Bearer <access token>` **and a different
  origin** — see §OAuth 2.0 (3LO) below. The paths above are unchanged; they are
  prefixed, not replaced.
- Jira Data Center (D106–D113 — unverified preview): platform root
  `/rest/api/2` (there is no v3 on Data Center, and v2 bodies are wiki markup),
  under the instance's context path when it has one
  (`https://jira.example.com/jira/rest/api/2/...`); auth with a personal access
  token as `Authorization: Bearer <PAT>` to the site host. Route verdicts:
  §Jira Data Center below. **UNVERIFIED**: taken from Atlassian's Data Center
  documentation, never exercised against a Data Center instance (D104's
  condition).

## Hosts

- Site host canonical suffix: `.atlassian.net`. Anything else — Server/DC,
  vanity domains — requires explicit `JIRA_ALLOWED_HOSTS` opt-in (SSRF guard,
  see THREAT-MODEL.md §SSRF / egress).
- A path on the site URL is stripped on Cloud (CC-27) and kept as the context
  path under `JIRA_DEPLOYMENT=datacenter` (CC-257); a Cloud host is refused
  there (CC-258).
- Matching is exact host or anchored regex. Suffix matching (`endsWith`) is
  banned: `evil-atlassian.net` ends with the donor's check string.
- This is the wire rule; the env var that carries the opt-in is
  CONFIGURATION.md's.
- The two Atlassian OAuth hosts, `auth.atlassian.com` and `api.atlassian.com`,
  are **not** blanket-allowed. They are appended to the effective allowlist only
  in oauth mode (D97), so a basic-mode deployment keeps exactly the egress it
  has today. The auth primitive additionally refuses any URL whose origin is not
  one of those two, and follows no redirects.

## OAuth 2.0 (3LO)

The credential lifecycle — login, scopes, storage, rotation, logout — belongs to
AUTH.md. This section owns only the wire.

| Purpose | URL |
|---|---|
| Authorization (browser) | `https://auth.atlassian.com/authorize` |
| Token exchange **and** refresh (one URL) | `https://auth.atlassian.com/oauth/token` |
| Accessible resources (cloudId discovery) | `https://api.atlassian.com/oauth/token/accessible-resources` |
| API gateway | `https://api.atlassian.com/ex/jira/{cloudid}/{api}` |

Both origins are overridable (`JIRA_OAUTH_AUTH_ORIGIN`,
`JIRA_OAUTH_GATEWAY_ORIGIN` — CONFIGURATION.md) so the offline test fake is
reachable; nothing else in the shape changes.

- **The gateway is mandatory under 3LO**, not a preference. Verbatim: requests
  that use OAuth 2.0 (3LO) are made via `api.atlassian.com`, not
  `https://your-domain.atlassian.net`. A bearer token sent to the site host is
  not a supported path. Hence `HostRef` carries a `pathPrefix` of
  `/ex/jira/<cloudId>`: `…/ex/jira/<cloudId>/rest/api/3/project`. The cloudId is
  validated (letters, digits, hyphens, anchored) before any URL is built — it is
  a path segment, and an unvalidated one injects a path (CC-101).
- Gateway headers are the ordinary ones plus `Authorization: Bearer …`.
- **Authorization request parameters, all seven documented required**:
  `audience` (literally `api.atlassian.com` — easy to forget, and required),
  `client_id`, `scope` (space-separated), `redirect_uri`, `state`,
  `response_type=code`, `prompt=consent`. We add `code_challenge` and
  `code_challenge_method=S256`. Success redirects to the callback with `code` in
  the query string; no other response parameter is documented.
- **Token requests are JSON, not form-encoded.** Atlassian documents
  `Content-Type: application/json` on `/oauth/token` for both the
  authorization-code exchange and the refresh. This departs from RFC 6749, which
  mandates form encoding; the documented shape wins. (A form-encoded body is
  empirically also accepted, but that is undocumented and we do not rely on it —
  the auth primitive sends JSON only.)
- The documented 200 body is `{ "access_token", "expires_in", "scope" }`.
  `refresh_token` appears only in the refresh example and is returned in
  practice when `offline_access` was requested; parse it as optional but expect
  it. **`token_type` appears in no documented response** on these pages even
  though `Bearer` is used throughout — do not require it, do not switch on it.
  **The access-token lifetime is NOT DOCUMENTED**: read `expires_in` at runtime
  and never hardcode a number.
- **Accessible-resources takes no parameters.** Its `id` values are **not unique
  across containers** — two entries may repeat one — so it is not a primary key;
  and it "won't tell you anything about the user's permissions", so a site
  listed there is not a promise that any call will succeed. Atlassian's prose
  names `auth.atlassian.com` for this call while every code example on the same
  page uses `api.atlassian.com`; the examples are right.
- **Token-endpoint errors.** The documentation lists exactly one — `403` with
  `{"error": "invalid_grant"}`, "Unknown or invalid refresh token" — but the
  live endpoint returns a wider set: `400 invalid_request` for a bad
  authorization code, `400 invalid_client` for an unknown client or a missing
  `grant_type`, and `403 unauthorized_client` for a bad refresh token. Matching
  the single documented string would strand a caller in a retry loop against a
  dead token, so the rule is: **any 400 or 403 whose `error` is
  `invalid_grant`, `unauthorized_client` or `invalid_client` is terminal** —
  re-authorize, never retry (CC-100).
- **JQL under 3LO cannot refer to entity properties.** Atlassian: apps cannot
  declare searchable entity properties, and an app using OAuth 2.0 (3LO) "won't
  be able to refer to entity properties in JQL queries". This is a real
  restriction on the search tools in oauth mode, and it is not something the
  server can work around — a JQL string that names an entity property is passed
  through verbatim and will fail at the endpoint.

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
    that message substring; when the token that expired is one Jira issued
    mid-loop, restart the search from page one exactly once and surface hint
    `pagination_restarted`. A caller-supplied `nextPageToken` that is refused
    on the first request is a `validation` error instead — nothing to restart
    from, and the caller's cursor is what is wrong.
- **In oauth mode, JQL may not refer to entity properties** — a documented 3LO
  restriction, not a client limitation, and the one place where the same JQL
  string behaves differently between the two auth modes. See §OAuth 2.0 (3LO).

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
- **Mentions are one-way on the round trip (CC-110)**: `adfToMarkdown` renders
  `@displayName` (accountId fallback, CC-07), and that spelling never
  re-resolves. The write side's resolvable syntax is the disjoint
  `@[Display Name]`, honoured only when `format: "markdown"` AND
  `resolveMentions: true` (D100, CC-105) — the converters stay pure and
  network-free (D38): the tool ring resolves names via user search (§Users
  below) and hands `adfFromMarkdown` a map, and the converter never emits a
  `mention` node it did not get from that map (CC-108). Round-tripped
  untrusted text therefore still cannot synthesise a mention of an arbitrary
  account (D43).

## Custom fields

Every non-system field is `customfield_10xxx` and instance-specific. Consequences:

- `jira_list_fields` (GET `/rest/api/3/field`) is a first-class discovery tool —
  returns id, name, schema type, custom flag.
- `jira_get_create_meta` uses the **new** per-project endpoints
  (`GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes` and
  `.../issuetypes/{issueTypeId}`) — the old all-projects `createmeta` was
  deprecated for performance. On Data Center (D116) the same two paths exist
  from 8.4 under `/rest/api/2`, with rows in `values` beside
  `startAt`/`maxResults`/`total`/`isLast`; the legacy
  `/issue/createmeta?expand=projects.issuetypes.fields`, removed in Jira 9.0,
  is never called, not even as a fallback. UNVERIFIED against a host.
- `jira_create_issue` / `jira_update_issue` accept a passthrough `fields` object
  for custom fields; the tool description tells the model to discover ids first.
- Priorities, resolutions and issue types (D138): `GET /priority/search` and
  `GET /resolution/search` are classic PageBeans over `values`
  (`startAt`/`maxResults`, default 50); the unpaginated `GET /priority` and
  `GET /resolution` are deprecated and not used. `GET /issuetype` is a bare
  array of every type the caller can see; a team-managed project's own type
  carries `scope: {type: PROJECT, project: {id}}`, so names repeat and ids do
  not. Cloud only here — the Data Center adapter stubs all three.
- Labels (D139): `GET /label` is a classic PageBean whose `values` are plain
  strings (`startAt`/`maxResults`, default 1000) and takes no filter, so
  `jira_list_labels` filters client-side. Labels are created implicitly by
  tagging an issue, so the route is deliberately left out of the metadata
  cache. Cloud only here.
- Time tracking settings (D140): `GET /configuration` needs no permission and
  carries `timeTrackingEnabled` plus `timeTrackingConfiguration`
  (`workingHoursPerDay`, `workingDaysPerWeek`, `timeFormat`, `defaultUnit`),
  which is absent when time tracking is off. `GET /configuration/timetracking`
  (the provider) and `/configuration/timetracking/options` (the same figures)
  both demand Administer Jira and are not used. Cloud only here.
- Remote links (D141): `GET /issue/{issueIdOrKey}/remotelink` is a bare
  array, unpaged; each entry has a numeric `id`, an optional `globalId`,
  `relationship` and `application`, and an `object` with `url`, `title`,
  `summary`, `icon` and `status`. `POST` to the same route creates a link
  (201) or, when the body's `globalId` matches a link already on the issue,
  updates that link (200); both answer `{ id, self }`. Jira stores any URL
  string; the server accepts only absolute `http`/`https`. Cloud only here.
- Worklog edit (D142): `PUT /issue/{issueIdOrKey}/worklog/{id}` takes the
  worklog fields — `timeSpent` or `timeSpentSeconds`, `started` (explicit
  offset, never `Z`, as on the POST), `comment` (ADF), `visibility` — and
  answers with the updated worklog. The server sends only the fields the
  caller named, plus the stored `visibility`; that an omitted field keeps its
  stored value is what Gate C claim C54 checks. Cloud only here.
- Issue link delete (D143): `GET /issueLink/{linkId}` answers `{ id, type,
  inwardIssue, outwardIssue }`, each end with `key` and a `fields` subset
  (summary, status); `DELETE` on the same route answers 204 and removes the
  link from both issues. The id is the one on an `issuelinks` entry. Cloud
  only here.
- Attachment delete (D144): `DELETE /attachment/{id}` answers 204. It needs
  the Delete All Attachments permission, or Delete Own Attachments for the
  caller's own files. The before-state comes from `GET /attachment/{id}`, the
  same read the download uses. Cloud only here.
- Remote link delete (D145): `DELETE /issue/{issueIdOrKey}/remotelink/{linkId}`
  answers 204. The before-state comes from `GET` on the same path, which
  answers one link in the shape of a list row. Cloud only here.
- The catalogue reads (`/field`, `/issueLinkType`, `/statuses/search`, `/status`
  on Data Center, the two create-meta routes, and since D138
  `/priority/search`, `/resolution/search` and `/issuetype`, and since D140
  `/configuration`) are cached in memory for
  `JIRA_META_CACHE_TTL_S` seconds (D123). A custom field created outside the
  server shows up after the TTL or a restart; set the TTL to `0` when that
  matters. `/issue/{key}/transitions` is never cached — it depends on the
  issue's state and the caller's permissions.
- `GET /user/search` is cached by the same knob, never longer than 300 s
  (D129): a mention resolved at plan time is resolved again at apply, and
  identity calls are priced above plain reads. `/user/assignable/search` and
  `/myself` are never cached.

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
  The endpoint filters a window of `maxResults` candidates, so a short page
  is normal: the offset advances by the whole window, and only an empty
  window or the thousandth candidate ends the sweep (CC-201).
- Mention resolution (D100) uses the plain-query endpoint, deliberately NOT
  the assignable variant — mentionable ≠ assignable. `resolveMentionNames`
  issues one `GET /rest/api/3/user/search?query=` per distinct name
  (case-insensitive dedupe, refused above 20 distinct names before any search
  — CC-112), reads ONE page, filters to active non-app accounts (CC-113), and
  demands a unique winner: a single case-insensitive exact displayName match
  beats partials, anything else refuses listing up to 5 candidates (CC-107,
  CC-106). A name whose only exact matches are inactive or app accounts
  refuses rather than settling for a lone partial match (CC-429). Every accountId in an emitted `mention` node comes from that live
  response in the same call — never from input text.
- `GET /rest/api/3/myself` verifies credentials and returns the caller identity —
  the doctor probe and `jira_get_myself` use it.
- `GET /rest/api/3/mypermissions?permissions=A,B` answers `jira_get_my_permissions`
  (D122). `permissions` is required — a comma-joined list, at most 50 keys — and one
  key Jira does not know fails the whole call with 400, so the api ring refuses blank,
  comma-joined, empty or over-long key lists before the wire (CC-1400). Scope is
  optional: `issueKey`/`issueId` or `projectKey`/`projectId`, and only the most
  specific one is sent (CC-1403); an unknown scope is 404. The answer is keyed by
  permission key with `havePermission`; a key missing from it is reported as
  unanswered, never as denied (CC-1401), and keys Jira volunteers beyond the asked
  ones are dropped (CC-1402).

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

Text bodies (JSON successes, error bodies, OAuth replies) are capped too, at
`MAX_TEXT_BODY_BYTES` (equal to `MAX_ATTACHMENT_BYTES`, compiled in, no
environment override) and enforced while streaming: an over-cap success is
`validation` asking for less per request and is never buffered or parsed; an
over-cap 2xx to an unsafe write is `ambiguous_write` saying it was applied and
is not retried; an over-cap error body is dropped and the status alone decides
the kind (CC-384).

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

### Deletes (D45, D102)

Verified against the Cloud reference on 2026-08-13:
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/`
and
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/`
The three D102 endpoints verified against the Cloud reference on 2026-09-01:
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-components/`,
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-project-versions/`
and `https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/`.

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
- `DELETE /rest/api/3/component/{id}` — query `moveIssuesTo`, another
  component's id; when present Jira reassigns every affected issue to it, when
  absent the `components` entries are simply removed. Needs the project's
  Administer Projects permission. The blast radius is readable in advance:
  `GET /rest/api/3/component/{id}/relatedIssueCounts` answers `{issueCount}`,
  and the before-state carries it (CC-121).
- `POST /rest/api/3/version/{id}/removeAndSwap` — body `moveFixIssuesTo?` and
  `moveAffectedIssuesTo?`, each another version's id; an absent field means
  that occurrence type is **cleared** from every issue, not that the call
  fails. The bare `DELETE /rest/api/3/version/{id}` is deprecated upstream and
  is never called (CC-122); the body's `customFieldReplacementList` is out of
  scope. Needs Administer Projects.
  `GET /rest/api/3/version/{id}/relatedIssueCounts` supplies the three counts
  the before-state carries (CC-123).
- `DELETE /rest/agile/1.0/sprint/{sprintId}` — the agile root, not the
  platform one. Atlassian: "Once a sprint is deleted, all open issues in the
  sprint will be moved to the backlog." Needs the board's manage-sprints
  permission. No client-side state guard: the request is sent whatever the
  sprint's state, and a refusal is Jira's to make and ours to re-aim with
  remediation, like the other sprint writes (CC-124).

All six answer **`204 No Content`** on success. All six are unsafe, so the
retry rules in §"Rate limiting and retries" apply unchanged: they are never
replayed on an ambiguous failure — a replayed delete cannot be distinguished
from a 404 that means "already gone".

## Bulk operations (D103)

Extracted from Atlassian's own OpenAPI document for the platform v3 API
(downloaded 2026-09-01); the HTML reference group is
`https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-bulk-operations/`.

- `POST /rest/api/3/bulk/issues/delete` — body
  `{ selectedIssueIdsOrKeys: string[], sendBulkNotification?: boolean }`.
  `selectedIssueIdsOrKeys` is required and capped at **1000** entries; subtasks
  of selected parents are deleted too and count against the cap.
  `sendBulkNotification` defaults to **true** server-side, and an absent field
  is left absent so the default stays Jira's (CC-131). Answers **201** with
  `{ taskId }`. Permissions: the global **Bulk Change** permission plus Browse
  projects and **Delete issues** in every touched project.
- `POST /rest/api/3/bulk/issues/fields` — **the bulk-edit path; there is no
  `/bulk/issues/edit`** (CC-130). Body `{ editedFieldsInput, selectedActions,
  selectedIssueIdsOrKeys, sendBulkNotification? }`: `editedFieldsInput` is
  Jira's 23-family field union, of which this server builds four families —
  labels, priority (by id), assignee via the single-select clearable user
  picker, fixVersions via the multiple-version picker; `selectedActions` names
  the field ids being edited and is derived from the fields actually present.
  Caps: **1000 issues and 200 fields** per call. Answers **201** with
  `{ taskId }`. Permissions: global **Bulk Change** plus Browse projects and
  **Edit issues** per project.
- `GET /rest/api/3/bulk/queue/{taskId}` — answers **200** with
  `BulkOperationProgress`: `taskId`, `status` (one of `ENQUEUED`, `RUNNING`,
  `COMPLETE`, `FAILED`, `CANCEL_REQUESTED`, `CANCELLED`, `DEAD`),
  `progressPercent`, `submittedBy`, `created`/`started`/`updated`,
  `totalIssueCount`, `processedAccessibleIssues` (the ids the operation
  SUCCEEDED on — failures are only in the next field, CC-214),
  `failedAccessibleIssues` (issue id → error strings) and
  `invalidOrInaccessibleIssueCount`. A task stays viewable for **14 days**
  after completion. Permission: global **Bulk Change** only — nothing
  per-project, so the queue is readable for tasks submitted through the Jira
  UI as well.

The two submits are unsafe POSTs, so §"Rate limiting and retries" applies
unchanged: they are never replayed on an ambiguous failure — a replayed submit
enqueues a SECOND task, not the same one. The queue GET is a plain read and
retries under the normal policy.

## Board configuration (D133)

- `GET /rest/agile/1.0/board/{boardId}/configuration` — answers **200** with
  `{ id, name, type, location?, filter: { id }, subQuery?: { query },
  columnConfig: { columns: [{ name, statuses: [{ id }], min?, max? }],
  constraintType }, estimation?: { type, field?: { fieldId, displayName } },
  ranking: { rankCustomFieldId } }`. `location.type` is `project` (with
  `projectKey`/`id`) or `user` for a personal board; ids arrive as numbers or
  strings. `estimation.type` is `field` when the board estimates by a field
  (story points, typically `customfield_10016`) or `issueCount`. Permission:
  view the board, which needs Browse projects on its filter's projects; an
  invisible board is **404**. A plain read, retried under the normal policy.

## Board backlog (D134)

- `GET /rest/agile/1.0/board/{boardId}/backlog` — the issues the board's filter
  (and kanban sub-query) selects that are in no active or future sprint, in
  rank order. Query: `startAt`, `maxResults` (≤ 50), `jql`, `fields`,
  `validateQuery`, `expand`. Answers **200** with the sprint-issue envelope
  `{ startAt, maxResults, total, issues[] }`. A kanban board whose backlog is
  disabled answers **400**. Permission: view the board. A plain read, retried
  under the normal policy.

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
- **A sprint name must be shorter than 30 characters**, and the endpoint says so
  in exactly those words with a 400 keyed on `name`. The cap is undocumented in
  the reference above; it was found on the first live write run, where the Gate C
  sprint was called `gate-c-<runid> (safe to delete)` — 32 characters — and took
  three dependent claims down with it. Nothing client-side enforces this: the
  limit is the site's to state, and Jira's message is already the remediation.
- **Single-sprint read.** `GET /rest/agile/1.0/sprint/{sprintId}` returns the
  sprint whole — `id`, `name`, `state`, dates, `originBoardId`, `goal`. The
  delete's before-state (D102) is built from it, through the same seam, just
  before the DELETE; the caller needs to be able to view the board.
- **Backlog move.** `POST /rest/agile/1.0/backlog/issue`, body
  `{ "issues": ["ABC-1", ...] }`, answers 204 with no body. Jira defines it as
  "removing the future and active sprints from a given set of issues", so it
  takes no board id. The sibling `POST /rest/agile/1.0/backlog/{boardId}/issue`
  differs only by accepting ranking arguments and is not used.
- **The 50-issue cap is Jira's own**, identical on the sprint move and the
  backlog move, and it is enforced client-side (D22): an over-cap batch is
  refused with nothing sent, rather than half-applied upstream.
- **Sprint edit (D135).** `POST /rest/agile/1.0/sprint/{sprintId}` with any of
  `name`, `goal`, `startDate`, `endDate` and no `state` — the same partial
  update as start and close. A closed sprint answers **400**; an active one
  accepts a new `endDate` and `goal`.
- **Rank (D136).** `PUT /rest/agile/1.0/issue/rank` with `{issues,
  rankBeforeIssue | rankAfterIssue, rankCustomFieldId?}`, at most 50 issues,
  which keep their given order. **204** when every issue moved; **207** when
  only some did, with `entries: [{issueId, issueKey, status, errors}]` — a
  success status, so the client reads the entries rather than throwing, and
  never resends.
- **Estimate (D137).** `PUT /rest/agile/1.0/issue/{issueIdOrKey}/estimation
  ?boardId={boardId}` with `{value}` — a string, whatever the field type —
  writes the field the board estimates with and answers **200**
  `{fieldId, value}`. An issue off the board or a board without an estimation
  field answers **400**.

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
  moved between projects. Two single-entity reads exist for the delete's
  before-state (D102): `GET /rest/api/3/component/{id}` returns the component
  whole, and `GET /rest/api/3/component/{id}/relatedIssueCounts` answers
  `{issueCount}` — the number of issues that reference it.
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
  `overdue` is Jira's own computed verdict and is read-only. The delete's
  before-state (D102) reads `GET /rest/api/3/version/{id}` and
  `GET /rest/api/3/version/{id}/relatedIssueCounts`, whose answer has three
  edges: `issuesFixedCount`, `issuesAffectedCount` and
  `issueCountWithCustomFieldsShowingVersion`.
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

## Jira Data Center (D106–D116)

**UNVERIFIED** — every verdict below comes from Atlassian's Data Center REST
documentation and has never met a Data Center instance. The adapter
(`api/datacenter.ts`) serves only the rows marked *served*; the registry
excludes every other tool (CC-263).

| Cloud route (v3 root unless noted) | Data Center | Verdict |
|---|---|---|
| `GET /myself` | `GET /rest/api/2/myself` — `name` + `key`, no `accountId` | served, own mapper (CC-270) |
| `GET /mypermissions` | `GET /rest/api/2/mypermissions` — same record shape; older builds ignore the key filter and answer the whole catalog | served (D122), the api ring keeps only the asked keys (CC-1402) |
| `POST /search/jql` (`nextPageToken`) | `POST /rest/api/2/search` (`startAt`, `total`) | served, twin + `dc1:` cursor (CC-267) |
| `POST /search/approximate-count` | none — `POST /rest/api/2/search` with `maxResults: 0` answers an exact `total` | served (D114) as `jira_count` over the classic search, `approximate: false`, no `approximate` hint (CC-340, CC-341) |
| `GET /issue/{key}`, `/comment`, `/worklog`, `/transitions` | same paths under `/rest/api/2` | served, same function on the v2 root, DC user dialect |
| `GET /issue/{key}/changelog` | none — `GET /rest/api/2/issue/{key}?expand=changelog&fields=` embeds it | served (D114), paged here inside the embedded history; `incomplete` when it holds fewer than its `total` (CC-342…CC-344) |
| `GET /issue/{key}?fields=attachment` | same path under `/rest/api/2`, DC author | served (D114), URLs dropped, DC user dialect (CC-345, CC-346); upload not served (no tool removes an attachment, D117, CC-347) |
| `GET /attachment/{id}`, then `GET /attachment/content/{id}?redirect=false` (v3) | `GET /rest/api/2/attachment/{id}` for the metadata; no REST content route — the bytes come from the servlet `GET {contextPath}/secure/attachment/{id}/{filename}` | served (D117), twin: frozen `secure` root, filename as one encoded segment, the `content` URL never followed, any redirect refused as `config`, size cap before and after the transfer, a body that is not the file (size mismatch, HTML for a non-HTML attachment) refused as `unexpected_shape` (CC-370…CC-378, CC-399) |
| `GET /project/search` | `GET /rest/api/2/project` — one bare array | served, twin, filters applied here (CC-268) |
| `GET /project/{key}` | same path | served, DC `lead` |
| `GET /field`, `GET /issueLinkType` | same paths | served |
| `GET /statuses/search` | `GET /rest/api/2/status` — array, category as an object | served, twin (CC-268) |
| `GET /issue/createmeta/{p}/issuetypes[/{id}]` | same paths under `/rest/api/2` from Data Center 8.4, rows in `values` with `isLast`; the legacy `?expand=` route is gone in 9.0 | served (D116), twin reading `values`, never the legacy route; a bare 404, or Jersey's `null for uri` 404, is `unsupported` naming 8.4 (CC-360…CC-365, CC-380) |
| `GET /filter/search`, `GET /filter/{id}` | `/filter/search` absent on many releases; `GET /rest/api/2/filter/favourite` (a bare array of the caller's favourites) and `GET /rest/api/2/filter/{id}` are long-standing | served (D115) without `/filter/search`: the list reads the favourites only and says so in `scope`, `filterName` and paging applied here, `accountId` refused, DC owner, no share permissions (CC-350…CC-357) |
| `/user/search`, `/user/assignable/search` | `username=` instead of `query=` | served (D110), DC user dialect; `includeEmail: true` refused (CC-307…CC-310) |
| `/issue/{key}/watchers` | same path, DC users | served, DC user dialect (D108, CC-275) |
| `/issue/{key}/votes` (write) | same path, no body | served (D111), the authenticated user's own vote (CC-317) |
| `/project/{p}/component`, `/project/{p}/version` (paged) | `/components`, `/versions` (arrays, long-standing) | served over the arrays, filters applied here (D108, CC-275) |
| `/project/{p}/role`, `/project/{p}/role/{id}` | same paths, DC actors (`name`, no `actorUser`) | served (D110), own actor mapper (CC-311) |
| `/bulk/*` | none | not served |
| Agile `/board`, `/board/{id}/sprint`, `/sprint/{id}/issue` | same, Jira Software Data Center | served, DC user dialect on issue fields |
| `POST /issue`, `PUT /issue/{key}`, `POST /issue/{key}/transitions` | same paths under `/rest/api/2`, wiki-markup bodies | served (D109); `assigneeAccountId`/`reporterAccountId` refused |
| `POST`/`PUT /issue/{key}/comment[/{id}]`, `POST /issue/{key}/worklog`, `POST /issueLink` | same paths under `/rest/api/2`, wiki-markup bodies | served (D109), DC user dialect on the answer |
| `PUT /issue/{key}/assignee` | same path under `/rest/api/2`, body `{ "name": "<username>" }`, unassign `{ "name": null }` | served (D111) by `username`; `accountId` refused (CC-317, CC-318) |
| `POST`/`DELETE /issue/{key}/watchers` | same path under `/rest/api/2`; POST body the username as a bare JSON string, DELETE `?username=` | served (D111) by `username`; `accountId` refused (CC-317, CC-318) |
| `POST /component`, `PUT /component/{id}` | same paths under `/rest/api/2`, same body fields (`project` key, `assigneeType`) | served (D113); `leadAccountId` refused, lead answered in the DC dialect (CC-330…CC-332) |
| `POST /version`, `PUT /version/{id}` | same paths under `/rest/api/2`, same body fields (numeric `projectId`, `YYYY-MM-DD` dates) | served (D113) (CC-330) |
| Agile `POST /sprint`, `POST /sprint/{id}` (start), `POST /sprint/{id}/issue`, `POST /backlog/issue` | same, Jira Software Data Center | served (D113), the Cloud request as is (CC-330) |
| Agile `POST /sprint/{id}` with `state: closed` | same | not served — a closed sprint cannot be reopened (D113, CC-334) |
| Every other write (deletes, bulk) | same or absent | not served (D109) |

Rich text on Data Center is wiki markup. The known rich-text fields are
flattened by `api/wiki.ts` in `adfToText`'s conventions (CC-271…CC-274);
`raw: true` returns the markup as sent, and `format: "markdown"` is refused
rather than mislabelled (CC-265).

The write side is `api/wiki-writer.ts` (stage 13.4a, CC-276…CC-289 and CC-299…CC-301). It
renders the ADF the Cloud builders produce as wiki markup, using the
following notation facts:

- **Escapes.**
  - The metacharacters `* _ - + ^ ~ ? { } [ ] | !` are escaped with a
    backslash. This is Atlassian's documented escape.
  - A backslash cannot escape itself, because `\\` is a line break. A literal
    backslash, and everything else a backslash cannot neutralise, is written
    as a numeric character reference (`&#92;`). That covers:
    - a line-leading `#`, `h1.`–`h6.` or `bq.` (the block parser reads the
      line before escapes);
    - an `&` that would start an entity;
    - emoticons: `:)`, `;)`, `(y)`, `(!)` and the like render as images;
    - `[ ] |` inside a link label or table cell, because the token is split
      before escapes;
    - U+2028/U+2029.

    **UNVERIFIED:** that Jira Data Center passes numeric references through to
    the rendered text. This is standard in its renderer, but it has not been
    observed on a real host. `wikiToText` decodes references last, so a
    round trip through this server is exact either way.
- **Controls.** C0/C1 control characters other than tab and newline are
  dropped, and CR/CRLF become LF.
- **Marks.** A mark renders only with no letter or digit outside it and no
  whitespace inside its edges. Where that does not hold, the writer keeps the
  text and drops the mark. Mid-word emphasis is therefore lost; it is not
  turned into stray `*`.
- **Code.** A code body containing `{code}` is written in `{noformat}`. A body
  containing both closers gets a zero-width space after each closer's `{`.
- **Nesting.** `{quote}` does not nest, so an inner quote is flattened. Wiki
  list items are single lines: paragraphs in an item join with `\\`, and code
  inside an item becomes `{{…}}` spans. An ordered list's start number is not
  kept.
- **Mentions.** A mention is written as literal display text, never
  `[~name]` — unless the Data Center adapter resolved it (D112, below). A
  Cloud accountId is not a Data Center username, and an id from caller JSON is
  not trusted to be one.
- **Unsupported content.** Any node or mark outside the subset is a
  `validation` error, never dropped.
- **Links.** Jira auto-links a bare URL in text. That is a rendering fact the
  writer does not suppress; the link target is the text itself.

Stage 13.4b wires it into the writes, as the next paragraph describes.

Writes travel the other way (D109): the Cloud builders produce their ADF
documents as usual, and the adapter's request wrapper renders every document
in the body to wiki markup (`api/wiki-writer.ts` `wikiFromAdf`) on its way to
`/rest/api/2` — so plain text is escaped, markdown keeps its structure, and a
node wiki markup cannot express is refused before the request is sent.

The user writes (D111) take the Data Center identifier instead of translating
one: `jira_assign_issue`, `jira_add_watcher` and `jira_remove_watcher` accept
`username` beside `accountId`, the Data Center twins
(`assignIssueDataCenter`, `addWatcherDataCenter`, `removeWatcherDataCenter`)
refuse `accountId`, and the Cloud functions refuse `username` — each before a
request exists, so plan mode shows the Data Center body. The username comes
from a user field the reads return (`name`), from `jira_get_myself`, or from
`jira_search_users` (D110).

Mention resolution (D112, stage 13.6a) is D100 over the Data Center user
search: `resolveMentionNamesDataCenter` in `api/users.ts` runs the same rules,
cap and refusals as the Cloud resolver, but searches
`GET /rest/api/2/user/search?username=` and takes the user's `name` as the
target id. The adapter records the targets its resolver returned (a
`WeakSet`, by identity), and its `adfFromMarkdown` tags, with a
module-private symbol (`tagDataCenterMentions`), exactly the mention nodes
built from those targets; `wikiFromAdf` writes a tagged node as
`[~username]` and every other mention as literal text. So a mention in
caller-supplied ADF, or from any other map, can never become a user link.
A username is written only if it matches `^[\p{L}\p{N}._@+-]{1,255}$` —
checked at resolution, when tagging, and when writing — so it can neither end
the link (`]`), alias it (`|`), open markup (`[ { } ~ \ *`) nor break the
line; one that does not match is a `validation` error, never rewritten.
UNVERIFIED: that `username=` matches display names on the target release as
documented, and that `[~username]` (not `[~key]`) notifies on it.

The admin and agile writes (D113) need no translation beyond the root: the
component and version functions run on `/rest/api/2` with their Cloud bodies
(descriptions are plain text on both products, so nothing is rendered), and
the sprint and move functions are the Cloud ones on `/rest/agile/1.0`. The
one Cloud-only field, a component's `leadAccountId`, is refused in the
adapter before a request exists rather than mapped to `leadUserName`.

## Rate limiting and retries

- Jira Cloud rate limits per user/app; on breach returns `429` with
  `Retry-After` seconds header.
- Policy (canonical — matches donor semantics in `core/http-util.ts`, imported
  by `core/http.ts`; corrected by the 2026-08-07 panel):
  - `429`: retried for ALL methods, honouring `Retry-After` capped at **60 s**
    (cap-and-retry, matching donor `MAX_RETRY_AFTER_MS`), plus **+0–20 %
    jitter** from the injected RNG — synchronized agents must not stampede the
    same tenant when the window reopens;
  - **except a spent quota (D127):** a 429 whose `RateLimit-Reason` is
    `jira-quota-global-based` or `jira-quota-tenant-based` is an hourly
    budget, not a burst — it is never retried; the call fails as
    `rate_limited` after one request, naming the reason and the
    `Retry-After` / `X-RateLimit-Reset` instant. `jira-burst-based` and
    `jira-per-issue-on-write` follow the rule above; the per-issue one tells
    the model to slow its writes to that issue. Unknown reason values are
    dropped, never echoed;
  - `502/503/504` + transport errors: retried only for **GET** requests
    (`isIdempotent` in the donor is deliberately GET-only — Jira PUTs can carry
    non-idempotent `update` add/remove clauses, so PUT is NOT replayed), plus
    requests explicitly marked `safe: true` per-request. The `safe` flag exists
    because `POST /search/jql` and `POST /search/approximate-count` are pure
    reads that deserve retries despite the POST verb;
  - unsafe writes are never replayed on 5xx/transport failure — an ambiguous
    write surfaces a `JiraError` with `kind: "ambiguous_write"` telling the
    model to verify state before retrying. When the 2xx headers arrived and
    only the body failed, the same kind carries the status and says the write
    was applied — do not send it again, read it back (CC-205);
  - backoff `min(500·2^(attempt−1), 8000) + 0–250 ms jitter` (the first retry
    waits ~500 ms; jitter from an injected RNG for test determinism), attempts
    capped (default 3);
  - per-host concurrency semaphore (default 4);
  - the whole tool call runs under a wall-clock budget `JIRA_CALL_BUDGET_MS`
    (default 120 s) — retry waits and semaphore queueing count against it; on
    breach the call aborts with `kind=budget_exceeded` instead of queueing
    retries forever (contract: OBSERVABILITY.md §Call budget).
- **The OAuth hosts sit outside all of the above.** Atlassian's rate-limiting
  documentation covers the Jira REST API only; **rate limits on
  `auth.atlassian.com` are NOT DOCUMENTED**. No 429 handling is documented for
  it, so none is asserted here.
- **A token POST is never replayed** (D94) — not on 429, not on 5xx, not on a
  transport error. This is the same invariant as an unsafe write, for a sharper
  reason: refresh tokens rotate, so a replay is indistinguishable on the wire
  from a stolen-token replay, and burning a refresh token logs the operator out
  of a server they cannot reach a browser from. Atlassian's own guidance points
  the same way — retry only if the API is idempotent *and* the response carries
  `Retry-After`. The accessible-resources **GET** is a plain read and retries
  under the normal policy.

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
- JQL strings are passed through verbatim — the server never builds JQL from
  fragments (injection surface belongs to the model, quoting rules documented in
  the tool description).
- Host rules (canonical suffix, allowlist matching) have their own section
  above — §Hosts.
