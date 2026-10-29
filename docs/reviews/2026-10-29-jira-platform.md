# Jira Platform Expert review — 2026-10-29

Scope: whether the `main` tree of `jira-mcp-ai` (unreleased 1.1, 82 tools in 11
packages, plus a 48-tool Data Center preview behind `JIRA_DATACENTER_PREVIEW=true`)
matches the Jira Cloud and Data Center platforms it talks to today, and what in
the next 12 months will break or drift it. Method: the code under
`src/core`, `src/api` and `src/tools`, and the specs `docs/JIRA-API.md`, `docs/AUTH.md`,
`docs/DECISIONS.md` and `docs/ROADMAP.md`, were read and checked against
Atlassian's published references and changelogs, fetched on 2026-10-29. No Jira
site was called, and no build, test or gate was run. A claim that rests on
something Atlassian has not published, or that only a live tenant can settle, is
marked **unconfirmed**.

## Verdict

| Decision | Call | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | **CONDITIONAL GO** | Release now, before the RFC-127 agile issue-route removal (reported as 2026-11-01, unconfirmed), with a runtime fallback to `/rest/agile/1.0` on a 403/404 from `/rest/software/1.0` (JIR-01). Also refresh the JQL guidance for the October 2026 changes (JIR-03). |
| The v3 plan (ROADMAP V3-xx) | **CONDITIONAL GO** | Move V3-22 (release) and a platform-drift work package (JIR-R2/R3) ahead of the structural refactors (V3-12/13/18/20). Base V3-27 on Atlassian's DC end-of-life dates rather than a self-chosen deadline. |

Overall, the platform work is above the bar for this category. The search,
pagination, ADF, scope and rate-limit decisions are all documented, many are
pinned by wire tests, and the code says honestly what it has not verified. The
main risk is timing, not code. The fix for the RFC-127 removal (V3-01) is on
`main`, but the only build users can install (npm 1.0.0) still calls the agile
routes that are being removed, and V3-22 is blocked on the owner. There is also
a cluster of small drifts:
- a bulk-fetch cap that is now stale;
- JQL semantics that changed in October;
- a retry policy that differs from Atlassian's updated guidance in three places.

None of these is a release blocker on its own, but together they are what will
generate support issues in Q4 2026.

## Strengths

- **Search runs only on the enhanced endpoint.** It uses `/rest/api/3/search/jql`
  with `nextPageToken`, and `/search/approximate-count` for counts
  (`src/api/search.ts:59`, `:62`). The legacy `/search` appears only in the DC
  twin (`src/api/search.ts:361`). This matches the removal in
  https://developer.atlassian.com/changelog/#CHANGE-2046.
- **RFC-127 is already handled on `main`.**
  - Cloud sprint and backlog issue reads use the new `software` root
    (`src/core/types.ts:745`, `src/api/agile.ts:690-744`).
  - A non-zero `startAt` is refused with clear remediation, and token paging is
    used instead (`src/api/agile.ts:700-711`).
  - The new route `GET /rest/software/1.0/sprint/{sprintId}/issue` is published
    (https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/).
- **The retry policy is conservative on writes.**
  - A 5xx is replayed only for GET or explicitly `safe` requests; otherwise it
    becomes `ambiguous_write` (`src/core/http.ts:1348-1362`, `src/core/http-util.ts:507-532`).
  - A points-quota 429 (`jira-quota-global-based` / `jira-quota-tenant-based`)
    fails fast with the reset instant instead of burning the call budget
    (`src/core/http.ts:1288-1300`, `src/core/http-util.ts:616-632`, D127).
  - This matches the quota semantics in
    https://developer.atlassian.com/cloud/jira/platform/rate-limiting/.
- **The scope documentation is honest.**
  - `docs/AUTH.md:135-232` maps every tool to its classic and granular scopes.
  - Inferred scopes are labelled as inferred (`docs/AUTH.md:159`, `:166`, `:173`).
  - `delete:sprint:jira-software` is kept out of the defaults.
