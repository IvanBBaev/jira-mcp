# Role panel review — 2026-10-29

Post-1.0 review of `main` at `6cd07bd` (V3-06 done): `jira-mcp-ai` 1.0.0 as
published, plus everything merged since then. Nine independent senior
reviewers each worked read-only and stayed inside their own discipline. Each
one answered two questions: should `main` ship as 1.1.0, and does the v3 plan
(`docs/ROADMAP.md` V3-01…V3-28) hold? Their full reports are linked below and
stay unedited, apart from removing one tenant name. This file is the synthesis.
The work items they proposed are placed in `docs/ROADMAP.md`, under "Role
panel work packages (2026-10-29)", as rows V3-29…V3-81.

## Baseline — what we have

| Measure | Value | Source |
|---|---|---|
| Published | `jira-mcp-ai` 1.0.0 on npm, 58 tools, about 52 downloads/week | npm registry |
| `main` | 82 tools (42 reads, 40 writes, 11 irreversible) in 11 packages | `src/tools/manifest.snapshot.json`, `src/tools/index.test.ts` |
| Code | about 53k lines of TypeScript; layering `core ← api ← mcp ← tools` enforced in eslint | `src/` |
| Tests | 2944 / 2944 pass in about 17 s; lines 97.99 %, branches 94.35 % (floor 94) | gate run 2026-10-29 |
| Corner cases | 743 `CC-nn` ids, each one reached by a real test name (docs-lint enforced) | `docs/CORNER-CASES.md` |
| Live proof | 40 of 82 tools ever ran against a real tenant; the newest ran at 0.9.4 | `docs/RELEASING.md` Gate C |
| Model-visible surface | `tools/list` is 145,446 characters (about 34k tokens) for the full catalogue | MCP review, measured |
| Dependencies | `npm audit --omit=dev` clean; MCP SDK floor `^1.30` (lockfile 1.32.x), zod v4 | `package.json` |
| Licence | GPL-3.0 | `LICENSE` |
| Hard date | Atlassian CHANGE-3193 / RFC-127 removes the agile issue routes, reported for 2026-11-01. npm 1.0.0 still calls them. `main` moved to `/rest/software/1.0` (V3-01) but has no fallback, and that root has never been called live. | Jira platform review |

Net assessment: the offline engineering is unusually strong. The safety core
(write gate, never-replay, taint) is covered almost line for line, and the
gate is fast and deterministic. The risk is in four places:

1. The release clock. Installed users break about 2026-11-01.
2. The gap between what the docs claim and what is true: tool counts, the
   threat model, and live proof.
3. A growing model-visible surface that has no budget.
4. Release infrastructure that still runs on a bootstrap token.

## Why these nine roles

| Role | Why it is on the panel |
|---|---|
| Software Architect | Layering, the port, the DC adapter, and the v3 structural refactors (V3-09…V3-20). |
| TypeScript / Node Engineer | Type safety, module size, error construction, startup cost. These are the inputs to every split WP. |
| Security Engineer | The product sells write safety. Prompt injection, the plan/apply gate, data at rest, the HTTP transport, supply chain. |
| QA / Test Architect | The offline gate is the only proof for 42 of 82 tools. Is it honest and complete? |
| Jira Platform Expert | Atlassian API removals and changes in October and November 2026, Cloud vs DC, rate limits. |
| MCP / Agent-DX Specialist | The consumer is a model: surface size, descriptions, paging, tool selection. |
| Product Manager | Adoption is at 52 downloads/week. Positioning, distribution, and what to build next. |
| Docs / Onboarding | The first-run path, docs that are true, admin and governance docs. |
| DevOps / Release Engineer | The publish pipeline, credentials, CI honesty, repo hardening, the 1.1.0 release plan. |

The 2026-08-07 panel had six roles: Architect, TS, Security, QA, Jira and
MCP-DX. Product, Docs and DevOps were added because the project is now
published, and the open risks sit in distribution, onboarding and release.

## Verdicts

