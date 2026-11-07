# State analysis — 2026-11-06

A measured snapshot of `main` at `8de2d0f`, one week after the role panel
(`2026-10-29-role-panel.md`). It answers three questions: what is true now,
what is blocked and by whom, and what to do next. Source has not changed since
2026-10-31. Every number below was measured on 2026-11-06 unless its row says
otherwise. No live tenant was touched.

## Verdict

The code is in good shape and the release is not. All of 1.1.0 is written, and
everything left before it ships is an owner act. The D547 deadline passed five
days ago with neither the tag nor the `beta` fallback out, and `main` is 74
commits ahead of `origin/main`, so those commits have never run in GitHub
Actions. More refactoring adds nothing until 1.1.0 is out.

## Baseline

| Measure | Value | Change since the panel (2026-10-29) | Source |
|---|---|---|---|
| Published | `jira-mcp-ai` 1.0.0 (`latest`), 58 tools | unchanged | npm registry |
| `main` | 82 tools (42 reads, 40 writes) in 11 packages | unchanged | `src/tools/manifest.snapshot.json` |
| Unpushed | 74 commits over `origin/main` at `c07d4b6` | new | `git log` |
| Tests | 3516 pass, 114 suites, 0 failures | +572 | gate on `8de2d0f`, 2026-11-01 |
| Coverage | 97.44 % statements, 95.01 % branches, 98.11 % functions (floors 97/94/98) | branches +0.66 pp | same gate |
| Corner cases | 928 `CC-nn` ids | +185 | `docs/CORNER-CASES.md` |
| Decisions | 194 `D` rows | — | `docs/DECISIONS.md` |
| Source | 138 files, 56.5k lines | +3.5k | `src/` |
| Tests, by size | 116 files, 78.7k lines | — | `src/` |
| Mutation score, safety core | 80.82 % (break at 78) | new | `2026-10-30-mutation-baseline.md` |
| Live proof | 40 of 82 tools, last run on the 0.9.4 surface | unchanged | `docs/RELEASING.md` |
| npm downloads | 19 in the week to 2026-11-05; 87 from 2026-10-01 to 11-05 | down from about 52/week | npm downloads API |
| `npm audit --omit=dev` | 0 vulnerabilities | unchanged | same gate |

## 1. Release risk — critical

**State.** V3-22 (D547) was due before 2026-11-01. The rule was: tag by then,
or put `1.1.0-rc.1` on `beta` and ship 1.1.0 within a week. Neither happened.

**Exposure.** 1.0.0 on npm reads sprint issues and backlogs from
`/rest/agile/1.0`. CHANGE-3193 removes those routes around 2026-11-01, and D547
says every 1.0.0 install then fails those reads.

