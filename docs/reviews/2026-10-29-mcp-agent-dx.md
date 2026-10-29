# MCP & Agent-DX review — 2026-10-29

Scope: the server as an LLM agent sees it — `tools/list`, descriptions, input
schemas, annotations, `_meta` hints, server instructions, prompts, resources,
completions, the result envelope, truncation, errors and the plan/apply write
loop. I did not review the core, security or release work except where an agent
sees it. Method: I read `src/mcp/*`, `src/tools/*`, `docs/CONFIGURATION.md`,
`docs/DECISIONS.md`, `docs/ROADMAP.md` (v3 section) and `docs/ai/v3-analysis.md`.
I compiled `src` into a scratch directory, not the repo `build/`. A scratch
script built the real server with fake dependencies over an in-memory transport
and recorded `tools/list`, `prompts/list` and `resources/list` for the `core`,
`reader` and `all` profiles. All sizes below are compact-JSON character counts
from that run. Token figures use about 3.4 characters per token and are
approximate. I made no live Jira calls. I checked the spec against MCP
2025-11-25 and client behaviour against the Claude Code MCP docs: deferred tool
search, description limits, the `anthropic/*` `_meta` keys and the
output-spill thresholds.

## Verdict

| Decision | Verdict | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | CONDITIONAL GO | Remove the internal tracker IDs from model-visible descriptions (MCP-06). Replace the stale "~94k" surface figure with the measured 145k figure and land the V3-08 budget so it cannot grow unseen (MCP-01). |
| The v3 plan (ROADMAP V3-xx) | CONDITIONAL GO | Reorder to V3-08 → V3-07 → V3-05 first. Fix V3-25's `profile` trigger ("when locked", not "more than one profile"). Add a tool-selection eval (MCP-R5) before V3-24 and V3-28 change names and descriptions. |

For an agent this is one of the better Jira MCP surfaces. Descriptions start
with what the tool does and name their neighbours ("use X instead when …").
Write tools cannot apply without a plan, and their results never let a model
claim a write happened (`executed:false` plus "NOT performed — plan mode.").
Results are always valid JSON, even when truncated, and come with a resume
recipe. The weak point is cost and uniformity, not correctness. The default
`all` profile advertises 82 tools in 145,446 characters, about 34k
model-visible tokens. 41 of those tools cannot apply under the default
configuration, and about 30k characters of every input schema are repeated
control fields. Paging is spelled five different ways. Nothing blocks 1.1.0.
The v3 plan already names most of this, but it changes names and descriptions
without any way to measure whether tool selection got better or worse.

## Strengths

