# Backlog analysis — 2026-11-07

A companion to `2026-11-06-state-analysis.md`. That report says what is true
and what to do first; this one works through the backlog itself: which rows
can move, in what order, in how many parallel lanes, what the freeze decisions
allow, which decisions only the owner can make, what can go wrong, and where
the code is hardest to work in. Every number comes from the same snapshot,
`main` at `8de2d0f` (source unchanged since 2026-10-31), measured on
2026-11-06 and 2026-11-07. No live tenant was touched, no repository file
outside `docs/` changed.

**Method.** The roadmap rows were parsed by a script from the *Deps*, *Owns*,
*Status* and *Est h* columns of `docs/ROADMAP.md`, so the graph and the
overlap list below are reproducible from the file alone. "Ready" means every
dependency row is `done`. Hours are the roadmap's own estimates. The
modularity section reads the six largest files that have no split row and
proposes cuts in the V3-12 style (a barrel over a sub-directory, pure moves).
The coverage table is the per-file c8 report of the gate run on `8de2d0f`.

## 1. Dependency graph

81 rows: 40 done (116.5 h), 28 todo (98.5 h), 6 blocked-owner (20 h),
3 blocked-external (33 h), 2 parked (12 h), 1 deferred (4 h), 1 partial (2 h).

### Ready now

| Kind | Rows | Hours |
|---|---|---|
| Code, no decision in the way | V3-55, V3-57, V3-58, V3-60, V3-74 | 14 |
| Docs, no decision in the way | V3-69, V3-70, V3-72, V3-81 | 15.5 |
| Code, a decision in the way (section 3) | V3-13, V3-64, V3-65 | 9.5 |
| Owner acts, nothing technical ahead of them | V3-21, V3-23, V3-24 (paper), V3-27, V3-38, V3-63 | 19 |
| External (sandbox) | V3-47 | 7 |

Everything else waits on one of the rows above. Five rows gate the rest:

| Gate row | Opens | Hours behind it |
|---|---|---|
| V3-57 (split `createProjectScope`) | V3-19 → V3-42, V3-61, V3-62 → V3-66; V3-19 is also on the V3-28 path | 29 h on the longest path |
| V3-74 (audit CI job) | V3-75, V3-77 | 4.5 |
| V3-38 (owner release hygiene) | V3-22 → V3-80; V3-73 → V3-76 | 10.5 and 4.5 |
| V3-13 (Data Center twins directory) | V3-59, V3-67, V3-20 → V3-71 | 10 on the longest path |
| V3-47 (Gate C) | V3-48 → V3-18 → V3-20 → V3-71 | 26 |

### Longest forward chains

| Chain | Hours | Note |
|---|---|---|
| V3-24 → V3-28 | 32 | 2.0 cleanup then the 3.0 wire; V3-24 is paper only during the freeze (D548) |
| V3-57 → V3-19 → V3-28 | 29 | the only code path into 3.0 that can start today |
| V3-47 → V3-48 → V3-18 → V3-20 → V3-71 | 26 | starts with a sandbox nobody has |
| V3-25 → V3-28 | 24 | V3-25 is deferred to 1.2.0 (D550) |
| V3-42 → V3-26 | 13 | V3-26 is parked (D548) |
| V3-72 → V3-80 | 13 | docs; V3-80 also needs V3-22 |
| V3-38 → V3-22 → V3-80 | 10.5 | the release path |
| V3-13 → V3-20 → V3-71 | 10 | V3-20 also waits for V3-18 and V3-19 |

**Finding: V3-20 is the most over-constrained row.** It waits for V3-13,
V3-18 and V3-19 — a Data Center refactor, a fixture split that needs a live
recording, and the write-pipeline rewrite. None of its three dependencies is
needed to split a decision ledger into files. The dependency list was written
to avoid merge conflicts in `docs/DECISIONS.md` and `docs/CORNER-CASES.md`
while those rows append to them; it would be cheaper to run V3-20 first and
let the three rows append to the new per-file layout.

**Finding: V3-71 inherits that.** It is a 3 h docs row that cannot start
until V3-20 and V3-69 are done, which puts the user-docs clean-up behind 26 h
of unrelated work.

## 2. Parallel lanes and ownership conflicts