- **Writes are ADF-correct and warn about replacement.**
  - The v3 API takes ADF bodies (`src/core/adf.ts`).
  - Raw ADF input is accepted.
  - `jira_update_issue` says in its description that replacing a description
    loses tables and panels (`src/tools/issues-write.ts:562-572`).
- **Attachment handling follows Atlassian's rules.** It uses `redirect=false`,
  `X-Atlassian-Token: no-check` and a 50 MiB cap (`docs/JIRA-API.md` §376,
  `src/api/attachments.ts:496`).
- **Users are identified by `accountId` only.** No email is projected
  (`src/api/users.ts:55-61`). This matches the GDPR rules in
  https://developer.atlassian.com/cloud/jira/platform/deprecation-notice-user-privacy-api-migration-guide/.
- **The service-account grant uses the documented endpoint.** The default token
  origin is `auth.atlassian.com` (`src/core/oauth.ts:309`, `src/core/settings.ts:977`).
  That is the host Atlassian documents for `grant_type=client_credentials`
  (https://support.atlassian.com/user-management/docs/create-oauth-2-0-credential-for-service-accounts/).

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| JIR-01 | P0 | The only installable build (npm 1.0.0) calls the agile issue routes that RFC-127 removes. The fix on `main` has no fallback if `/rest/software/1.0` answers 403. | `docs/ROADMAP.md:311`, `:331-332`; `docs/DECISIONS.md:172` (D500 fallback deferred); `src/api/agile.ts:740-744` (`rootProbe: false`) | Ship V3-22 now. Add a one-shot fallback to `/agile` on 403/404 from `software` while the old route still answers. | 3 |
| JIR-02 | P1 | The `/issue/bulkfetch` cap is 100 "from memory". Atlassian now documents up to 1000. | `src/api/issues.ts:388`; `docs/DECISIONS.md:160` (D149); software changelog 2026-08-28 | Re-verify the cap and raise it, or keep 100 deliberately with the reason recorded. Update D149 and claim C61. | 1.5 |
| JIR-03 | P1 | Three JQL semantics changes from October 2026 are not reflected in the docs or tool descriptions. | `docs/JIRA-API.md:116-150`; `src/api/search.ts:752`; platform changelog 6, 7 and 8 Oct 2026 | Update the JQL reference resource, the `jira_search` and `jira_parse_jql` descriptions, and JIRA-API.md. | 2 |
| JIR-04 | P2 | The retry policy differs from Atlassian's current guidance: a 503's `Retry-After` is ignored, backoff starts at 500 ms (guidance says 2–5 s), and a quota 429 does not pause the next call. | `src/core/http.ts:1348-1362`; `src/core/http-util.ts:40-44`, `:547`; rate-limiting page | Honour `Retry-After` on 503. Add a process-wide quota circuit until `resetAt`. Record why the backoff stays lower (or raise it). | 3 |
| JIR-05 | P2 | 429 is replayed for non-idempotent writes. Atlassian says to retry only idempotent requests. | `src/core/http-util.ts:507`, `:532`; rate-limiting page | Keep the replay (a 429 is a pre-processing reject), but document the deviation in D-log and JIRA-API.md §842, or restrict it to requests with `Retry-After`. | 1 |
| JIR-06 | P2 | The new software routes cap comments and changelog at 20 per issue (RFC-127). A caller who passes `fields: comment` gets silently truncated data. | `src/api/agile.ts:712`, `:727` (user `fields` passed through); RFC-127 thread | Flag truncation in the result when `comment` or changelog is requested, and point to `jira_get_issue`. | 2 |
| JIR-07 | P2 | `reconcileIssues` is unused. Read-after-write lag is documented only as a hint. | `docs/JIRA-API.md:130-133`, `:559`, `:579` (D504) | Pass written ids through `reconcileIssues` on the next search/sprint read inside a session (≤50). | 3 |
| JIR-08 | P2 | Some OAuth scopes are inferred and never proven live: backlog move, create sprint, component/version delete. | `docs/AUTH.md:159`, `:166`, `:173`; CLAUDE.md "40 of 58 proven live" | Add these to the next Gate C run, under 3LO and under a scoped token. | 2 (+live) |
| JIR-09 | P2 | The DC adapter assumes the 8.4+ createmeta routes and wiki markup with no version detection. `doctor` reads `/serverInfo`, but the runtime does not. | `src/cli/doctor.ts:1148`; `docs/JIRA-API.md:713-840`; ROADMAP post-1.0 "serverInfo read not shipped" | Read `serverInfo.versionNumbers` once per profile and refuse unsupported majors with a `config` error. | 3 |
| JIR-10 | P3 | JIRA-API.md is dated "as of 2026-08" and carries an unconfirmed removal date. | `docs/JIRA-API.md:9`, `:552` | Add a dated "platform watch" section and a refresh cadence, and link the changelog RSS. | 1 |
| JIR-11 | P3 | ADF replace on `jira_update_issue` destroys media, tables and panels with only a static warning. | `src/tools/issues-write.ts:562-572`; `src/core/adf.ts` | In plan mode, fetch the current description and list the non-subset node types that would be lost. | 3 |

## Detailed findings

### JIR-01 — Installed users break at the RFC-127 removal; `main` has no fallback

- **What.**
  - V3-01 (done, `7f2b923`) moved the Cloud sprint-issue and backlog reads to
    `/rest/software/1.0`, but it is unreleased. npm 1.0.0 still calls
    `/rest/agile/1.0/sprint/{id}/issue` and `/board/{id}/backlog`.
  - V3-22 (release) is `blocked-owner`.
  - V3-21 records a reported 403 on the new root and plans "a fallback to
    `/agile` while it still answers". D500 deferred that fallback.
  - The software read calls `agileCall({ rootProbe: false }, …)`. Nothing
    retries on the old root.
- **Evidence.** `docs/ROADMAP.md:311`, `:331`, `:332`; `docs/DECISIONS.md:172`;
  `src/api/agile.ts:740-744`; `docs/JIRA-API.md:547-585`.
- **Platform reference.**
  - RFC-127
    (https://community.developer.atlassian.com/t/rfc-127-jira-software-cloud-api-changes-improving-scalability-for-software-space-issue-results/98871)
    lists the 8 affected agile issue endpoints, the removal of `startAt` and
    `total`, and a tentative launch at the end of March 2026 followed by a
    six-month deprecation period. That puts removal in or after October 2026.
  - The specific CHANGE-3193 entry with a 2026-11-01 date was **not found** in
    the rendered changelog. The date is **unconfirmed**, but it is consistent
    with the RFC timeline.
  - The 403 report is **unconfirmed**. The RFC thread does not mention token
    kinds.
- **Impact.** On removal day, `jira_get_sprint_issues`, `jira_get_backlog` and
  `jira_sprint_summary` fail for every 1.0.0 user. If the 403 report is real for
  some auth kind, 1.1.0 users on that kind fail even earlier, while the old
  route would still have worked.
- **Recommendation.**
  - Release now: 1.1.0, or V3-01 alone as 1.0.1.
  - On Cloud, when `software` answers 403 or 404, retry once on
    `/rest/agile/1.0` with `startAt` paging and set a `degraded` hint. Remember
    the outcome for each profile for the rest of the session.
  - Remove the fallback when the agile route returns 404/410.
- **Acceptance criteria.**
  - Wire tests: software returns 403 → the agile call is made → the result is
    marked degraded.
  - Software returns 200 → no agile call.
  - Both fail → the original software error is surfaced.
  - The fallback never applies to writes.
  - D-log entry added.
  - V3-21 is turned into a live confirmation of the fallback, not a
    precondition for it.

### JIR-02 — The `/issue/bulkfetch` cap is stale

- **What.** `MAX_BULK_ISSUES = 100`. D149 says the cap is "Unverified from
  memory, settled by Gate C claim C61".
- **Evidence.** `src/api/issues.ts:387-391`, `docs/DECISIONS.md:160`,
  `docs/JIRA-API.md:295`.
- **Platform reference.** The Jira Software Cloud changelog, 28 Aug 2026,
  announces that `POST /rest/api/3/issue/bulkfetch` supports up to 1000 issues
  (https://developer.atlassian.com/cloud/jira/software/changelog/). The
  conditions attached to the 1000 cap, such as field count or no
  expand/properties, are **unconfirmed**.
- **Impact.** Agents pay ten round trips where one would do. This matters most
  on OAuth/Forge points quotas, where each request costs points.
- **Recommendation.** Read the operation reference and raise the cap to what it
  documents. Pin it as a named constant and add a wire test. If the 1000 cap
  is conditional (for example, only without `expand`), encode the condition.
- **Acceptance criteria.**
  - The constant matches the published reference, which is cited in D149.
  - A test covers the boundary (cap accepted, cap+1 refused).
  - TOOLS.md and the tool schema `maxItems` agree, and the manifest snapshot is
    updated.

### JIR-03 — The October 2026 JQL changes are not reflected

- **What.** Three changes from the platform changelog
  (https://developer.atlassian.com/cloud/jira/platform/changelog/):
  1. **6 Oct 2026.** `=`, `IN` and `NOT IN` on text fields become exact-phrase
     matching. Agents that "know" `summary = foo` is invalid, or that only `~`
     works, will now see different, broader results.
  2. **7 Oct 2026.** User entity-property JQL searches on voter, watcher and
     creator fields are deprecated, with removal on **16 Nov 2026**.
  3. **8 Oct 2026.** `/search/jql` validates JQL directly again: a 400 is
     returned, including for custom JQL functions. A pre-flight
     `/jql/parse?validation=strict` is no longer needed before a search.
- **Evidence.** `docs/JIRA-API.md:116-150` (search section);
  `src/api/search.ts:752` (`jql/parse` with `validation=strict`); the
  `jira_parse_jql` tool description and the JQL reference resource (D124).
- **Impact.**
  - The model gets stale guidance and spends an extra parse call per search.
  - Saved filters or prompts that rely on the deprecated entity-property
    clauses fail after 16 Nov 2026 with a 400 the model cannot explain.
- **Recommendation.**
  - Reposition `jira_parse_jql` as a "diagnose and explain" tool rather than a
    required pre-flight.
  - Make sure the `/search/jql` 400 body (`errorMessages`) reaches the model
    verbatim.
  - Add the text-field `=` semantics and the entity-property removal to the JQL
    resource.
- **Acceptance criteria.**
  - Updated docs with each change cited by date.
  - A wire test showing that a `/search/jql` 400 with `errorMessages` surfaces
    as a `validation` error with Jira's message.
  - Docs-lint is green.

### JIR-04 — Retry and backoff differ from current Atlassian guidance

- **What.**
  1. A 503 carrying `Retry-After` is retried on the plain 0.5–8 s backoff, and
     the header is ignored (`src/core/http.ts:1348-1362`).
  2. The first backoff is 500 ms with 0–250 ms jitter, capped at 8 s
     (`src/core/http-util.ts:44`, `:547`).
  3. A quota 429 fails the current call fast (good), but the next call is sent
     immediately and is refused again.
- **Platform reference.**
  https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
  - A 503 may carry `Retry-After`.
  - Backoff should start at about 2–5 s, cap around 30 s, use 0.7–1.3 jitter
    and about 4 attempts.
  - When a quota is exhausted, all requests should pause until the window
    resets.
- **Impact.** Small extra load during incidents, and noisy repeat 429s under
  quota exhaustion. Each repeat refusal also counts toward abuse heuristics
  (**unconfirmed**).
- **Recommendation.**
  - Use `max(Retry-After, backoff)` for retryable 503s, capped at the existing
    60 s.
  - Add a per-profile "quota open until `resetAt`" circuit. Calls made inside
    the window fail locally with the same `rate_limited` error and
    `retryAfterS`, and never reach the wire.
  - Either raise the base backoff to 2 s for the 5xx path, or record in D-log
    why a lower base suits an interactive agent with a 120 s budget.
- **Acceptance criteria.**
  - Clock-injected tests: a 503 with `Retry-After: 3` waits 3 s; a quota 429
    followed by an immediate second call sends no second request; the circuit
    closes at `resetAt`.
  - JIRA-API.md §842-890 is updated.

### JIR-05 — 429 is replayed for unsafe writes, unlike the published advice

- **What.** `RETRY_ANY_METHOD = new Set([429])` replays POST and PUT on 429.
- **Evidence.** `src/core/http-util.ts:507`, `:532`; the header comment at
  `src/core/http.ts:31`.
- **Platform reference.** The rate-limiting page says to "retry only idempotent
  requests". The design here relies on a 429 being a pre-processing reject,
  which is reasonable but **unconfirmed** by Atlassian for every limiter. The
  per-issue write limiter (`jira-per-issue-on-write`) is the case most likely
  to be safe.
- **Impact.** Low. A duplicate create is possible only if a limiter rejects
  after a side effect.
- **Recommendation.** Keep the replay, but write the deviation and its rationale
  into D-log and JIRA-API.md. Optionally limit the replay of unsafe methods to
  429s that carry a `Retry-After` or a known `RateLimit-Reason`.
- **Acceptance criteria.** A D-log entry, plus one test that pins the chosen
  behaviour for POST + 429 without `Retry-After`.

### JIR-06 — The software routes may truncate comments and changelog silently

- **What.** The new sprint and backlog reads pass the caller's `fields`
  through unchanged.
- **Evidence.** `src/api/agile.ts:712`, `:727`, `:746-760`.
- **Platform reference.** RFC-127 proposes a cap of 20 comments and 20
  changelog entries per issue in the new endpoints. Whether the cap shipped as
  proposed is **unconfirmed**. The published operation page does not show it.
- **Impact.** A sprint review prompt that asks for `comment` gets at most 20
  comments per issue and nothing says the list is incomplete.
- **Recommendation.** When `comment` is in the requested fields and an issue
  returns `total > comments.length` or exactly 20, add a `truncated` hint that
  points to `jira_get_comments`. Also check `jira_sprint_summary`.
- **Acceptance criteria.**
  - A fake-jira route that returns 20 comments with a higher `total`.
  - The tool result carries the hint.
  - TOOLS.md notes the limit.

### JIR-07 — `reconcileIssues` is unused, so read-after-write is only a hint

- **What.** Search, and per D504 the software routes, are eventually
  consistent. Both accept `reconcileIssues` (≤50 ids). The server documents
  this but never sends it.
- **Evidence.** `docs/JIRA-API.md:130-133`, `:559`, `:579`.
- **Platform reference.**
  https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post
  (`reconcileIssues`). RFC-127 notes that the move to eventual consistency also
  covers the software routes.
- **Impact.** The typical agent sequence is to create or transition an issue
  and then search to confirm. The search then returns stale results and the
  agent concludes the write failed.
- **Recommendation.** Keep a bounded, per-profile ring of ids written in the
  last N seconds (N ≈ 60, cap 50). Send it as `reconcileIssues` on the next
  `/search/jql` and software read. Never send it to DC.
- **Acceptance criteria.**
  - A wire test showing that a write followed by a search sends the id.
  - The ring expires by the injected `Clock`.
  - No ids are sent across profiles.
  - The behaviour is documented, with a switch to turn it off.

### JIR-08 — Inferred OAuth scopes are unproven

- **What.** The scopes for backlog move (`write:board-scope:jira-software`),
  create sprint, and the component/version deletes (`manage:jira-project`) are
  marked as inferred.
- **Evidence.** `docs/AUTH.md:159`, `:166`, `:173`. CLAUDE.md records that 13 of
  30 writes have been proven live.
- **Platform reference.** The Jira Software scope list
  (https://developer.atlassian.com/cloud/jira/software/scopes-for-oauth-2-3LO-and-forge-apps/)
  does not state the per-operation scope for all of these, so the scopes are
  **unconfirmed**.
- **Impact.** A 3LO or scoped-token user hits a 403 the docs cannot explain.
- **Recommendation.** Add these operations, together with the software read
  root (V3-21), to one Gate C pass under three credential kinds: classic API
  token, scoped token through the gateway, and 3LO.
- **Acceptance criteria.** Each "inferred" label in AUTH.md is replaced by
  "verified YYYY-MM-DD" or by the corrected scope.

### JIR-09 — No runtime version detection on Data Center

- **What.**
  - The DC adapter hard-codes the 8.4+ createmeta routes, `/rest/api/2` with
    wiki markup, and PAT bearer auth.
  - `doctor` reads `/serverInfo` (`src/cli/doctor.ts:1148`). The runtime does
    not, and the ROADMAP post-1.0 list says that read was not shipped.
  - The preview has never been run against a live host.
- **Platform reference.**
  - The DC REST reference is versioned per release
    (https://developer.atlassian.com/server/jira/platform/rest/).
  - Atlassian's Data Center end of life
    (https://www.atlassian.com/licensing/data-center-end-of-life): end of new
    sales on 30 Mar 2026, end of sales to existing customers on 30 Mar 2028,
    and **read-only end of life on 28 Mar 2029**.
- **Impact.** On 8.0–8.3, or on hosts with differing behaviour, the adapter
  fails with confusing errors. Investment beyond 2029 is wasted.
- **Recommendation.** Detect the major and minor version once per profile and
  refuse versions below 8.4 with a `config` error. Feed the result into V3-27.
- **Acceptance criteria.** Wire tests for 8.3 (refused), 9.x and 10.x (accepted),
  and the version shown in `jira_capabilities`.

### JIR-10 — The platform spec has no refresh cadence

- **What.** JIRA-API.md is "as of 2026-08" and still carries the reported
  2026-11-01 date.
- **Evidence.** `docs/JIRA-API.md:9`, `:552`.
- **Platform reference.** https://developer.atlassian.com/cloud/jira/platform/changelog/
  (RSS available).
- **Recommendation.** Add a dated "Platform watch" table, which this review's
  calendar can seed, and make updating it part of every release checklist.
- **Acceptance criteria.** The table exists, RELEASING.md references it, and
  docs-lint checks that its date is newer than the last release.

### JIR-11 — The ADF replace loss is warned about but not measured

- **What.** Updating a description from Markdown replaces the whole ADF
  document. Tables, panels, media and mentions outside the subset are lost. The
  warning is static text.
- **Evidence.** `src/tools/issues-write.ts:562-572`, `src/core/adf.ts`.
- **Platform reference.** The ADF structure
  (https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).
- **Impact.** Silent data loss on rich descriptions, especially attached media
  (`mediaSingle`).
- **Recommendation.** In plan mode, read the current description, list the node
  types outside the round-trip subset, and require `raw` ADF or an explicit
  `acceptLoss: true` before applying.
- **Acceptance criteria.** A test where a description with a table and media
  produces a plan that lists both, and an apply without the flag is refused.

## Platform change calendar

| Date | Change | Source | Affected tools |
|---|---|---|---|
| ~2026-11-01 (**unconfirmed**; RFC timeline: March 2026 launch + 6 months) | Agile issue routes (8 endpoints) removed in favour of `/rest/software/1.0` | RFC-127 thread (URL above); CHANGE-3193 not found | `jira_get_sprint_issues`, `jira_get_backlog`, `jira_sprint_summary` on npm 1.0.0 |
| 2026-11-16 | Removal of user entity-property JQL on voter, watcher and creator | Platform changelog, 7 Oct 2026 | `jira_search`, `jira_count_issues`, filters, JQL resource and prompts |
| In effect since 2026-10-06 / 10-08 | Text-field `=`/`IN` become exact-phrase matching; `/search/jql` validates JQL directly | Platform changelog | `jira_search`, `jira_parse_jql`, JQL resource |
| In effect since 2026-08-28 | `/issue/bulkfetch` accepts up to 1000 issues | Software changelog | `jira_get_issue` (`issues`) |
| 2027-01-01 | Egress range 131.162.88.0/21 must be allowlisted | Platform changelog, 16 Oct 2026 | All tools, for allowlisted customers (V3-03 done) |
| 2027-02-01 | `portfolioChildIssuesOf()` includes team-managed hierarchies | Platform changelog, 27 Oct 2026 | `jira_search` results (JQL resource note) |
| Experimental, no date | `/rest/api/3/policies`: admins may block field and status creation | Platform changelog, 15 Oct 2026 | Any future field/status create; error mapping |
| No date (**unconfirmed**) | API tokens without scopes deprecated (banner withdrawn) | https://community.developer.atlassian.com/t/api-tokens-without-scopes-are-being-deprecated/92510 | Basic auth path; D301 scoped tokens are the hedge |
| Ongoing | Points-based quotas enforced since 2026-03-02 for OAuth/Forge/Connect, not for API tokens; `Beta-` header prefix dropped | Rate-limiting page | http client (V3-02 done) |
| 2027-03-30 | MCP spec release (not Atlassian) | ROADMAP V3-28 | `src/mcp/*` |
| 2028-03-30 / 2029-03-28 | DC end of sales to existing customers, then read-only end of life | DC end-of-life page | The whole DC preview (V3-27) |

## Assessment of the existing roadmap

- **V3-01 (done).** Agree with the content. The missing pieces are the 403
  fallback (JIR-01), the 20-comment truncation note (JIR-06), and
  `reconcileIssues` on the software root (JIR-07). The RFC lists 8 endpoints;
  the tree calls only two of them (sprint issue, backlog), so the remaining six
  (board issue, epic issue) need no work. That should be stated in D500 so the
  next reader does not have to re-check it.
- **V3-21 (blocked-external).** Re-scope. Today it is a live check that gates a
  fallback. Invert it: ship the fallback as code under JIR-R1 (offline,
  testable, not blocked), and keep V3-21 as the live confirmation across three
  credential kinds, merged with the inferred-scope checks (JIR-08).
- **V3-22 (blocked-owner).** Reorder it to the very top. This is the single
  highest-value platform action: every day it waits, the npm user base keeps
  running into the removal. If 1.1.0 needs more review, cut V3-01 alone as
  1.0.1 this week.
- **V3-26 (JSM).** Agree, at a lower priority than drift. The Rovo MCP
  expansion makes JSM parity a product argument, not a platform one. Missing
  pieces:
  - JSM lives on a separate root (`/rest/servicedeskapi`) with its own paging
    (`start`/`limit`/`isLastPage`) and the `X-ExperimentalApi` header for some
    operations
    (https://developer.atlassian.com/cloud/jira/service-desk/rest/intro/).
  - It needs its own scopes (`read:servicedesk-request`, etc.) in AUTH.md.
  - Customer-portal permissions differ from agent permissions.
  - 6 h is plausible for reads only; it needs a new root in
    `src/core/types.ts:741-745`.
- **V3-27 (DC decision by 2027-06-30).** Re-scope with the external dates:
  Atlassian makes DC read-only on 2029-03-28 and stops selling it to existing
  customers on 2028-03-30. "Grow" therefore buys at most about 21 months of
  useful life after the decision date. The decision needs one live DC run
  first, plus serverInfo detection (JIR-09). Without a host, the honest default
  is "freeze as a preview and remove in 3.0".
- **Considered and parked.**
  - Confluence (separate server): agree.
  - Webhooks: agree.
  - JQL builder: agree. The October semantics changes (JIR-03) argue for
    documentation over a DSL.
  - Bulk move: agree.
  - Bulk transition: agree, but note that `/bulk/issues/transition` is now the
    only way to transition more than about 20 issues without hitting the
    per-issue write limiter in bursts. Revisit if users ask for "close the
    sprint's leftovers".
  - Bulk watch: agree.
  - `GET /bulk/issues/fields`: agree.
  - JSM: now partly reversed by V3-26. The two entries should be reconciled.
  - Missing from the list: Forge/Connect app distribution (a deliberate
    non-goal worth stating), and the experimental `/policies` API.

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| JIR-R1 | Cloud software-root fallback to `/agile` on 403/404, read-only, degraded hint, per-profile memo | JIR-01 | `src/api/agile.ts`, `scripts/fake-jira.mjs` (agile routes), `docs/JIRA-API.md`, `docs/DECISIONS.md` | V3-01 | no | 3 |
| JIR-R2 | October 2026 JQL refresh: text-field `=` semantics, entity-property removal, direct validation; `jira_parse_jql` repositioned | JIR-03, JIR-10 | `docs/JIRA-API.md`, JQL reference resource, `src/tools/search.ts` (descriptions), `docs/TOOLS.md` | — | no | 2 |
| JIR-R3 | Raise the bulkfetch cap to the published value, after re-reading the reference | JIR-02 | `src/api/issues.ts`, `src/tools/issues.ts`, `docs/DECISIONS.md` (D149), manifest snapshot | — | no | 1.5 |
| JIR-R4 | Retry alignment: 503 `Retry-After`, quota circuit, documented 429-on-write rationale | JIR-04, JIR-05 | `src/core/http.ts`, `src/core/http-util.ts`, `docs/JIRA-API.md` | V3-02 | no | 4 |
| JIR-R5 | Read-after-write: `reconcileIssues` ring for search and software reads | JIR-07 | `src/api/search.ts`, `src/api/agile.ts`, new small `src/core` ring | JIR-R1 | no | 3 |
| JIR-R6 | Truncation hint for comments and changelog on the software routes | JIR-06 | `src/api/agile.ts`, `src/tools/agile.ts`, `scripts/fake-jira.mjs` | JIR-R1 | no | 2 |
| JIR-R7 | DC `serverInfo` version gate | JIR-09 | `src/api/datacenter.ts`, `src/tools/capabilities.ts` | V3-13 | no | 3 |
| JIR-R8 | Gate C platform pass: software root plus inferred scopes under classic token, scoped token and 3LO | JIR-01, JIR-08 | live run, `docs/AUTH.md` | JIR-R1 | yes (live tenant) | 2 |
| JIR-R9 | ADF loss report in plan mode for description replace | JIR-11 | `src/tools/issues-write.ts`, `src/core/adf.ts` | — | no | 3 |

## Open questions for the owner

1. Will you release this week? If not 1.1.0, will you cut V3-01 alone as 1.0.1
   so npm users survive the agile removal?
2. Should the `/agile` fallback (JIR-R1) ship even if V3-21 never confirms the
   reported 403? It costs one extra request only on failure.
3. Bulkfetch: should it be raised to the published cap, or stay at 100 to limit
   response size for the model's context window?
4. Data Center: given read-only end of life on 2029-03-28, will you fund one
   live DC host run before 2027-06-30? Without it, the default is "freeze the
   preview, remove in 3.0".
5. JSM (V3-26): is it a product priority because of Rovo parity, or can it wait
   until after the drift items (JIR-R1…R6)?