- **Descriptions are front-loaded and disambiguating.** `jira_get_changelog` explains when to use it instead of `expand`. `jira_get_create_meta` and `jira_list_issue_types` say which one fits which question. `jira_count` steers the model away from `jira_search` for counts. `jira_list_link_types` tells the model to read the list first "rather than guessing a link type name" (`src/tools/meta.ts`). Every tool has an example call (D124), served per tool at `jira://reference/tools/{name}`.
- **The server instructions earn their 1,420 characters.** They state live counts, the current write mode and the plan-first rule. They also cover the profile lock, users by accountId (pointing at `jira_search_users`), the reference URIs, the 10 prompt names, paging advice and the untrusted-content rule (`src/mcp/server.ts` `buildServer`, line 460). This text also helps tool search.
- **The plan/apply loop is safe for an agent.** `splitControlFields` strips `apply`, `plan_id` and `profile` before the domain handler runs. A plan returns `{executed:false, planned, plan_id}` (`src/mcp/write-mode.ts:942`), an apply is stamped `executed:true` (V3-04), and the text block leads with `PLAN_NOTICE_LINE` (`write-mode.ts:83`). Under `JIRA_WRITE_MODE=plan`, `planHintMessage` (`write-mode.ts` ~118–141) tells the model that no apply is possible and an operator must restart the server, so the model gets a reason and a next step instead of a dead end.
- **The irreversible tier works on both sides.** The client gets `anthropic/requiresUserInteraction: true` on all 11 irreversible tools (`src/mcp/client-hints.ts:28`). The server can ask for an elicitation confirm (`JIRA_IRREVERSIBLE_CONFIRM=elicit`) before applying.
- **Truncation is well designed.** `renderResult` (`src/mcp/result.ts:626`) cuts in stages: character budget, then `item_too_large`, then a floor. The JSON stays parseable at every stage. `TRUNCATED_HINT_MESSAGE` tells the model not to follow the stale cursor and to resume at `startAt + rows`. The default budget, `JIRA_MAX_RESULT_CHARS=25000` (`docs/CONFIGURATION.md:132`), stays under Claude Code's 50k-character spill-to-file threshold and its 25k-token default cap.
- **Errors are tool results, not protocol errors.** `isError` mirrors `!ok`, and the error carries a first-class `reason` (V3-04), so the model can correct itself, as MCP 2025-11-25 recommends for input-validation failures.
- **Untrusted content is tainted.** Issue text is wrapped as untrusted data in the text block, and the prompts append the same rule (D125).
- **Prompts and completions are gated.** The 10 prompts appear only when the tools they name are registered (D125). Prompt arguments are described ("Project key in capitals, e.g. PROJ."). `completion/complete` answers closed-set prompt arguments and the reference template (`src/mcp/completions.ts`, D154 stage A).
- **Large reads can go to a file.** JSONL export (`output:"file"`, D152) with a `resource_link` keeps big reads out of context.
- **Call-time enforcement is proven, not assumed** (V3-06, `306d322`). A tool that is not listed cannot be invoked.

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| MCP-01 | P1 | The default surface is 145,446 wire characters and about 34k model-visible tokens. The documented figure is stale, and there is no budget. | Measured: `all` = 82 tools, 145,446 characters (descriptions 30,792, input 80,914, output 15,990, `_meta` 604). Model-visible (name + description + input) = 116,938 characters. D124 (`docs/DECISIONS.md:135`) still says 93,722 at 59 tools. | Land V3-08 now, budgeting model-visible characters per profile and per tool. Update the D124 figure and the README. | 2 |
| MCP-02 | P1 | The default configuration advertises 41 write tools, 30 writes plus 11 irreversible, that cannot apply. The model only learns this after a plan. | Defaults are `JIRA_TOOL_PACKAGES=all`, `JIRA_WRITE_MODE=plan`, `JIRA_ALLOW_IRREVERSIBLE=false` (`CONFIGURATION.md:116,120,121`). With irreversible on or off, the list is identical (82 tools, 145,446). The 11 irreversible tools alone are 19,818 characters. | When the gate is off, omit gated-off irreversible tools. In plan-only mode, put a one-line capability prefix on write descriptions. This is the V3-25 half that can ship additively. | 3 |
| MCP-03 | P2 | The `profile` control field is in all 82 input schemas although it is locked by default. V3-25's trigger would not remove it. | `profile` costs about 12,300 characters across the surface. `JIRA_LOCK_PROFILE=true` (`CONFIGURATION.md:107`). The instructions say "omit it". V3-25 says "only when there is more than one profile", but there are always 3 (`src/mcp/types.ts:445`). | Emit `profile` only when the profile is not locked, and keep accepting it at call time. Reword V3-25. | 2 |
| MCP-04 | P1 | Paging is spelled five ways, and `maxResults` has three caps plus one undocumented cap. | See the detailed table in MCP-04 below. | 1.x: document cap and continuation in every paged description (V3-05 plus a doc pass). 2.0: one `paging` block (V3-24). | 3 |
| MCP-05 | P1 | There is no tool-selection eval. V3-07, V3-24 and V3-28 rewrite names and descriptions without a signal. | No eval directory exists. Tests check schema shape and size, not "which tool does a model pick". Claude Code's tool search matches description starts, so wording is selection-critical. | Add a deterministic eval: about 40 golden task → expected-tool pairs, scored by simulated description-start search. Add an optional model-in-the-loop tier that the owner can run. | 5 |
| MCP-06 | P2 | Internal tracker IDs leak into model-visible text. | `jira_update_comment`: "CC-31 REPLACE semantics …". `jira_list_link_types`: "… budget cut it (CC-253)." | Strip them. Add a test that rejects `/\b(CC\|D\|V3)-\d+\b/` in descriptions and argument descriptions. | 1 |
| MCP-07 | P2 | There is no reversible batch write. Relabelling 40 issues costs 81 calls or needs the irreversible tier. | `jira_bulk_edit_issues` sits in `issues-delete` (`src/tools/issues-delete.ts:1457`) and needs `JIRA_ALLOW_IRREVERSIBLE` plus site "Make bulk changes". Otherwise it is 40 × (`jira_update_issue` plan + apply). Bulk transition and bulk move are "Considered and parked". | Owner decision: a capped (≤50) reversible batch update under one `plan_id`. | 6 |
| MCP-08 | P2 | Discovery under deferred tool search is weak. There is no `alwaysLoad`, descriptions are not uniformly keyword-first, and some names put the noun first. | No `anthropic/alwaysLoad` in `client-hints.ts`. Examples: `jira_sprint_summary`, `jira_portfolio_*`. V3-07 covers only about 4 tools. | Do V3-07, then apply the keyword-first rule to all 82 descriptions with a lint. Keep renames for V3-24. | 2 |
| MCP-09 | P3 | Data Center-only arguments appear on a Cloud deployment. | `usernameArg`: "Jira Data Center only: the user's username …" (`src/tools/collab.ts:173-177`), on watcher and assign tools. | When `JIRA_DEPLOYMENT=cloud`, drop DC-only properties from the emitted schema. | 2 |
| MCP-10 | P3 | `jira_get_changelog` returns history oldest first. "What changed recently" takes two calls. | The model reads `data.total`, then calls again with `startAt = total - n`. | Add `order: "newest"`, or document the two-call recipe in the description. | 1.5 |
| MCP-11 | P3 | Project identifiers are asymmetric: some tools take a numeric `projectId`, others a key. | `jira_list_statuses` "is the NUMERIC id, not the key" (`src/tools/meta.ts:524`). `jira_create_version` also takes `projectId`, while `jira_create_component` takes a key. | Accept a key or an id and resolve server-side (additive). | 2 |
| MCP-12 | P3 | `jira_bulk_edit_issues` lives in package `issues-delete`. | `src/tools/issues-delete.ts:1457`. `JIRA_PACKAGES_DENY=issues-delete` silently removes bulk edit. | 1.x: document it in CONFIGURATION. 2.0: move it to an `issues-bulk` package (V3-24). | 0.5 |
| MCP-13 | P3 | The same operation is spelled differently across tools. | Unassign: `unassign:true` (`jira_assign_issue`) vs `assigneeAccountId:null` (`jira_update_issue`). Labels: `labelsAdd`/`labelsRemove` vs `labels` + `labelsAction` (bulk edit). | Fold into V3-24's rename table. | 0 |
| MCP-14 | P3 | Completions do not cover live keys. | `src/mcp/completions.ts:12-14`: "Live values — projects, versions, sprints — are stage B and are not built." | D154 stage B: project-key completion from a cached `jira_list_projects` read, TTL-bound. | 2 |
| MCP-15 | P3 | The generic `outputSchema` adds 16k wire characters and gives no typing value. | `ENVELOPE_OUTPUT_SCHEMA` (195 characters) is identical on all 82 tools (`src/mcp/server.ts:155`, D131). The Anthropic tool format does not carry `outputSchema`, so Claude never sees it. | Keep it for spec conformance. Do not grow it in 1.x. Measure wire and model-visible sizes separately in V3-08. | 0 |

