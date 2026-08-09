# Senior panel review — 2026-08-07

Pre-code specification review. Six independent senior analysts, each restricted to
their own discipline, each given the full `docs/` spec set, project `CLAUDE.md`,
and read access to the three donor repos (servicenow-mcp, tiktok-mcp,
facebook-mcp). All verdicts below are verbatim from the analysts.

## Verdicts

| Role | Verdict | Headline condition |
|---|---|---|
| Software Architect | CONDITIONAL GO | fix retry matrix; specify plan-mode seam; re-scope Phase 1 as DI rewrite |
| TypeScript/Node Engineer | CONDITIONAL GO | canonical retry matrix + per-request safe flag; fix tool count; re-scope Phase 1 |
| Security Engineer | CONDITIONAL GO | taint/plan_id controls for injection→write chain; port-with-deltas for host/http; path-encoding rule |
| QA Engineer | CONDITIONAL GO | fix count before snapshot test; determinism seams (jitter/timeout); ADF property tests in Phase 2 |
| Jira Platform Expert | CONDITIONAL GO | nextPageToken failure is 400 not 410; ADF update destruction warning |
| MCP/AI-DX Specialist | CONDITIONAL GO | specify hint/error catalogs; plan-mode anti-hallucination contract; declared `apply` field |

**Overall: CONDITIONAL GO — no NO-GO votes, no unconditioned GO votes.** The
architecture and research were consistently rated strong; every conditional
hinges on spec-level fixes that are cheap now and expensive after Phase 1.

## Cross-role convergence (found independently by ≥3 analysts)

1. **The retry matrix was self-contradictory and unsafe** (Architect, TS, QA).
   Spec claimed idempotent = GET/HEAD/OPTIONS/PUT/DELETE; donor code is
   deliberately **GET-only** (`isIdempotent` in `http-util.ts`). Jira PUT with
   `update` add/remove clauses is not idempotent. Also POST `/search/jql` and
   `/approximate-count` are safe reads that DO deserve retries → a per-request
   `safe: true` flag is required. Retry-After cap: donor uses 60 s, spec said
   30 s. → **FIXED in JIRA-API.md + CORNER-CASES.md (2026-08-07).**
2. **Tool count wrong: catalog enumerates 27, prose said 22** (Architect, TS,
   QA, MCP-DX). Snapshot test would have locked a contradiction.
   → **FIXED: 27/7 in TOOLS.md; IMPLEMENTATION-PLAN wording generalized.**
3. **"Port" from servicenow-mcp is actually a DI rewrite** (Architect, TS,
   Security). Donor `core/jira/http.ts` uses module singletons, settings
   imports, env-read credentials, raw `Date.now`/`setTimeout`/`Math.random`/
   `AbortSignal.timeout` — all banned by the target architecture. Only the
   retry semantics, error extractor, and ADF algorithms survive; the shell is
   re-authored in the tiktok clock/DI idiom. → Phase 1 re-scoped (see plan).
4. **Plan/apply gate under-specified** (Architect, Security, MCP-DX). Where the
   dry-run interception lives without breaking layering; the result must carry
   an explicit "NOT performed" contract (`executed: false`) or agents will
   report unexecuted writes as done; `apply` (and `profile`) must be declared
   auto-injected control fields or `.strict()` schemas reject them by
   construction; v1 should bind apply to a `plan_id` (both donors already have
   the mechanism), not a bare boolean the model can set itself.
5. **Per-call profile switching is a confused-deputy risk** (Architect, TS,
   Security, Jira expert). Recommendation: lock profiles by default in v1
   (`JIRA_LOCK_PROFILE` semantics as the only mode), defer switching to v2.

## Consolidated action list

### P0 — factual spec corrections (applied 2026-08-07, same session)
- [x] Retry matrix canonicalized: GET-only idempotence + `safe` per-request flag;
      Retry-After cap 60 s everywhere; corner cases 11–14 aligned.