Rows that share a file in *Owns* cannot run in parallel branches without a
merge. Among the 28 todo rows the overlaps are:

| Shared file | Rows | Resolution |
|---|---|---|
| `src/mcp/server.ts` | V3-19, V3-42, V3-62, V3-66 | serial, in that order (the roadmap already chains them) |
| `eslint.config.js` | V3-13, V3-55, V3-59, V3-61 | append-only rule blocks; rebase, no conflict expected |
| `.github/workflows/ci.yml` | V3-74, V3-75, V3-77 | serial behind V3-74 (already chained) |
| `src/mcp/write-mode.ts` | V3-19, V3-42 | chained |
| `src/mcp/project-scope.ts` | V3-57, V3-19 | chained |
| `src/mcp/registry.ts` | V3-58, V3-19 | **not chained**: run V3-58 first, it is 3 h and ready |
| `src/index.ts` | V3-62, V3-69 | small edits in both; rebase |
| `src/tools/meta.ts` | V3-65, V3-71 | V3-65 is on hold anyway (section 3) |
| `docs/CONFIGURATION.md` | V3-42, V3-71 | append-only doc; rebase |
| `docs/DECISIONS.md` | V3-20, V3-81 | V3-81 is one row; land it before V3-20 |
| `docs/RELEASING.md` | V3-73, V3-76 | chained |

With those orderings, five lanes can run at once without touching each
other's files:

| Lane | Rows in order | Hours | Starts |
|---|---|---|---|
| A. Safety core | V3-58 → V3-57 → V3-19 → V3-61 → V3-62 → V3-66 → V3-42 | 26 | now |
| B. Errors and ports | V3-55 → V3-60 | 6 | now |
| C. CI | V3-74 → V3-75 → V3-77 | 6.5 | now; V3-77's settings part is the owner's |
| D. Docs | V3-81 → V3-69 → V3-70 → V3-72 | 15.5 | now; V3-72 wording is reviewed by the owner |
| E. Release | V3-38 → V3-22 → V3-73 → V3-76 → V3-80 | 15 | owner |

Lane A is the critical path for everything architectural; lanes B–D are
fillers that never block it. The Data Center lane (V3-13 → V3-59, V3-67) is
deliberately absent: see V3-27 in section 4.

**Finding: a lane without a worktree is a lane that will not run.** On
2026-11-06 the only worktree in `~/Development/_branches/` was
`jira-mcp-v3-55`, idle since 2026-10-31. By the morning of 2026-11-07 it was
gone and lane A had started in another session: `jira-mcp-v3-57` holds two
unmerged commits that finish V3-57, and `jira-mcp-v3-58` sits clean on `main`.
Lanes B, C and D still have none, and V3-55 lost its worktree without landing.

## 3. Freeze compatibility, row by row

Four decisions constrain the todo rows: D547 (the release ships from `main`,
not from a branch), D548 (feature freeze: no new tools, packages or
tool-input fields; docs, tests, security fixes, release-lane rows and
Atlassian-forced changes are allowed), D549 (Data Center frozen; no new DC
behaviour or DC-only arguments) and D550 (nothing in 1.1.0 changes
`tools/list`; the listing changes of V3-25 move to 1.2.0). D548 neither lists
nor forbids internal refactors; they do not change the surface, and the
roadmap's priority order already treats them as allowed, so this table does
too.