| Role | Ship `main` as 1.1.0 | v3 plan | Headline condition |
|---|---|---|---|
| Software Architect | CONDITIONAL GO | CONDITIONAL GO | Add an `/agile` fallback, or get a green live run, for the software routes. V3-09 needs CSPRNG plan ids and credential binding. V3-19 also owns `server.ts`. Decide on DC before V3-13. |
| TypeScript / Node Engineer | **GO** | CONDITIONAL GO | Raise the SDK floor to `^1.32.1` (advised). V3-10 is not a pure move: extract the pure decision functions first. V3-14 must measure before optimising. |
| Security Engineer | CONDITIONAL GO | CONDITIONAL GO | Resync THREAT-MODEL and correct its plan/apply claim before the tag. V3-09 and V3-16 carry security criteria. JSM (V3-26) waits for confirm-all-writes. |
| QA / Test Architect | CONDITIONAL GO | CONDITIONAL GO | Add scope-matrix tests for the new 1.1 paths. Claim no more than "40 of 82 live-proven" until Gate C runs. Add the alias suite before V3-24 and a fake-honesty check in V3-18. |
| Jira Platform Expert | CONDITIONAL GO | CONDITIONAL GO | Release before about 2026-11-01, with a runtime `/agile` fallback. Refresh the JQL docs for October 2026. Base V3-27 on the DC end-of-life date (2029-03-28). |
| MCP / Agent-DX | CONDITIONAL GO | CONDITIONAL GO | Remove tracker IDs from descriptions. Replace the stale "~94k" figure with the measured 145k and land the budget. Order V3-08 → V3-07 → V3-05. Add a tool-selection eval before renames. |
| Product Manager | **GO (urgent)** | CONDITIONAL GO | Ship before 2026-11-01 and fix the counts in the same release. Put distribution and first-run work first. Pause the internal refactors and freeze new tools until adoption targets are met. |
| Docs / Onboarding | CONDITIONAL GO | CONDITIONAL GO | Fix the counts and add a released-vs-main marker. Make the quick-start secret-safe. Correct the data-at-rest claim. Write the 1.1.0 upgrade notes. Cut V3-20 down to contributor docs. |
| DevOps / Release | CONDITIONAL GO | CONDITIONAL GO | Prove the publish credential works (trusted publisher, or a valid `NPM_TOKEN`). Run a live smoke of `/rest/software/1.0`. Add the release-infrastructure items before V3-16, V3-17 and V3-23. |

**Overall: CONDITIONAL GO for 1.1.0 and for the v3 plan.** No reviewer voted
NO-GO. Two voted an unconditional GO for 1.1.0 (TS, Product). Every reviewer
agrees on the date: 1.1.0 must ship before the agile routes are removed, about
2026-11-01, so the conditions below are sized to fit in the days that remain.

## Cross-role convergence (found independently by three or more reviewers)

1. **There is no fallback on the software root** (Jira, Architect, QA, DevOps,
   Product). `src/api/agile.ts` calls `/rest/software/1.0` with no fallback,
   and the route has never been called live. A 403 under some auth modes has
   been reported. If it fails, 1.1.0 breaks sprint and backlog reads, just as
   1.0.0 is about to. → **V3-29** (fallback) plus the re-scoped **V3-21**
   (live smoke the owner can run today).
2. **Counts and released-vs-main drift** (Product, Docs, MCP). The docs show
   80, 82, 55, 58 and 59 tools on different pages. The README snippet pins
   1.0.0, which has 58 tools, while the README describes 82. → **V3-30**
   (counts generated or linted from the manifest).
3. **The threat model no longer matches the code** (Security, Docs, QA). It
   lists 8 irreversible tools where there are 11, and it omits `JIRA_PROJECTS`.
   It says files reach disk in "exactly two places" where there are four.
   It implies plan/apply stops injection-driven writes, but the model plans
   and applies its own reversible writes. → **V3-31** (resync plus a
   manifest-driven drift test), and **V3-42** (opt-in confirm for all writes).
4. **Plan ids come from `Math.random`** (Architect, Security). This is harmless
   per session on stdio. Once V3-09 makes the plan store server-wide, it
   becomes a guessable cross-session handle. → V3-09 re-scope (CSPRNG ids,
   session and credential binding, TTL, quota).
5. **The surface is too big and keeps growing** (MCP, TS, Product). The full
   catalogue is 145k characters. 41 write tools are listed even when they can
   never apply. The `profile` parameter alone costs about 12k characters, and
   V3-25's trigger as written never fires. → V3-08 budget (re-scoped), the
   V3-25 re-scope, **V3-36** (description hygiene), **V3-46** (tool-selection
   eval).
6. **Live proof has fallen behind** (QA, Product, Jira, DevOps). 42 of 82 tools
   never ran live. The weekly live job skips because there are no secrets,
   and still shows green. → **V3-47** (full Gate C pass plus a generated
   ledger), **V3-39** (live job that fails loudly when it cannot run), and
   **V3-48** (fixtures plus a check that the fake matches real Jira).