- [x] `nextPageToken` failure signature corrected: **HTTP 400** + message
      substring (410 belongs to the removed legacy endpoints); token one-time-use
      and same-query constraints documented (JIRA-API.md, corner case 1).
- [x] Tool count 27/7; agile backlog "?" resolved into explicit action items.
- [x] `jira_list_statuses` endpoint corrected to `/rest/api/3/statuses/search`.
- [x] `maxResults` default unified at 25 (tool level).

### P1 — spec work required before Phase 1 code

*Closed 2026-08-09 (Phase 0.5a/0.5b). Findings and wording are unchanged — only
the boxes are ticked, with the owning document named.*

- [x] ARCHITECTURE.md: determinism seams — injected RNG for jitter; timeout as
      `clock.sleep` racing fetch with explicit `AbortController` (no
      `AbortSignal.timeout`). → ARCHITECTURE.md §Cross-cutting seams.
- [x] ARCHITECTURE.md: typing strategy paragraph (hand-rolled minimal
      interfaces + guards; explicitly reject OpenAPI codegen).
      → ARCHITECTURE.md §Typing strategy.
- [x] Phase 1 tasks rewritten as "port with mandatory deltas", each delta a
      named wire test: anchored-regex/exact allowlist matching (donor uses
      `endsWith` — banned), blocklist enforced even when allowlist set,
      `redirect: "manual"` + off-host rejection (donor follows redirects),
      per-segment `encodeURIComponent` + id validation (path traversal to
      same-origin arbitrary GET found by Security).
      → IMPLEMENTATION-PLAN.md Phase 1.
- [x] Host abstraction shaped as `{ origin, pathPrefix }` now (v2 OAuth gateway
      `api.atlassian.com/ex/jira/{cloudId}` needs it).
      → ARCHITECTURE.md §Cross-cutting seams.
- [x] Profiles: v1 = locked single profile; all secrets (incl. inactive
      profiles, `JIRA_HTTP_TOKEN`) registered with redactor at startup.
      → AUTH.md §Profiles; owner decision O-6 (default YES).

### P2 — spec work required before Phase 2 (tool surface)

*Closed 2026-08-09 (Phase 0.5b).*

- [x] TOOLS.md: new normative sections — result envelope, closed hint catalog,
      error-kind catalog, truncation marker shape (substring-tested).
      → TOOLS.md; 12 hint codes, 13 error kinds.
- [x] Plan-mode contract: `executed: false` + normative "NOT performed" line +
      remediation hint; `apply`/`profile` as auto-injected control fields;
      plan_id binding for apply. → TOOLS.md §Plan-mode; plan_id = **D14**.
- [x] `jira_transition_issue` accepts id **or name**, resolves server-side,
      returns valid transitions in the 400 error (anti-hallucination). CC-21.
- [x] Expired-token: fail fast for caller-supplied tokens; auto-restart only
      inside internal `searchPages()` loop. → CC-01.
- [x] Truncation hint forbids continuing pagination after a truncated page.
      → TOOLS.md §Truncation.
- [x] ADF: property tests move to Phase 2 (same PR as `api/adf.ts`); donor
      deltas named as work items (mention→accountId fallback, emoji/status/date
      node text, list indentation + depth cap); fixtures for
      table/codeBlock/panel/media/taskList. → IMPLEMENTATION-PLAN Phase 2 +
      TESTING.md §Fixtures.
- [x] `jira_update_issue`: ADF-object passthrough for description/comments +
      destruction warning in the tool description; corner case added; consider
      `update` add/remove verbs for labels (else clobbering must be documented).
      → TOOLS.md `jira_update_issue` (`labelsAdd`/`labelsRemove`), CC-31.
- [x] Annotation fixes: `jira_capabilities` openWorld=false;
      `jira_update_issue` destructiveHint reconsidered. → TOOLS.md §Annotations.

### P3 — scope decisions for the owner (v1 in/out)

