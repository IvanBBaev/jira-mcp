# Senior review panel — extended (second) panel, 2026-08-07

Follow-up to `2026-08-07-senior-panel.md` (architecture / TypeScript / security /
QA / Jira platform / MCP-DX). This panel covers the disciplines the first one
did not: operations, release engineering, documentation architecture,
product & agent workflow, privacy, and delivery management.

Method: six parallel senior agents, each restricted to its discipline, with full
access to `docs/`, the three donor repos, and the web for registry/vendor
verification. First-panel findings were excluded from re-reporting; only new
material counts.

## Verdicts

| Role | Verdict | Headline condition |
|---|---|---|
| SRE / Operations | CONDITIONAL GO | No per-call wall-clock budget — worst-case retry chain ≈ 5 min vs ~60 s typical MCP client timeout; token expiry undetectable when running unattended |
| Release & Supply chain | CONDITIONAL GO | Donor publish pipeline's auth model is dead (npm classic tokens revoked) — trusted publishing (OIDC) is the only sane path |
| Documentation architecture | CONDITIONAL GO | Two decision registries and quadruplicated contracts will drift; docs need a single-ownership regime before code lands |
| Product / Agent workflow | CONDITIONAL GO | The headline agent workflow (cron digest) costs ~31 calls without `orderBy`/changelog passthrough; plan mode without in-session apply breaks chained writes |
| Privacy & GDPR | CONDITIONAL GO | Outbound-data disclosure missing; logging spec not yet metadata-only at all levels |
| Delivery / PM | CONDITIONAL GO | Spec corpus uncommitted with no remote; scratch Jira site unowned although three phase exits depend on it |

All six: **CONDITIONAL GO**. No finding invalidates the architecture; every
condition is a spec or process item closable in Phase 0 / 0.5.

## Cross-role convergence

1. **The publish path is decided by external reality, not preference.** npm
   classic tokens were revoked 2025-12-09 and granular tokens cap at 90 days,
   so it is trusted publishing (GitHub OIDC, npm ≥ 11.5, Node 24 runner) or no
   publish. The donor `publish.yml` must not be copied. (Release F1; Delivery F5.)
2. **`plan_id`-bound in-session apply** is now recommended by product, delivery
   and (first panel) security — plan mode is otherwise unusable for chained
   writes (every apply re-executes planning, and multi-step plans double the
   call count). Adopt for v1, with prerequisite *reads* allowed in plan mode.
3. **One observability contract**: metadata-only logging at every level (never
   bodies, JQL, or ADF), a normative log-event table, and a per-call
   correlation id. SRE and Privacy arrived at the same rule from opposite
   directions. (SRE F4/F5/F14; Privacy F2.)
4. **Two unowned blockers, both owner-only**: (a) the spec corpus exists only
   in an uncommitted working tree — the initial commit + private remote needs
   Ivan's explicit authorization; (b) the scratch Jira site (Phase 1 exit,
   Phase 2b fixtures, Phase 4 e2e) is ~half a day of console work nobody is
   assigned. (Delivery F1/F2.) Both are now Phase 0 OWNER tasks.
5. **Docs need a governance regime, not more docs**: one decision ledger,
   stable corner-case IDs, a fact-ownership map, pointerized contracts, a
   docs-lint gate. (Docs F1–F6, F13.)
6. **Outbound-data disclosure**: a "Data handling & acceptable use" section is
   required — Jira content flows to the AI provider by design, and the doc must
   say so (plus employer-tenant authorization and transcript persistence).
   (Privacy F1.)

## Panel disagreements (owner calls — see E-P3)

1. **Write-journal content.** SRE F11 wants redacted human-readable fields for
   incident forensics; Privacy F3 wants an args-hash + issue key + outcome
   (minimized). The spec currently contradicts itself (CONFIGURATION.md says
   "args hash", SECURITY.md says "audit of every write"). Default: the
   minimized hash form + donor-style ~5 MB rotation, unless a concrete forensic
   need is stated.
2. **v1 scope additions.** Product recommends IN: `jira_update_comment` and a
   backlog-read capability (27 → 29 tools), plus assignable-user search as
   optional `issue?`/`project?` inputs on `jira_search_users` (no new tool).
   Delivery's default: defer anything not blocking the digest workflow to v1.5.
   Decide before the Phase 2a manifest snapshot locks the surface.

