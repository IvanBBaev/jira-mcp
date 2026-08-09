# Jira Cloud API notes

> Status: target-state spec (pre-code). This document owns the **wire
> constants**: endpoints, pagination models, retry numbers. Other docs point
> here instead of restating them.

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
| `startAt` / `maxResults` / `total` / `isLast` | almost everything else (comments, worklogs, project search, users, agile) | `fetchPage()` / `fetchAll()` with `DEFAULT_MAX_PAGES` and loop guard |

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
- **Write (v1.5)**: markdown subset → ADF (headings, bullet/ordered lists, code
  fences with language, inline code, bold/italic, links). Tracked in ROADMAP.md.

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
  name/email → accountId. Email may be masked depending on privacy settings.
- `GET /rest/api/3/myself` verifies credentials and returns the caller identity —
  the doctor probe and `jira_get_myself` use it.

## Transitions

Status cannot be set via update. Flow: `GET /rest/api/3/issue/{key}/transitions`
→ pick transition id → `POST` with `{ transition: { id }, fields?, update? }`.
Transition screens may require fields (e.g. resolution) — pass through and
surface Jira's validation errors verbatim.

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