*The first three are genuinely the owner's call and stay open as **O-3 / O-4 /
O-5** in DECISIONS.md (Gate B, decide before the Phase 2a snapshot). The fourth
was not a scope question — closed 2026-08-09.*

- [ ] `jira_update_comment` (own-comment edit) — Jira expert: day-one workflow.
      → O-3, default: defer to v1.5.
- [ ] `jira_get_backlog_issues` (agile read) — Jira expert: most common agile
      agent workflow; package is sprint-only without it. → O-4, default: defer.
- [ ] `jira_search_users`: optional `issue`/`project` input switching to
      `/user/assignable/search` (assignment on locked-down tenants).
      → O-5, default: IN (no new tool).
- [x] Taint envelope for Jira-content-bearing reads (facebook-mcp `taint.ts`
      port) — Security's compensating control for headless apply mode.
      → **D15**; TOOLS.md §Untrusted content, THREAT-MODEL.md, CC-35.

### P4 — before Phase 4/5

*Closed 2026-08-09 as spec; the code lands in the phase each item names.*

- [x] Write journal: redactor pass on every entry, 0600, documented as
      sensitive. → OBSERVABILITY.md §Write journal, CC-33, O-8 default.
- [x] Fixture PII-lint test; `fakeJiraRequest` canned data derived from
      recorded fixtures; env-docs-sync + stdout-purity tests ported.
      → TESTING.md §Fixtures + suites 7/8.
- [x] Env-gated live read suite (`JIRA_LIVE_TEST=1`, scheduled weekly) as the
      drift detector; `TZ=UTC` pinned in the runner; worklog offset injectable.
      → TESTING.md suite 9 + §Determinism knobs; offset source = **D16**.
- [x] npm publish hardening: pinned version in `.mcp.json` example, provenance,
      2FA publish. → IMPLEMENTATION-PLAN Phase 5; example pinned in
      CONFIGURATION.md.

## Open questions for the owner (deduplicated)

*Status 2026-08-09 appended per question. Only 3 and 4 still need the owner.*

1. Plan mode: may write tools execute their prerequisite *reads* (transitions,
   createmeta), or is the network fully closed? Is there an in-session apply
   path (plan_id), or is the design "human flips env and restarts"?
   → **Answered.** Prerequisite reads run in plan mode (a plan without the live
   transition list is a guess); only the write is captured. In-session apply
   via single-use `plan_id` = **D14** (was O-7).
2. Profiles: is multi-profile prod+sandbox in one session a real use case worth
   the confused-deputy risk? (Panel consensus: no, for v1.)
   → **Open as O-6** (default YES — locked single profile per process).
3. Scope: are `jira_update_comment` and backlog read in v1? Is
   `jira_move_to_backlog` v1.5?
   → **Open as O-3 / O-4** (Gate B). `jira_move_to_backlog` is v1.5 (ROADMAP).
4. Scratch Jira Cloud site: provisioned? Team-managed or company-managed
   project type for fixtures (createmeta differs)? Who owns re-recording?
   → **Open as O-2 (Gate C)** — owner console task, checklist in Phase 0.
5. Does `jira_search` expose raw ADF (`raw: true` exists only on
   `jira_get_issue`)?
   → **Answered: no.** `raw: true` stays single-issue-only — a search page of
   raw ADF blows the result budget for content nobody reads at list level.
   TOOLS.md §Read shaping.
6. Worklog `started` offset source: `/myself` timezone, site setting, or host
   TZ?
   → **Answered: `/myself` timezone**, cached per process, host TZ as fallback,
   injectable for tests, `Z` never sent. **D16**; CC-23.

## Method note

Panel prompts constrained each analyst to their discipline, required
severity-rated findings with file references, and demanded verification of spec
claims against actual donor code — which is precisely what surfaced the
spec-vs-donor contradictions (retry matrix, endsWith allowlist, redirect
following) that a docs-only review would have missed.