| Row | What it changes | D548 | D549 | D550 | Verdict |
|---|---|---|---|---|---|
| V3-13 | moves DC twins into a directory | refactor | allowed, but wasted if DC is removed | — | **wait for V3-27** (2026-12-31) |
| V3-18 | splits the fake Jira | tests | — | — | compatible; blocked by V3-48 |
| V3-19 | write gate as middleware | refactor, safety core | — | no listing change | compatible |
| V3-20 | docs split | docs | — | — | compatible |
| V3-22 | the release | release lane | — | — | owner |
| V3-42 | `JIRA_WRITE_CONFIRM` elicitation | a new setting, security feature, no tool input | — | no listing change | compatible by the letter; **owner to confirm** it counts as security work |
| V3-55 | one error constructor | refactor | — | — | compatible |
| V3-57 | split `createProjectScope` | refactor | — | — | compatible |
| V3-58 | signal binding, abort contract test | refactor and tests | — | — | compatible |
| V3-59 | lint and compiler strictness | tooling | depends on V3-13 | — | compatible once V3-13 lands or the dependency is dropped |
| V3-60 | port owns DTO types | refactor, type-only | — | — | compatible |
| V3-61 | one SDK import module | refactor | — | — | compatible |
| V3-62 | process vs session `buildServer` | refactor | — | — | compatible |
| V3-64 | paging facts in every paged description | descriptions are listed | — | **changes `tools/list` bytes** | **after the 1.1.0 tag**; re-baseline the surface budget in the same row |
| V3-65 | `order` argument, key-or-id project arguments | **new tool-input fields** | — | changes `tools/list` | **hold until the freeze ends**, or an explicit exception |
| V3-66 | `projectKey` completions from a cache | a completion, not a tool or input | — | not `tools/list` | compatible |
| V3-67 | DC `serverInfo` version gate | — | **new DC behaviour** | — | **hold** (D549); also needs V3-13 |
| V3-69 | troubleshooting doc, `docUrl()` helper | docs plus a helper | — | — | compatible |
| V3-70 | admin overview and auth docs | docs | — | — | compatible |
| V3-71 | audience-split doc map, IDs out of runtime strings | docs plus error text | — | descriptions were cleaned by V3-36 | compatible |
| V3-72 | positioning, README hero | docs | — | — | compatible; owner reviews wording |
| V3-73 | publish pipeline v2 | release infrastructure | — | — | compatible; needs V3-38 |
| V3-74 | audit as a CI job with an allowlist | CI | — | — | compatible |
| V3-75 | tarball smoke, SDK lower bound | CI | — | — | compatible |
| V3-76 | plugin pin window | release infrastructure | — | — | compatible |
| V3-77 | CI, coverage, Dependabot hygiene | CI | — | — | compatible; settings part is the owner's |
| V3-80 | Discussions, metrics script, two plugin skills | reach; the skills are plugin files, not server tools | — | — | compatible after V3-22; toggles are the owner's |
| V3-81 | supply-chain criteria as a D-row | docs | — | — | compatible; V3-16 already meets the criteria |

Three rows are held by a decision (V3-13, V3-65, V3-67), one is held by the
tag (V3-64), one needs a word from the owner (V3-42). The other 23 todo rows
are compatible with every freeze as written.

## 4. Owner-decision register

Each entry names the decision, the date if one exists, and what happens if
nothing is decided. The default is what the ledger already says, or the state
of the world if the ledger is silent.

| # | Decision | Row | Due | Default if silent |
|---|---|---|---|---|
| 1 | Replace D547's passed date: push `main`, tag 1.1.0, publish; skip or run the `beta` candidate | V3-22 | was 2026-11-01 | nothing ships; `latest` keeps the removed agile routes |
| 2 | Register the npm trusted publisher, prove one OIDC publish, delete `NPM_TOKEN`, revoke it, rotate the API token pasted in chat | V3-38 | — | the token path keeps working; a long-lived secret stays live |
| 3 | Check one agile route on a real Cloud site to learn whether 1.0.0 is already broken | V3-21 | — | the exposure stays unknown |
| 4 | Grant the sandbox permission for Gate C (O-2) | V3-47 | overdue | live proof stays at 40 of 82 tools; V3-48, V3-18 never start |
| 5 | Run the one-day Data Center eval-host spike, or accept the default | V3-27 | 2026-12-31 | DC deprecated in 2.x, removed in 3.0 (D549) |
| 6 | Start distribution, which starts the 45-day usage clock | V3-23 | — | the D548 freeze never ends |
| 7 | Allow V3-65 as a freeze exception, or leave it parked until the clock runs out | V3-65 | — | parked |
| 8 | Confirm that V3-42 counts as security work under D548 | V3-42 | — | the agent treats it as compatible and proceeds after V3-19 |
| 9 | Approve the Cloud schema change that drops `username` | V3-63 | — | blocked; D550 moves any listing change to 1.2.0 anyway |
| 10 | Approve the scope of the 2.0 cleanup paper | V3-24 | — | paper only; the 32 h chain to 3.0 does not start |
| 11 | Review the positioning wording; flip the Discussions toggle | V3-72, V3-80 | after V3-22 | docs rows stall at review |
| 12 | Repository hygiene: delete `oauth-3lo`, close PR #7, rebase or close PRs #20, #22, #23, start or remove the idle worktree | — | — | stale items accumulate |
| 13 | Tooling baseline: `.nvmrc` says 24, the gate here ran on Node 22.23.2, `engines` says `>=22`; decide which Node CI pins | — | — | CI and local differ by a major |
| 14 | TypeScript 7.0.2 and `@types/node` 26 are new majors with no row; the open Dependabot PR still targets 6.0.3, which `main` already has | — | — | the majors wait; no breakage today |