## Detailed findings

### MCP-01 — Default surface is 145k characters; the budget figure is stale

**What.** Measured sizes:

| Profile | Tools | Wire characters | Model-visible characters | Approx. tokens |
|---|---|---|---|---|
| `all` | 82 | 145,446 | 116,938 | ≈34k |
| `reader` | 34 | 49,872 | 38,284 | ≈11k |
| `core` | 3 | 3,923 | 2,874 | ≈0.8k |

Model-visible size per package (characters):

| Package | Chars | Package | Chars |
|---|---|---|---|
| issues-write | 23,290 | meta | 8,403 |
| agile | 20,105 | portfolio | 4,322 |
| collab | 17,921 | attachments | 3,378 |
| issues-delete | 15,517 | core | 2,874 |
| issues | 10,698 | users | 1,814 |
| search | 8,616 | | |

The largest tool is `jira_update_issue`: 3,710 characters, 2,896 of them input schema. Next come `jira_create_issue` (3,196), `jira_bulk_edit_issues` (2,958) and `jira_update_comment` (2,946). The smallest is `jira_list_resolutions` at 900.

**Evidence.** D124 (`docs/DECISIONS.md:135`) records 107,073 → 93,722 characters at 59 tools. `docs/ai/v3-analysis.md` says "145 KB ≈ 36–40k tokens", which agrees with the wire size.