7. **The Data Center decision gates the refactors** (Architect, Jira, Product,
   TS). DC branches sit inside the Cloud shapers. The DC adapter is assembled
   with `as unknown as JiraApi`. DC-only arguments leak into Cloud schemas.
   → **V3-79** (DC freeze row plus an eval-host spike, decided before V3-13),
   **V3-54**, **V3-63**.
8. **Release hygiene the owner must do** (Security, DevOps).
   - The bootstrap `NPM_TOKEN` is still live and probably expires in
     mid-November (inferred from npm's 90-day cap, not verified).
   - No trusted publisher is registered.
   - The API token once pasted into chat has not been rotated.
   - There are no `main` or tag rulesets.
   - Private vulnerability reporting is off, although `SECURITY.md` depends
     on it.

   → **V3-38**.

## Consolidated P0 / P1 list

| Pri | Finding | Roles | Roadmap row |
|---|---|---|---|
| P0 | npm 1.0.0 calls agile routes that are removed about 2026-11-01. Release 1.1.0 first. | all | V3-22 |
| P0 | No `/agile` fallback, and the software root was never called live | JIR, ARC, QA, OPS | V3-29, V3-21 |
| P0 | Tool counts are inconsistent, and the README snippet pins 1.0.0 | PRD, DOC, MCP | V3-30 |
| P0 | The quick-start puts the token inline in a committed `.mcp.json` | DOC | V3-32 |
| P0 | THREAT-MODEL data-at-rest claim is false (four sinks, not two) | DOC, SEC | V3-31 |
| P0 | 42 of 82 tools were never run live | QA, PRD | V3-47 |
| P0 | Project-scope paths are untested (59 of 302 branches never taken) | QA | V3-33 |
| P0 | Publishing depends on the bootstrap `NPM_TOKEN`; no trusted publisher | OPS, SEC | V3-38 |
| P0 | Invisible: no registry listing, a pitch that sells breadth | PRD | V3-23, V3-72 |
| P1 | The model plans and applies its own reversible writes; the docs overstate this | SEC | V3-31, V3-42 |
| P1 | `Math.random` plan ids before the server-wide store | ARC, SEC | V3-09 (re-scoped) |
| P1 | `tools/list` is 145k characters with no budget; gated-off tools are listed | MCP | V3-08, V3-25 (re-scoped) |
| P1 | No tool-selection eval before renames | MCP | V3-46 |
| P1 | Read tools receive the raw request (no read-only seam) | QA | V3-40 |
| P1 | The fake Jira is never checked against real Jira | QA | V3-48 |
| P1 | Rehearsals not in CI; live job is silently green | QA, OPS | V3-39 |
| P1 | No 1.x alias suite before V3-24 | QA | V3-45 |
| P1 | The bulkfetch cap is 100; Atlassian documents 1000 since 2026-08-28 | JIR | V3-50 |
| P1 | October 2026 JQL changes are not documented | JIR | V3-49 |
| P1 | `jiraRequest` is a 742-line closure; V3-10 is not a pure move | TSN | V3-10 (re-scoped) |
| P1 | DC adapter assembled through `as unknown as JiraApi` | TSN, ARC | V3-54 |
| P1 | About 40 direct `new JiraError(` sites skip `createJiraError` (scrubbing) | TSN | V3-55 |
| P1 | Tools import Cloud types and limits from `api`, bypassing the port | ARC | V3-60 |
| P1 | The publish job runs the gate twice while it holds the OIDC token and the npm token | OPS | V3-73 |
| P1 | `main`, `v*` tags and the `release` environment are unprotected | OPS | V3-38 |
| P1 | The in-gate audit blocks merges on every new advisory (Dependabot #20 and #21 are stuck) | OPS | V3-74 |
| P1 | No troubleshooting page; remediation links point to `blob/main` | DOC | V3-69 |
| P1 | No per-client install paths (`claude mcp add`, deeplinks, MCPB) | PRD, DOC | V3-32, V3-17 |
| P1 | The headline safety tools are not live-proven | PRD | V3-47 |
| P1 | Five different paging styles | MCP | V3-64 |

P2 and P3 findings stay in the individual reports, with their IDs
(`ARC-nn`, `TSN-nn`, `SEC-nn`, `QA-nn`, `JIR-nn`, `MCP-nn`, `PRD-nn`, `DOC-nn`,
`OPS-nn`). Every proposed item (`*-R*`) is mapped to a roadmap row; the
mapping is the *Source* column of the new table.

## Changes to existing rows

These have been applied to `docs/ROADMAP.md`:

- **V3-09.** The review adds security acceptance criteria: CSPRNG plan ids,
  binding to the session and the credential, a TTL, and a per-session quota.
  The estimate goes from 4 to 6 h.
- **V3-10.** Re-scoped. Extract the pure functions `classifyOutcome` and
  `decideNext` with table tests first, then move the stages. This is no longer
  a pure move. The estimate goes from 4 to 6 h.
- **V3-12.** Split by concern, not only by sub-domain. Estimate 3 → 4 h.
- **V3-14.** Re-scoped to measure first: commit a startup benchmark, and make
  schemas lazy only if startup is over budget. The SDK import alone costs
  about 110 ms; schemas cost 25–34 ms. Estimate 2 → 1.5 h.
- **V3-19.** Also owns `server.ts`, so there is a single constructor for the
  write pipeline. Estimate 4 → 6 h.
- **V3-20.** Cut down to contributor-corpus hygiene. User and admin docs move
  to V3-69…V3-71. The DECISIONS split may run early as a docs-only solo job.
- **V3-21.** No longer blocked-external for Basic auth: the owner can run the
  read half of `verify-live.mjs` today. It becomes blocked-owner. The scoped
  token and 3LO checks remain external.
- **V3-25.** The trigger is corrected to "omit `profile` when the profile is
  locked". It also covers gate-aware listing: omit gated-off irreversible
  tools, and add a plan-only prefix to write descriptions.
- **V3-08.** Budgets model-visible characters per profile and per tool. It
  updates the D124 figure from "~94k" to the measured value.

## Recommended order

1. **Before about 2026-11-01** (release lane):
   - V3-29 (fallback)
   - V3-21 (owner live smoke)
   - V3-30 (counts)
   - V3-31 (threat model)
   - V3-32 (quick-start)
   - V3-33 (scope matrix)
   - V3-34 (upgrade notes)
   - V3-36 (descriptions)
   - V3-37 (SDK floor)
   - V3-38 (credential)
   - then **V3-22, which needs the owner's yes**.

   If any of these slips, ship `1.1.0-rc.1` on the `beta` dist-tag, as the
   DevOps review recommends.
2. **The two weeks after the release**:
   - Distribution and first run: V3-23, V3-16, V3-17, V3-72, V3-25, V3-07.
   - Honest proof: V3-39, V3-47, V3-40, V3-41.
   - Platform drift: V3-49, V3-50.
3. **Before any 2.0 contract work**:
   - V3-45 (alias suite)
   - V3-46 (selection eval)
   - V3-48 (fake contract)
   - V3-79 (DC and freeze decisions)
4. **The refactors** (V3-10…V3-14, V3-18…V3-20 and the TS/ARC rows) start only
   after step 3, or once the owner decides on Product's feature freeze.

## Open owner decisions

1. **Release 1.1.0 now**, before about 2026-11-01, with or without a green
   V3-21? If the live smoke fails, is `1.1.0-rc.1` on `beta` acceptable?
2. **Semver**: the agile paging change (`startAt` becomes an alias) is
   breaking for strict callers. Is it called out in the 1.1.0 notes, or does
   it bump to 2.0?
3. **Credential**: register the npm trusted publisher, delete `NPM_TOKEN`,
   and rotate the API token that was pasted in chat. All three are owner-only.
4. **Feature freeze** (PRD-R15): no new tools and no non-urgent refactors
   until distribution and first-run work lands and 45 days of metrics exist.
5. **Data Center**: freeze it, or verify it on an evaluation host by
   2026-12-31. Base the 3.0 removal on Atlassian's 2029-03-28 read-only date.
6. **Default listing changes** (V3-25, MCP-R3/R4): hiding the `profile`
   parameter and gated-off tools changes `tools/list` with configuration.
   This is a contract change.
7. **Batch reversible update** (`jira_update_issues`, up to 50): this reopens
   a parked item.
8. **Sandbox**: an owner-admin Jira Cloud Free site so Gate C can cover the
   admin and delete tools.

## Reports

- [Software Architect](2026-10-29-architect.md)
- [TypeScript / Node Engineer](2026-10-29-typescript-engineer.md)
- [Security Engineer](2026-10-29-security.md)
- [QA / Test Architect](2026-10-29-qa.md)
- [Jira Platform Expert](2026-10-29-jira-platform.md)
- [MCP / Agent-DX Specialist](2026-10-29-mcp-agent-dx.md)
- [Product Manager](2026-10-29-product.md)
- [Docs / Onboarding](2026-10-29-docs-onboarding.md)
- [DevOps / Release Engineer](2026-10-29-devops-release.md)

One correction to the briefs: the reviewers were told the licence is MIT. It
is GPL-3.0. The Product review caught this, and nothing in the findings
depends on it.
