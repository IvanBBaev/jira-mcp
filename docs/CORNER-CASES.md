# Corner cases

> Status: target-state spec (pre-code) — code may lag until the phase noted in
> IMPLEMENTATION-PLAN.md.

Enumerated behaviours the implementation must get right. Each becomes at least
one test. IDs (`CC-01`…`CC-35`) are **stable**: test names reference them, so
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
  `jira_search` results may lag; `reconcileIssues` passed when the tool call
  includes recently written issue ids; hint `eventual_consistency` on empty
  result right after a write.
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
  `not_found` that reads like "board doesn't exist".
- **CC-35** A content-bearing read that is also truncated keeps both markers:
  the injection warning and `_untrusted: true` survive alongside `ok`/`hints`
  while items are dropped from the body. Rendering un-branded content through
  the taint renderer throws (donor semantics) — silent unwrapping is a bug,
  not a fallback.