Items 1–3 take under an hour together and remove the only critical risk.
Items 4–6 each start a chain the agent cannot start alone.

## 5. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | 1.0.0 on `latest` reads sprints and backlogs from routes CHANGE-3193 removes | unknown; unverified | every install loses eight agile tools and the delete rehearsal | push, CI, tag (register 1); check one route (register 3) | owner |
| R2 | 74 commits have never run in GitHub Actions; the Docker buildx job and the publish workflow changes are untested there | medium | a red first run delays the tag by the fix time | push before tagging and read the run; the gate is green locally | owner |
| R3 | 42 of 82 tools are unproven live; the software root and the D525 fallback are unproven too (a 403 was reported) | high | defects fixtures cannot find; past live runs found 3–4 each | read-only `verify-live.mjs` over Basic auth, then O-2 | owner |
| R4 | A bootstrap `NPM_TOKEN` and a pasted API token are live | certain | a leaked token publishes under the package name | register 2 | owner |
| R5 | The ledger still states a passed date (D547) and the roadmap cites it | certain | readers trust a plan that did not happen | one owner D-row with the new date | owner |
| R6 | Data Center is frozen with a removal default; V3-13, V3-59 and V3-67 depend on its fate | medium | 12 h of refactoring wasted if DC goes | hold the DC lane until V3-27 | agent |
| R7 | Owner bottleneck: 9 rows and 53 h wait for the owner or a sandbox, plus every release step | certain | the backlog narrows to refactors | batch items 1–6 of the register into one owner session | owner |
| R8 | `project-scope.ts` sits at 78.00 % mutation score, exactly on the break line | medium | any touch can turn the mutation job red | V3-57 splits it; add tests before moving code | agent |
| R9 | V3-64 changes every paged description, so the surface-budget test (tolerance 2 %) breaks | certain when run | a red gate until re-baselined | re-baseline in the same row, after the tag (D550) | agent |
| R10 | Dev dependencies carry 18 moderate advisories (minimatch, glob, qs chains via eslint, Stryker, c8, typescript-eslint); production audit is clean | certain | noise that hides a real finding | V3-74's expiring allowlist | agent |
| R11 | TypeScript 7 and `@types/node` 26 majors have no row | low | a forced upgrade later costs more | a row in the type-safety lane | agent |
| R12 | Three Dependabot PRs and one stale PR wait on a branch that is 74 commits behind | certain | red PR checks after the push | rebase after the push (register 12) | owner |
| R13 | Two type-only modules report 0 % coverage (section 7), so a per-file floor (V3-77) would fail on files with no statements | certain when V3-77 lands | a red gate for the wrong reason | exclude or import them in V3-77 | agent |

## 6. Modularity: the six largest files without a split row

The state analysis found 13 source files over 1000 lines and noted that none
of the five largest has a roadmap row. Six were read in full: the five largest
plus `cli/login.ts`, which shares helpers with `cli/doctor.ts`. (`api/agile.ts`
and `api/adf.ts` were left out: the first changed in V3-29 and V3-52 and is
the most likely to change again under CHANGE-3193; the second is one
self-contained parser.) None of the six holds module-level mutable state; all
state is closure-local. The eslint zones are directory-prefix rules, so a
sub-directory inherits its layer without an eslint change. `tools/` and `cli/`
are composition roots with no zone.