## E-P0 — factual fixes applied this session

- D1 rationale rewritten — Rovo has API-token auth since 2026-02-24, so the
  decision now rests on durable reasons (no agile/changelog/worklog surface,
  coarse permission groups, no plan gate, remote-hosted). D8 records the npm
  name-check result. (ARCHITECTURE.md)
- Truncation "whole items" rule now admits the corner-case-26 exception
  (single oversized item is field-truncated). (ARCHITECTURE.md)
- Retry-policy attribution corrected to donor `core/http-util.ts` (imported by
  `core/jira/http.ts`); the Phase 1 port-source list now names it.
  (JIRA-API.md, IMPLEMENTATION-PLAN.md)
- Hand-maintained "(27 tools in v1)" removed from the Phase 4 exit — TOOLS.md
  owns counts. (IMPLEMENTATION-PLAN.md)
- Launcher guard `.mjs` → `.cjs` (ES5-parseable) + old-Node CI probe; `mcpName`
  and nominative-use `trademark` fields added to the package.json spec;
  `dependabot.yml` added; CodeQL parked until the repo goes public.
  (IMPLEMENTATION-PLAN.md Phase 0)
- Phase 5 rewritten to trusted publishing (OIDC, no `NPM_TOKEN`); a real exit
  criterion added; Actions-secrets owner task added. (IMPLEMENTATION-PLAN.md)
- Phase 0.5 exit split into 0.5a/0.5b; Phase 2 split into 2a/2b with M1/M2
  milestone labels; fixture recording moved to Phase 1; corner-case ranges
  mapped to phase exits; donor SHAs pinned in Standing decisions; two risk rows
  added (scratch-site absence, multi-week pause). (IMPLEMENTATION-PLAN.md)
- Fixture redaction specified **inside** `scripts/record-fixture.mjs` (raw
  responses never touch disk), URL-embedded identifiers included; synthetic
  fixtures (`429`, expired token) marked `"synthetic": true`; the Phase 5
  coverage tuple labeled (lines 94 / branches 82 / functions 97). (TESTING.md)
- Project CLAUDE.md hard rule on retries restyled as a pointer to JIRA-API.md —
  the previous compressed wording was wrong for safe POSTs.

## E-P1 — spec work before Phase 1 (gates exit 0.5a)

*Exit 0.5a met 2026-08-09: every non-owner item below is written into the spec
(findings unchanged — only the boxes are ticked). The two OWNER items at the
end stay open as **O-1 (Gate A)** and **O-2 (Gate C)** in DECISIONS.md.*

Ops contract (SRE):

- [x] `JIRA_CALL_BUDGET_MS` per-call wall-clock budget (default ≤ 120 s; retry
      waits and semaphore queueing count against it) — CONFIGURATION.md +
      JIRA-API.md. (F1)
- [x] Optional `JIRA_TOKEN_EXPIRES` (ISO date) + ≤ 30-day warning in doctor and
      startup report — AUTH.md. (F2)
- [x] Doctor ops contract: human report on **stdout** (doctor is a CLI run, not
      an MCP session), exit codes 0/1/2, `--json`, `--offline`, TTY-guarded
      prompts, no short-circuit on first failure; add agile-root and
      journal-write probes. (F3, F9)
- [x] Normative log-event table (event name, level, fields) + never-log list:
      no request/response bodies, no JQL, no ADF at any log level — the
      corner-15 error snippet is the sole, bounded exception. (F4, F14;
      Privacy F2)
- [x] Per-tool-call correlation id (AsyncLocalStorage) attached to every log
      event of that call. (F5)
- [x] `Retry-After` honoured with +0–20 % jitter (thundering herd). (F7)
- [x] Startup is offline-only (no network before the transport connects);
      startup emits a one-line redacted config report. (F10, F15)

Release & supply chain:

- [x] zod v3-vs-v4 ADR before any of the tool schemas exist (SDK 1.30 peer
      range accepts both). (F6)
- [x] dotenv decision: drop in favour of Node's `process.loadEnvFile`
      (preferred), or keep with a normative `quiet: true` + stdout-purity test
      — dotenv ≥ 17 prints a stdout banner, which corrupts the MCP protocol.
      (F5)