**Why it matters.** Claude Code defers MCP tools behind tool search by default, so the full cost lands only with `ENABLE_TOOL_SEARCH` off or under `auto` below the 10% threshold. Other clients pay it on every turn. Cursor has historically capped at about 40 tools; 2026 sources conflict on whether that cap is still enforced. VS Code applies a per-request tool limit (128, from memory). With 82 tools, the default `all` profile is over the Cursor figure.

**Recommendation.** Land V3-08 now; its dependency V3-01 is done. Budget the model-visible characters (name + description + input schema) per profile, and the per-tool total. Record the wire size separately. Update D124 and say in the README which profile or package set suits a tool-capped client: `reader` is 34 tools.

**Acceptance.**
- `src/mcp/surface.test.ts` fails when any profile grows more than 2% over `test/surface-budget.json`, or when any tool exceeds a cap of about 4,000 characters.
- The README states the measured figure for each profile.

### MCP-02 — 41 write tools are listed by default and can never apply

**What.** Under the defaults (`all` / `plan` / irreversible off), the model sees 30 writes and 11 irreversible tools. The two settings that control them behave differently:
- `JIRA_ALLOW_IRREVERSIBLE` does not change `tools/list`. The run with it set to `true` produced the same 82 tools and the same 145,446 characters.
- `JIRA_WRITE_MODE=plan` does not change any description.

**Why it matters.** A model asked to "close this sprint" picks `jira_close_sprint`, gets a plan, and only then reads in `planHintMessage` that no apply is possible. That costs one wasted call and some user confusion. The irreversible tools also cost 19,818 characters, about 17% of the model-visible surface, for tools that are refused by configuration.

**Recommendation.** First, do not register an irreversible tool when `JIRA_ALLOW_IRREVERSIBLE=false`. V3-06 already proves that call-time refusal does not depend on the listing. Second, in plan-only mode, prefix write descriptions with "Plan-only on this server: returns a plan, cannot apply." The server instructions already state the mode; the description is what tool search matches. This is part of V3-25, but it is additive in effect: the hidden tools could not succeed anyway.

**Acceptance.**
- With the defaults, `tools/list` holds 71 tools.
- With `JIRA_ALLOW_IRREVERSIBLE=true`, it holds 82.
- Under `JIRA_WRITE_MODE=plan`, every write description starts with the plan-only line.
- The manifest snapshot gains an `irreversibleGate` dimension.

### MCP-03 — `profile` on every tool, locked by default

**What.** All 82 input schemas carry `profile`, about 12,300 characters, about 10.5% of model-visible text. The profile is locked by default (`JIRA_LOCK_PROFILE=true`), and the instructions tell the model to omit it. `apply` and `plan_id` add about 13,200 characters, and `format` plus `resolveMentions` about 4,650. Those are legitimate on write tools and content reads.

**Why it matters.** It costs tokens, and it is an invitation: a model that sees a `profile` enum may try it.

**Recommendation.** Emit `profile` only when the profile is not locked, and keep tolerating it at call time. V3-25's trigger, "only when there is more than one profile", never fires, because `PACKAGE_PROFILES` always has 3 entries. Reword it to "only when `JIRA_LOCK_PROFILE=false`".

**Acceptance.**
- Locked: no tool lists `profile`.
- Unlocked: all 82 tools list it.
- A call that passes `profile` while locked still behaves as today.
- About 12k model-visible characters are saved under `all`.

### MCP-04 — Five paging idioms, three caps

**What.** Continuation is spelled five ways:

| Idiom | Tools |
|---|---|
| `data.nextPageToken` | `jira_search` |
| `data.partial` + `data.nextStartAt` | comments, worklogs |
| `paging.partial` + `paging.nextStartAt` | filters, components, versions, boards, sprints, users |
| `paging.nextPageToken` | sprint issues, backlog |
| `data.hasMore` + `nextPageToken` | `jira_get_changelogs_bulk` |

Some tools, such as `jira_get_changelog`, only give `data.total`, and the model does the arithmetic.

`maxResults` caps also differ:
- 100, with clamping described: search, comments, changelog, worklogs, users.
- A hard 50: components, versions, boards, sprints, sprint issues, backlog.
- 1000: bulk changelogs.
- Filters say "default 50" and document no cap.

**Why it matters.** The model has to learn each tool's continuation separately. A wrong guess either silently drops rows or follows a cursor that no longer applies; the truncation hint warns about the second case.

**Recommendation.** V3-05 unifies the caps. In 1.x, one sentence per paged description should say "max N; continue with X". For 2.0, V3-24 moves continuation to a single top-level `paging: {next, partial}` block; the old fields stay through 2.x.

**Acceptance.**
- A test enumerates every tool with `maxResults` and checks that its description names the cap and the continuation field.
- The 2.0 envelope has one continuation shape.

### MCP-05 — No tool-selection eval

**What.** The repo tests schemas, sizes and behaviour. It does not test whether an agent picks the right tool for a task.

**Why it matters.** V3-07 rewrites descriptions, V3-24 renames tools, and V3-28 moves to progressive discovery. All three change which tool a model selects, and none of them can show that selection improved. Claude Code's tool search matches the start of descriptions, so description wording directly decides discovery.

**Recommendation.** Two tiers:
- **Deterministic tier, in the gate.** `test/agent-evals/tasks.json` holds about 40 natural-language tasks, each with an expected first tool and its key arguments. The scorer simulates description-start keyword search over the emitted `tools/list` and reports top-1 and top-3 hit rates.
- **Model tier, outside the gate.** It replays the tasks against a model with the real tool list and is run by the owner, because it costs API spend.

**Acceptance.**
- `npm test` reports a top-3 hit rate of at least the recorded baseline and fails on regression.
- The model tier is a documented script that never runs in CI.

### MCP-06 — Internal tracker IDs in descriptions

**What.**
- `jira_update_comment`: "Edit one existing comment. CC-31 REPLACE semantics: body overwrites the WHOLE comment …"
- `jira_list_link_types`: "… unless a `truncated` hint says the character budget cut it (CC-253)."

**Why it matters.** These are noise tokens the model cannot resolve. They can also prompt it to search for a "CC-31" tool or issue.

**Recommendation.** Remove the IDs and keep the sentence ("REPLACE semantics: …"). Add a manifest test that rejects tracker patterns in descriptions and argument descriptions.

**Acceptance.** The test passes. `grep -E '\b(CC|D|V3)-[0-9]+' ` over the emitted `tools/list` returns nothing.

### MCP-07 — No reversible batch write

**What.** The only multi-issue write is `jira_bulk_edit_issues`. It is irreversible-tier, packaged in `issues-delete`, and also needs the site-wide "Make bulk changes" permission.

**Why it matters.** "Add label X to these 40 issues" is a common request. The fallback is 40 `jira_update_issue` plans plus 40 applies: about 81 calls, about 60k tokens of tool results, and 40 permission prompts in Claude Code. That is because write tools are annotated non-read-only, so even plan calls prompt.

**Recommendation (owner decision).** Add `jira_update_issues`: at most 50 keys, the same reversible field subset as `jira_update_issue`, one plan that lists every per-issue diff, and one apply under one `plan_id`. Report outcomes per issue, and never replay a partial failure, as the retry policy requires.

**Acceptance.**
- Planning and applying 40 issues takes 2 calls.
- A partial failure reports each issue's outcome with no retry of unsafe writes.
- The tool is not in the irreversible tier.

### MCP-08 — Discovery under deferred tool search

**What.** No tool sets `_meta["anthropic/alwaysLoad"]`. Some descriptions open with context instead of the action. Names like `jira_sprint_summary` and `jira_portfolio_report` break the `jira_<verb>_<noun>` pattern.