**What is not known.** Whether the routes are gone today. `docs/JIRA-API.md`
marks the date unconfirmed. A fetch of Atlassian's public Jira Software Cloud
changelog (<https://developer.atlassian.com/cloud/jira/software/changelog/>) on
2026-11-06 and one web search found no entry for CHANGE-3193 or RFC-127. That
is weak evidence: it proves neither that the removal was postponed nor that it
happened. One authenticated `GET /rest/agile/1.0/sprint/{id}/issue` against any
Cloud site settles it in a minute.

**What can go out today.**

| Check | Result |
|---|---|
| Push to `main` | allowed; the ruleset only forbids force-push and deletion |
| `v*` tag | admin only, immutable once created |
| `release` environment | required reviewer, so the publish needs a human click |
| Credential | `NPM_TOKEN` is still in GitHub secrets and `publish.yml` falls back to it |
| Actions on these 74 commits | never run; last green CI on `main` is for `c07d4b6` |

**Finding: V3-22 and D547 disagree.** The roadmap row lists V3-38 as a
dependency, but D547's order does not, and V3-38's npm half is not done. The
token path still works, so V3-38 does not block the publish technically.

**Recommendation.** Push `main`, wait for CI, and tag 1.1.0 if it is green. Skip
the release candidate: `beta` does nothing for installs that follow `latest`,
and the fallback's one-week window has already closed. Move to OIDC right after.
V3-21 stays a follow-up, because the D525 fallback makes 1.1.0 correct on both
sides of the removal.

## 2. Roadmap — what can actually move

81 rows: 40 done, 28 todo, 6 blocked-owner, 3 blocked-external, 2 parked,
1 deferred, 1 partial. Done rows hold 116.5 h, todo rows 98.5 h, blocked rows
53 h. The 28 todo rows split like this:

| Group | Rows | Hours |
|---|---|---|
| Ready, no conflict: code | V3-55, V3-57, V3-58, V3-60, V3-74 | 14 |
| Ready, no conflict: docs | V3-69, V3-70, V3-72, V3-81 | 15.5 |
| Ready, but a decision is in the way (section 3) | V3-13, V3-64, V3-65 | 9.5 |
| Follow a ready row | V3-19, V3-42, V3-61, V3-62, V3-66, V3-71, V3-75, V3-77 | 27.5 |
| Need the release or V3-38 | V3-22, V3-73, V3-76, V3-80 | 13 |
| Need Gate C or the Data Center decision | V3-18, V3-20, V3-59, V3-67 | 19 |

Three chains matter:

- **Longest code chain:** V3-57 (3) → V3-19 (6) → V3-42 (7), 16 h. V3-19 also
  opens V3-61 and V3-62 → V3-66.
- **Owner chain:** O-2 → V3-47 → V3-48 → V3-18 → V3-20. Nothing here starts
  without a sandbox, and V3-20 cannot close without it.
- **Distribution chain:** V3-22 → V3-23 → 45 days → end of the D548 freeze. If
  V3-23 landed today the freeze could end on 2026-12-21 at the earliest.

**Finding: the priority order was inverted.** ROADMAP put refactors in step 4,
behind the release. V3-10…V3-12, V3-14, V3-54 and V3-56 landed first while step 1 stood
still. Each was reasonable alone, but they widened the unpushed diff and did
nothing for the deadline.

## 3. Decisions in conflict with ready rows

| Row | Decision | Conflict | Recommendation |
|---|---|---|---|
| V3-65 | D548 | Adds tool inputs during the feature freeze | Hold until the freeze ends |
| V3-13 | D549 | A refactor, so allowed, but it is wasted if Data Center is removed | Wait for V3-27, due 2026-12-31 |
| V3-67 | D549 | A new Data Center behaviour, and DC is frozen | Hold; also needs V3-13 |
| V3-64 | D550 | Edits tool descriptions, and nothing in 1.1.0 may change `tools/list` | Land after the 1.1.0 tag |
| V3-22 | D547 | Row dependency on V3-38 is not in the decision | Owner to confirm (section 1) |

D549 also has a date attached: the one-day eval-host spike must run by
2026-12-31 or the default applies and Data Center is deprecated in 2.x.

## 4. Code health

Strong and enforced: layering in eslint, 0 `@ts-ignore`, 4 `as unknown as`,
6 `eslint-disable` (5 of them for control-character regexes), and no real TODOs.
The `TODO` grep hits are Jira's status-category string.

| Measure | Value | Roadmap coverage |
|---|---|---|
| Files over 1000 lines | 13: `cli/doctor` 2197, `api/agile` 2045, `api/collab` 1947, `api/adf` 1767, `core/oauth` 1689 | **None of the five largest has a split row** |
| `mcp/project-scope.ts` | 834 lines, the weakest mutation score in the safety core (78.00 %, 192 survivors) | V3-57 |
| `mcp/write-mode.ts` | 1256 lines, 82.77 %, 116 survivors | V3-19 |
| Direct `new JiraError(` | 42 sites in 16 files, 12 of them in `core/http-util.ts` | V3-55 |
| `tools` files importing from `api` | 13 | V3-60 |
| `tools` files that mention `signal` | 2 | V3-58 |
| Files importing the MCP SDK | 9, all in `mcp/` | V3-61 |

V3-58 is the best next code row. Cancellation is the one gap here that users
can feel, and it depends on nothing. V3-55 is mechanical and its worktree
already exists, unused.

**Dependencies.** Inside the semver range and behind: MCP SDK 1.32.1 (1.32.2),
eslint, prettier, typescript-eslint. TypeScript 7.0.2 is a new major and needs
its own row. Nothing is urgent.

## 5. Proof gap

| | Proven live | On `main` | Share |
|---|---|---|---|
| Reads | 27 | 42 | 64 % |
| Writes | 13 | 40 | 33 % |
| All tools | 40 | 82 | 49 % |

The 40 are also stale: the newest proof is from the 0.9.4 surface, and V3-01
has since moved the sprint and backlog reads to another API root. No live run
is recorded for `JIRA_PROJECTS` either.

The 42 unproven tools are the largest quality risk left, and past live runs
each found 3–4 defects that no fixture could. All of it waits on O-2, which is
overdue. Before release, `verify-live.mjs` in its read-only form over Basic auth
is the cheapest useful step: it needs no new permissions and closes part of
V3-21.

## 6. Usage

Downloads are low and falling: 19 in the last week against about 52 at the
panel, on a package with no GitHub Release and no registry listing. The numbers
are too small to mean much, and npm counts include mirrors and CI. They do
support D548's reasoning that the surface is ahead of the users. Distribution
(V3-23) is worth more now than any further tool. Note that any `latest` user
already running sprint reads is the group most likely to hit section 1.

## 7. Documentation drift

Fixed with this analysis: the project status file, the release-progress block,
the ROADMAP priority order, the V3-22 row, the O-2 count, and the wave 6 note in
IMPLEMENTATION-PLAN.

Checked and correct, no change needed:

- The Data Center count of 48 tools (28 reads, 20 writes) in `docs/TOOLS.md` and
  ROADMAP. `DATACENTER_TOOLS` holds 48 of the 82, so the 2026-11-01 worklog
  suspicion was wrong. D549 froze this number.
- The Pages site. Its counts are generated (D526), and the 0.9.4 row is history.

Still open: D547 itself describes a date that has passed. The ledger needs the
owner's replacement decision, and this review does not invent one.

## 8. Repository hygiene

| Item | State | Recommendation |
|---|---|---|
| Worktree `_branches/jira-mcp-v3-55` | Clean, on `wp/v3-55`, no commits, since 2026-10-31 | Start V3-55 or remove it |
| Remote branch `oauth-3lo` | Stale at `de551e2` | Delete |
| PR #7, typescript 5.9.3→6.0.3 | Stale; `main` already has 6.0.3 | Close |
| PRs #20, #22, #23 | Actions group, `@hono/node-server`, minor and patch | Rebase after the push, then merge if CI is green |
| GitHub Releases | None | Create one with 1.1.0 |

## Next actions, in order

| # | Action | Owner |
|---|---|---|
| 1 | Check one agile route on a real site to learn the true exposure | Owner |
| 2 | Push `main`, read the first Actions run on these 74 commits | Owner's yes |
| 3 | Tag and publish 1.1.0, with a new date in the ledger | Owner's yes |
| 4 | Trusted publisher, delete `NPM_TOKEN`, rotate the pasted API token (V3-38) | Owner |
| 5 | Read-only `verify-live.mjs` over Basic auth, then O-2 for the full Gate C | Owner |
| 6 | V3-58, V3-74, V3-55, V3-57 in that order, 11 h | Agent, on request |
| 7 | V3-23 distribution, which starts the 45-day clock | Owner |
| 8 | Data Center spike before 2026-12-31 (D549) | Owner |