- [x] `files` allowlist with negations (`!build/testing`, `!build/core/fakes`)
      + a tarball-content assertion test. (F4)

Docs regime (Docs architect):

- [x] `docs/DECISIONS.md` — single decision ledger; the ARCHITECTURE D-table
      and the plan's Standing decisions become pointers into it. (F1)
- [x] Stable corner-case IDs (CC-01…CC-30) before any test names reference
      them. (F2)
- [x] Fact-ownership map in a ~40-line `docs/README.md` index: CONFIGURATION =
      env defaults, JIRA-API = wire constants, TOOLS = tool defaults/counts,
      AUTH = credential lifecycle, THREAT-MODEL = gate contract. (F3, F10)
- [x] Write-gate contract: single owner (the threat-model doc); TOOLS /
      ARCHITECTURE / CONFIGURATION pointerize. (F5)
- [x] Rename `docs/SECURITY.md` → `docs/THREAT-MODEL.md` before the root
      `SECURITY.md` (vulnerability-reporting policy) exists. (F7)
- [x] `scripts/docs-lint.mjs` wired into `npm run check`: internal refs
      resolve; owned literals (defaults, counts, endpoints) appear only in
      their owner doc. (F13)
- [x] Spec-status banner on each doc ("target state — code may lag until Phase
      N") + normative-tag vocabulary ([eslint] / [test] / [honor]). (F12, F11)

Privacy:

- [x] "Data handling & acceptable use" section (README skeleton +
      THREAT-MODEL): outbound flow to the AI provider, employer-tenant
      authorization, transcript persistence, training-opt-in note; an
      acceptable-use sentence on workplace monitoring. (F1, F6)
- [x] Clarify in core docs: redaction targets **secrets**, not PII — PII
      minimization is a separate, shaping-level concern. (F7)

Owner (the two unowned blockers):

- [ ] OWNER: authorize the initial commit + create the private
      `IvanBBaev/jira-mcp` repo. (Delivery F1, CRITICAL) → **O-1 / Gate A** —
      still the single blocker on agent fan-out (WORK-PACKAGES.md).
- [ ] OWNER: provision the scratch Jira Cloud site per the Phase 0 checklist.
      (Delivery F2, CRITICAL) → **O-2 / Gate C** — blocks fixtures and the live
      suite, not Phase 1 code.

## E-P2 — spec work before Phase 2a/2b (gates exit 0.5b)

*Exit 0.5b met 2026-08-09 on the spec side. Decisions taken along the way:
telemetry counters kept and surfaced (**D12**), no circuit breaker (**D13**).
The HTTP-transport item is spec'd **and** carries its demotion default — the
scheduling call itself is still **O-11**.*

- [x] Read-shaping contract: requested `fields` returned verbatim except ADF
      flattened; `expand` preserved; fixture test covering issuelinks +
      fixVersions + `expand=changelog`. (Product F3)
- [x] `jira_get_comments` gains `orderBy` (`-created`); `jira_search` passes
      `expand=changelog` through; JQL idioms documented in the `jira_search`
      description (`openSprints()`, `issue in (...)`, backlog approximation);
      server-level `instructions` field at initialize. Takes the cron-digest
      workflow from ~31 calls to a handful. (Product F1, F6)
- [x] `jira_update_issue`: labels add/remove verbs upgraded from "consider" to
      DO; `parent: null` un-parenting semantics documented; create-then-move
      sprint hint. (Product F7)
- [x] User objects shaped everywhere as `{ accountId, displayName, active? }`;
      email only behind `includeEmail: true`. (Privacy F5)
- [x] Journal spec resolved per E-P3 decision 8 + donor-style ~5 MB rotation;
      journal ops semantics (journal write failure ≠ tool failure, surfaced as
      a hint). (SRE F11; Privacy F3)
- [x] HTTP transport: lifecycle spec (session teardown, healthz decision) or
      demote to v1.5. (SRE F8)
- [x] Donor `Telemetry` counters: surface in `jira_capabilities`/doctor, or
      record the drop as a decision. (SRE F6)
- [x] "No circuit breaker in v1" recorded as a decision; status-page
      remediation text on repeated 5xx; consecutive-failure summary log event.
      (SRE F13)
- [x] Version observability: server version in capabilities output + the
      startup line. (SRE F12)
- [x] Changelog tail access documented (recent-first story);
      `changelog/bulkfetch` tracked for v1.5. (Product F1)

## E-P3 — owner decision table

Defaults apply if no decision is recorded by the decide-by point.

*This table is the origin of rows **O-1…O-13** in DECISIONS.md, which is now the
single source of truth for their status — read it there, not here. As of
2026-08-09 row 7 (`plan_id`-bound apply) is resolved by default as **D14**; the
rest are still open.*

| # | Decision | Recommendation / default | Decide by |
|---|---|---|---|
| 1 | Initial commit + private remote | Do it (Delivery CRIT) — **requires Ivan's explicit go**; nothing is committed without it | now |
| 2 | Scratch Jira site provisioning | Owner console task, ~half a day, checklist in Phase 0 | before Phase 1 exit |
| 3 | `jira_update_comment` in v1 | Product: IN (→ 28); Delivery default: defer to v1.5 | before Phase 2a snapshot |
| 4 | Backlog read in v1 | Product: IN (→ 29); Delivery default: defer | before Phase 2a snapshot |
| 5 | Assignable search as `issue?`/`project?` inputs on `jira_search_users` | Product: IN (no new tool — likely convergent) | before Phase 2a snapshot |
| 6 | Locked single profile per process | Both panels: YES | before Phase 1 |
| 7 | `plan_id`-bound in-session apply | Adopt for v1; prerequisite reads allowed in plan mode | Phase 0.5 close |
| 8 | Journal content: redacted fields vs args-hash | Default: minimized hash form + rotation | before Phase 4 |
| 9 | npm name: reserve early (0.1.x placeholder) vs wait + accept fallback scope | Wait, unless publish is likely | with decision 1 |
| 10 | Repo visibility | Private through v1 (CodeQL parked) | with decision 1 |
| 11 | HTTP transport in v1 | Demote to v1.5 unless a concrete use case exists | before Phase 2a |
| 12 | Is unattended (cron/CI) use a v1 acceptance criterion? | Sizes the priority of SRE F1/F2/F3 | Phase 0.5 |
| 13 | Anthropic-terms context (consumer vs Team plan) for the data-handling text | State the actual plan in the doc | Phase 0.5 |

## E-P4 — Phase 4/5 and later

- Semver contract for the tool surface (input-schema narrowing or tool removal
  = major) in the CONTRIBUTING/CHANGELOG policy. (Release F12)
- THREAT-MODEL statement on the true transitive surface (~94 packages via the
  SDK; mitigations: lockfile, dependabot cooldown, audit gate). (Release F11)
- CI enrichment: Windows leg, advisory next-Node leg, SHA-pinned actions,
  concurrency cancel; audit-placement reconciliation (check script vs CI).
  (Release F8, F9)
- Weekly live suite (Actions `JIRA_*` secrets) + a "Last verified" stamp
  protocol for JIRA-API.md wire facts. (Docs)
- WORKLOG / reviews append-only convention recorded. (Docs)

## Verified external facts (as of 2026-08-07)

- `npm view jira-mcp-ai` → 404 — the name is free. `jira-mcp` is taken (stale;
  last publish 2025-02); adjacent names are actively being minted (one
  published 2026-08-06).
- npm classic tokens revoked 2025-12-09; granular tokens capped at 90 days
  since 2026-02-03; trusted publishing requires npm ≥ 11.5.1 → Node 24 runner.
- Atlassian Rovo MCP: API-token auth since 2026-02-24; ~14 tools; no
  agile/changelog/worklog surface; coarse read/write/search permission groups.
- sooperset/mcp-atlassian: ~5.7k stars, ~98 tools; open issues complain about
  the oversized default tool surface — validates the lean-surface bet.
- dotenv ≥ 17 prints a stdout banner unless `quiet: true` (facebook-mcp
  mitigates this); Node ≥ 22 ships `process.loadEnvFile`.
- MCP SDK 1.30 zod peer range `^3.25 || ^4.0`; zod latest 4.4.3.
- Donor SHAs pinned: servicenow-mcp@5acdcc7, facebook-mcp@6de6f87,
  tiktok-mcp@59c4ce0. All three MIT, same owner — porting is licence-clean.