| File | Lines | Exports | Proposed sub-directory | Modules | Pure move | Hours |
|---|---|---|---|---|---|---|
| `src/cli/doctor.ts` | 2197 | 16 | `src/cli/doctor/` | 12 | mostly; the 465-line `PROBES` literal must be lifted into named constants | 4.5 |
| `src/api/collab.ts` | 1947 | 81 | `src/api/collab/` | 10 | yes | 4 |
| `src/core/oauth.ts` | 1689 | 45 | `src/core/oauth/` | 10 | yes | 3.5 |
| `src/tools/issues-delete.ts` | 1554 | 23 | `src/tools/issues-delete/` | 10 | yes, plus one test scanner made recursive | 3 |
| `src/api/meta.ts` | 1395 | 59 | `src/api/meta/` | 10 | yes; fixes a mislabelled section for free | 3 |
| `src/cli/login.ts` | 1214 | 16 | `src/cli/login/` | 9 | yes; `run()` stays a 368-line function | 2.5 |

Total about 20.5 h in six independent work packages with disjoint file
ownership. Each keeps the old path as a barrel, so no test file moves and no
importer changes; the test twins (2577, 1708, 2094, 2367, 1155 and 1711 lines)
stay where they are.

**Proposed cuts.**

- `cli/doctor/`: `report` (exit codes, finding and report types), `host`
  (filesystem and prompt seams), `args`, `format`, `render`, `context` (probe
  context and finding constructors), `findings`, `probes-oauth`,
  `probes-network`, `probes` (the probe table and runner), `save` (the
  `--save` logic, today split across two distant regions of the file), `run`.
- `api/collab/`: `paths`, `options` (20 option types), `results` (18 result
  types), `input` (validators and remediation text), `errors` (the shared
  call wrapper), `shape` (response mappers), `read` (9 reads), `datacenter`
  (4 DC twins), `write` (8 writes), `deletes` (4 deletes).
- `core/oauth/`: `constants`, `guards`, `pkce`, `authorize`, `sites`, `tokens`,
  `store`, `endpoint`, `resolver`, `client-credentials` — the same shape
  `core/settings/` took in V3-11.
- `tools/issues-delete/`: `annotations`, `before-types` (17 interfaces),
  `before` (19 builders), `results`, `args`, `delete-issue`, `delete-links`,
  `delete-project`, `bulk`, `package`.
- `api/meta/`: `paths`, `options`, `results`, `input`, `shape`, `projects`,
  `fields`, `create-meta`, `catalogue`, `datacenter`. The seven catalogue
  reads today sit under a header that calls them Data Center twins; the move
  corrects that.
- `cli/login/`: `exit-codes`, `constants`, `args`, `options`, `format`,
  `loopback`, `browser`, `login`, `logout`.

**Cross-file findings, verified on `main`.**

- `readId`, `readBoolean` and `trimmed` are byte-identical in `api/collab.ts`,
  `api/meta.ts` and `api/filters.ts`. They belong in `api/guards.ts` (V3-56's
  module) and in the once-only list of `src/testing/helper-dupes.test.ts`.
  A dedupe is not a pure move, so it is its own small work package and should
  land before the collab and meta splits.
- `unit`, `octal` and `quote` are byte-identical in `cli/doctor.ts` and
  `cli/login.ts`; one shared `src/cli/format.ts` beats two copies.
- `pathSegment` and `classicPage` look shared between collab and meta but have
  different contracts (one trims, one requires text; one reads a fixed key,
  one takes a key and its own error text). Unifying them changes error
  messages, so they stay separate.
- The OAuth predicates cannot move to `api/guards.ts`: `core` is layer 0 and
  may not import `api`. A `core/guards.ts` is the only consolidation route.
- `src/tools/port-boundary.test.ts` lists `src/tools/` non-recursively, so a
  `src/tools/issues-delete/` directory would escape its api-import check until
  the scanner recurses. The other directory scanners
  (`safe-allowlist`, `helper-dupes`, `threat-model-drift`) already recurse.
- Both `collab/datacenter.ts` and `meta/datacenter.ts` are cut as the units
  V3-13 would later move into `src/api/datacenter/`. Sequence the splits
  before V3-13, or let V3-13 own the sub-directory files; the DC lane is on
  hold until V3-27 either way.

**Recommendation.** Add six rows in the type-safety and architecture lane,
one per file, each a pure move with its barrel, plus a seventh for the
`api/guards.ts` dedupe that precedes two of them. None changes the surface,
so all are freeze-compatible. Order by value to agents working in the files:
`issues-delete` (the test twin is the largest in the repo), `collab`, `meta`,
then `oauth`, `doctor`, `login`.