**Why it matters.** With tool search on, the agent first sees only the instructions. It finds tools by keywords at the start of descriptions.

**Recommendation.** V3-07 as planned (`alwaysLoad` on `jira_search`, `jira_get_issue`, `jira_count` and `jira_search_users`). Then extend the keyword-first rule to all descriptions: the first 80 characters should hold the verb and the Jira noun. Leave renames to V3-24.

**Acceptance.**
- The 4 hot reads carry `alwaysLoad: true`.
- A lint checks that every description's first sentence has a verb from an allowed list and the tool's main noun.
- The MCP-05 eval does not regress.

### MCP-09 — Data Center arguments on Cloud

**What.** `usernameArg` (`src/tools/collab.ts:173-177`) is described as "Jira Data Center only", but it appears in the watcher and assign schemas on every deployment.

**Why it matters.** On Cloud, the model may pass `username` (it sees one in search results), get a refusal, and retry.

**Recommendation.** Build the schema per deployment, as packages already are. When `JIRA_DEPLOYMENT=cloud`, omit DC-only properties.

**Acceptance.** Cloud `tools/list` has no `username` property. DC still has it. The snapshot covers both.

### MCP-10 — Changelog "recent" takes two calls

**What.** `jira_get_changelog` pages oldest first. The model has to read `total`, then fetch the tail.

**Recommendation.** Add `order: "newest"`, implemented as an internal tail fetch, or at least document the recipe in the description.

**Acceptance.** The newest *n* changes come back in one call, with `paging` reflecting the order.

### MCP-11 — Project key vs numeric id

**What.** `jira_list_statuses` and `jira_create_version` need the numeric `projectId` (`src/tools/meta.ts:524`). Most other tools take a key.

**Recommendation.** Accept either a key or an id (`/^\d+$/` means an id). Resolve keys through the existing project read, and keep the resolution inside the plan for writes.

**Acceptance.** Both forms work. Plans show the resolved id.

### MCP-12 — Bulk edit in the delete package

**What.** `jira_bulk_edit_issues` is registered by `issues-delete` (`src/tools/issues-delete.ts:1457`).

**Why it matters.** An operator who denies deletes also loses bulk edit, without noticing. An agent reading the package names in the instructions is misled.

**Recommendation.** 1.x: one line in CONFIGURATION. 2.0: move it to `issues-bulk`.

**Acceptance.** The documentation states it, and V3-24's table has the move.

### MCP-13 — Same operation, different spellings

**What.** Unassign and label edits are spelled differently on different tools (see the table).

**Recommendation.** Add both pairs to V3-24's rename list. No 1.x work.

**Acceptance.** V3-24's table lists them.

### MCP-14 — No live completions

**What.** Completions stage A is pure. Project keys, versions and sprints complete to nothing (`src/mcp/completions.ts:12-14`).

**Recommendation.** Stage B for `projectKey` only: a TTL cache of one `jira_list_projects` read, no network on the completion path once warm, and failures complete to nothing.

**Acceptance.** `completion/complete` for a prompt's `projectKey` returns the cached keys. It makes no request after the first, and a Jira error yields an empty result, never an error.

### MCP-15 — Generic `outputSchema`

**What.** All 82 tools carry the same 195-character envelope schema (D131), 15,990 wire characters in total. Claude's tool format drops `outputSchema`, so it costs bytes but no model tokens.

**Recommendation.** No change in 1.x. V3-08 should budget model-visible characters and wire characters separately, so that this does not hide real growth.

**Acceptance.** The budget file has both numbers.

## Agent task walkthroughs

Call counts assume a competent agent with the default `all` profile, apply mode
where noted, and Claude Code with tool search on. Token figures cover tool
results only, not `tools/list`, and are estimates from typical envelope sizes.

1. **Triage the unassigned bugs in PROJ (assign 5 to two people).** Calls:
   - `jira_count` (optional), 1
   - `jira_search` with `assignee is EMPTY AND type = Bug`, 1
   - `jira_search_users`, 2
   - `jira_assign_issue` plan + apply × 5, 10

   That is **13–14 calls, ≈12k tokens**. The `jira_triage_unassigned` prompt sequences the reads well.

   Friction:
   - Under the default plan mode the task stops after the plans (MCP-02).
   - Each assign takes two round trips.
   - Unassigning uses a different idiom from `jira_update_issue` (MCP-13).

2. **Move my Done issues into the next sprint.** Calls:
   - `jira_list_boards` (project filter), 1
   - `jira_list_sprints` with `state=future`, 1
   - `jira_search` with `assignee = currentUser() AND status = Done`, 1
   - `jira_move_to_sprint` plan + apply, 2

   That is **5 calls, ≈6k tokens**.

   Friction:
   - Boards and sprints cap at 50 with `paging.nextStartAt`, while the search uses `data.nextPageToken` (MCP-04).
   - The model has to find the board id before it can find a sprint.

3. **Release notes for version 1.4.** With the `jira_release_notes` prompt:
   - `jira_list_versions`, 1
   - `jira_search` with `fixVersion = "1.4"`, 1–2

   That is **2–3 calls, ≈8–15k tokens**.

   Friction:
   - Version and status tools mix keys and numeric ids (MCP-11).
   - A big release hits the 25k-character budget. The `truncated` hint gives a correct resume point, and `output:"file"` is the better choice above about 200 issues.

4. **Relabel 40 issues.** Two paths:
   - **Irreversible tier enabled and the site permission held.** `jira_bulk_preflight` prompt, `jira_search`, `jira_bulk_edit_issues` plan, apply (with elicitation confirm), then `jira_get_bulk_status` 1–3 times. That is **5–7 calls, ≈10k tokens**.
   - **Defaults.** Bulk edit is refused by configuration but still listed (MCP-02). The fallback is 40 × `jira_update_issue` plan + apply: **81 calls, ≈60k tokens, 40+ permission prompts** (MCP-07).

   Friction: `labelsAdd` and `labelsAction` are different idioms for the same edit (MCP-13).

5. **What is blocking epic EPIC-7?** Calls:
   - `jira_search` with `parent = EPIC-7` and `fields=issuelinks,status`, 1
   - `jira_search` with `issue in (<inward blockers>) AND statusCategory != Done`, 1
   - `jira_get_issue` on 1–2 blockers for context, optional

   That is **2–4 calls, ≈8k tokens**.

   Friction:
   - `jira_blocked_report` is scoped to a project, not an epic, so an agent that picks the prompt gets the wrong slice.
   - The link direction ("blocks" vs "is blocked by") needs `jira_list_link_types` the first time, +1 call.

## Assessment of the existing roadmap

- **V3-05 (maxResults clamp): agree, reorder to third.** It is the cheapest fix for MCP-04. Extend its acceptance so each paged description names its cap and continuation field.
- **V3-07 (alwaysLoad + keyword-first for about 4 reads): agree, do it second.** Then extend the keyword-first rule to every description with a lint (MCP-08), and remove internal IDs in the same pass (MCP-06).
- **V3-08 (surface ratchet): agree, do it first.** Its dependency V3-01 is done. Budget model-visible characters as well as wire bytes, and seed the budget with the measured 145,446 / 116,938, not D124's 93,722. The V3-07 dependency is not needed: V3-07 can re-baseline the budget.
- **V3-14 (lazy schemas): neutral for agent DX.** It changes startup time, not what the model sees. Keep it as is.
- **V3-24 (2.0 renames): agree; re-scope to add** the paging unification (MCP-04), the unassign and label idioms (MCP-13), the `issues-bulk` package move (MCP-12) and the noun-first names (MCP-08). Gate it on the MCP-05 eval baseline.
- **V3-25 (standard profile): re-scope.** Pull its two additive halves into 1.x: hiding gated-off irreversible tools (MCP-02) and hiding a locked `profile` (MCP-03). Fix the `profile` trigger wording. Leave the `standard` profile itself, a default change, as the owner decision it is.
- **V3-28 (3.0 wire): agree that it is blocked.** Progressive discovery and Skills over MCP need the MCP-05 eval first, or the change cannot be judged.