## 7. Coverage below the floors, per file

The gate floors are global (97 % statements, 94 % branches, 98 % functions)
and the totals clear them (97.44 / 95.01 / 98.11). V3-77 proposes per-file
floors; this is the list it would have to pass. Files at or above every floor
are omitted.

| File | Statements | Branches | Functions | Note |
|---|---|---|---|---|
| `src/api/issues/write-types.ts` | 0.00 | 0.00 | 0.00 | type-only, 213 lines, no runtime declarations |
| `src/core/http/context.ts` | 0.00 | 0.00 | 0.00 | type-only, 115 lines, no runtime declarations |
| `src/tools/portfolio-render.ts` | 95.23 | 78.18 | 100 | lowest real branch coverage |
| `src/core/http/slots.ts` | 90.00 | 82.35 | 100 | lowest statement coverage |
| `src/tools/users.ts` | 100 | 84.61 | 100 | |
| `src/api/wiki.ts` | 100 | 86.04 | 100 | |
| `src/api/issues/time.ts` | 98.99 | 86.66 | 100 | |
| `src/mcp/exports.ts` | 100 | 86.66 | 100 | |
| `src/tools/index.ts` | 98.36 | 88.46 | 100 | |
| `src/core/env-lock.ts` | 94.60 | 88.63 | 100 | below the statement floor too |
| `src/tools/portfolio.ts` | 96.93 | 88.88 | 100 | |
| `src/api/issues/changelog.ts` | 100 | 89.39 | 100 | |
| `src/tools/sprint-summary.ts` | 98.83 | 89.43 | 100 | |
| `src/core/http/budget.ts` | 100 | 90.00 | 100 | |
| `src/tools/search.ts` | 100 | 90.24 | 100 | |
| `src/cli/login.ts` | 98.27 | 90.72 | 86.48 | the only file below the function floor |
| `src/mcp/project-scope.ts` | 99.64 | 90.88 | 100 | also the weakest mutation score (section 5, R8) |
| `src/tools/attachments.ts` | 97.60 | 91.42 | 100 | |
| `src/api/issues/issue-links.ts` | 100 | 91.66 | 100 | |
| `src/mcp/errors.ts` | 100 | 91.66 | 100 | |
| `src/api/issues/errors.ts` | 100 | 92.85 | 100 | |
| `src/core/http/quota-hold.ts` | 100 | 92.85 | 100 | |
| `src/tools/prompts.ts` | 100 | 93.10 | 100 | |
| `src/core/http/failures.ts` | 100 | 93.33 | 100 | |
| `src/mcp/transport-http.ts` | 97.18 | 93.60 | 100 | |
| `src/tools/issues-write.ts` | 99.86 | 93.81 | 100 | |
| `src/tools/portfolio-analysis.ts` | 99.61 | 95.17 | 96.77 | below the function floor only |

27 of 138 source files miss at least one floor; 25 of them miss only the
branch floor. The two type-only files are never loaded at runtime (their
imports are erased), which is why c8 reports zero rather than nothing;
V3-77 should exclude them or import them from one test. The portfolio
renderer and `slots.ts` are the two files where a few targeted tests would
move the global branch number most.

## 8. What this changes in the plan

Nothing in the roadmap file is rewritten by this report; it proposes, the
owner disposes. The concrete proposals, in order of value:

1. Register items 1–3 (push, tag, route check) are the whole critical path.
2. Lane A (V3-58 → V3-57 → V3-19 …) is the only architectural chain that
   can start today and reaches 3.0; it has started (V3-57 is done on its
   branch, V3-58 has a worktree). Keep it moving into V3-19.
3. Run V3-20 before, not after, its three listed dependencies; add the
   `api/guards.ts` dedupe and six split rows in the type-safety lane; add a
   row for the TypeScript 7 and `@types/node` 26 majors.
4. Hold V3-13, V3-59 and V3-67 together as the Data Center lane until V3-27.
5. Land V3-64 only after the 1.1.0 tag; leave V3-65 parked under D548.

## Postscript, 2026-11-07 evening

After this report was written, `main` was pushed to `988b7df` from another
session. The first step of register item 1 is therefore done, and R2 is now
being tested by the first Actions run on those 74 commits. The tag, the
publish, the route check and every other item in the registers are still open.