**Missing from the plan:**
- a tool-selection eval (MCP-05)
- description hygiene: tracker IDs (MCP-06) and DC arguments on Cloud (MCP-09)
- plan-only-aware descriptions (MCP-02)
- a newest-first changelog (MCP-10)
- key-or-id project arguments (MCP-11)
- live key completions (MCP-14)
- a reversible batch write (MCP-07), which reopens a "Considered and parked" item, so it needs the owner
- README guidance for tool-capped clients (Cursor, VS Code), which falls out of V3-08

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| MCP-R1 | Fold into V3-08: budget model-visible characters per profile and per tool, refresh the D124 figure, add README guidance for tool-capped clients | MCP-01, MCP-15 | `src/mcp/surface.test.ts`, `test/surface-budget.json`, `docs/DECISIONS.md` (D124 row), `README.md` (one section) | — | no | 2 |
| MCP-R2 | Description hygiene: remove tracker IDs, add a lint against them, extend keyword-first to all tools | MCP-06, MCP-08 | `src/tools/collab.ts`, `src/tools/meta.ts` (description strings), `src/mcp/description-lint.test.ts` (new) | V3-07 | no | 3 |
| MCP-R3 | Omit `profile` from schemas when the profile is locked, tolerate it at call time, fix the V3-25 wording | MCP-03 | `src/mcp/server.ts` (`toMcpTool`), `src/mcp/registry.ts`, `src/tools/manifest.snapshot.json`, `docs/ROADMAP.md` (V3-25 row) | MCP-R1 | blocked-owner (schema change on the wire) | 2 |
| MCP-R4 | Gate-aware listing: omit gated-off irreversible tools, add a plan-only prefix on write descriptions | MCP-02 | `src/mcp/registry.ts`, `src/mcp/write-mode.ts`, `src/mcp/server.ts`, snapshot | MCP-R1 | blocked-owner (listing changes with configuration) | 3 |
| MCP-R5 | Tool-selection eval: deterministic tier in the gate plus a documented model tier the owner runs | MCP-05 | `test/agent-evals/tasks.json` (new), `src/mcp/agent-eval.test.ts` (new), `scripts/agent-eval-model.mjs` (new) | — | no (the model tier is owner-run) | 5 |
| MCP-R6 | Paging documentation pass: each paged description names its cap and continuation field, with a test | MCP-04 | `src/tools/*.ts` (description strings), `src/mcp/paging-doc.test.ts` (new) | V3-05 | no | 3 |
| MCP-R7 | Cloud schemas drop DC-only arguments | MCP-09 | `src/tools/collab.ts`, `src/mcp/registry.ts`, snapshot | — | no | 2 |
| MCP-R8 | Changelog `order:"newest"` and key-or-id project arguments | MCP-10, MCP-11 | `src/tools/issues.ts`, `src/tools/meta.ts`, `src/tools/agile.ts`, `src/api/*` (resolver) | — | no | 3.5 |
| MCP-R9 | Reversible batch update `jira_update_issues` (≤50, one plan) | MCP-07 | `src/tools/issues-write.ts`, `src/api/issues.ts` | V3-09 | blocked-owner (reopens a parked item) | 6 |
| MCP-R10 | Completions stage B: `projectKey` from a TTL cache | MCP-14 | `src/mcp/completions.ts`, `src/mcp/server.ts` | — | no | 2 |

## Open questions for the owner

1. When `JIRA_ALLOW_IRREVERSIBLE=false`, should the 11 irreversible tools leave `tools/list` (MCP-R4)? This saves about 19.8k characters and removes dead ends, but `tools/list` would then depend on configuration in one more way.
2. Can a locked `profile` disappear from input schemas in 1.x, as long as calls that still pass it are tolerated (MCP-R3)? Or is any schema removal a 2.0 change for you?
3. Do you want a reversible batch update (MCP-R9)? It reopens "bulk edit" from the parked list. Today the choice is 81 calls or the irreversible tier.
4. Should the default profile stay `all` (82 tools) for 1.x, or should the README recommend `reader` or package selection for tool-capped clients until V3-25 decides `standard`?
5. May the model tier of the tool-selection eval (MCP-R5) spend API credit on a schedule you control, or should it stay manual only?
