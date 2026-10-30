# Roadmap (post-v1)

> Status: aspirational — nothing here is committed scope; graduation into v1
> requires a DECISIONS.md entry.

## v1.5

The original v1.5 block — markdown ↔ ADF subset with read-side
`format: "markdown"`, backlog move + sprint create/start/close, saved-filter
reads, comment edit — graduated into committed scope via D38 (2026-08-13) and
shipped in Wave 6 (write-side `format` followed in the same wave, D44). The
`@name` mention-**resolution** carve-out followed: graduated by D100
(2026-08-29) as Phase 9 — opt-in `resolveMentions` on the markdown write path
resolves `@[Display Name]` to real mention nodes via user search, while the
converters stay pure and network-free (D38): the tool ring resolves, the
converter only consumes the map. The last item — the **loopback Streamable
HTTP transport**, demoted here by D19 and explicitly not graduated by D38 —
graduated as Phase 10 (D101, 2026-08-30): the token gate, the loopback bind
and the session handling the demotion priced are exactly what shipped, on the
settings surface that had been kept stable the whole time. Nothing of the
original v1.5 block remains here.

(Comment **delete**, excluded from v1 by D7, matured into the irreversible
write tier — D45, Wave 7.)

## v2

The offline-implementable slice — attachments, the irreversible write tier
(issue/comment/worklog delete), watchers/votes, components/versions
list/create/update and project role listing — graduated into committed scope
via D45 (2026-08-13), Wave 7. **OAuth 2.0 (3LO)** followed: graduated by D91
(2026-08-21) and built as Phase 8 — the login CLI, the gateway, refresh
rotation and cloudId discovery are committed scope now, documented in AUTH.md.

The **component, version and sprint deletes** graduated next, by D102
(2026-09-01) as Phase 11, and their history here deserves keeping straight.
The component and version deletes had been parked because Jira rewrites every
issue that referenced the deleted value: they belong to the irreversible tier,
not to `collab`, whose contract is that nothing in it deletes anything (D50) —
and that is exactly where they landed, in `issues-delete` behind the tier's
full ceremony. The sprint delete had been parked for the same reason, and D73
paid the price for it openly: Gate C created a sprint it could not remove, so
every `--write` run stranded one and told the operator to delete it by hand,
because a delete tool added purely to service the project's own gate would
have widened the product's write surface for no user. D102 resolves that in
the order D73 demanded: the tools now exist *for users*, therefore the gate
may use them — `--purge` learned to remove the sprint, components and versions
the gate created. The first live `--write` run (2026-08-18) had charged a
larger version of the same bill — the account could not delete **issues**
either, so the two throwaway issues stayed behind too — and that half is a
permission on the site, not a missing tool: on a tenant whose account lacks
Administer Projects or manage-sprints, `--purge` still reports *manual*
honestly rather than implying a cleanup it could not perform.

**Bulk operations** were the last bullet standing here, and D103 (2026-09-02)
graduated them as Phase 12 in exactly the shape the bullet had committed to:
bulk delete and bulk edit under the irreversible tier — the tier D45 shipped
and D102 completed — plus a safe queue read, because the submits are
asynchronous and a task id is all Jira hands back. The bulk endpoints that did
*not* graduate with them are parked below, each with its reason.

What stays here needs live infrastructure, an owner decision, or a deliberate
scope call:

- **Jira Data Center adapter**: PAT bearer auth, v2 REST (wiki-markup, not ADF),
  `JIRA_ALLOWED_HOSTS`-driven host policy. Separate api adapter, shared core.
  **Parked by D104 (2026-09-10) with a named unblocking event** — a real DC host
  to build against, *and* a closed Gate C on Cloud — rather than left as an open
  intention. The shape above is unchanged; what follows is the price, measured
  against the tree rather than guessed, so the question does not have to be
  re-costed the next time it is asked.

  The cheap half is already paid for, and OAuth (D99) is what paid it.
  `authorizationHeader` is one exhaustive switch and its `bearer` arm exists, so
  a PAT is a resolver, not a header change. `HostRef.pathPrefix` is plumbed end
  to end and re-validated where the URL is built. `JIRA_ALLOWED_HOSTS` already
  admits a self-hosted host, and a non-443 port on one, by design. The classic
  `startAt`/`maxResults` loop is not merely written but is what six of the 11
  api modules already use through `shared.ts` (adf, attachments and bulk page
  nothing), so only the JQL endpoint's `nextPageToken` loop is Cloud-shaped. `JIRA_ROOT_PATHS` is one frozen map, so a `v2` root is two
  lines. One cheap thing is genuinely missing: `resolveHost` hardcodes an empty
  path prefix and downgrades a context path to a *warning*, so
  `https://jira.corp.example/jira` starts and then misses `/jira` on every
  request.

  The expensive half is not the wiring. A wiki-markup twin of `api/adf.ts` is
  1273 production lines and 73 tests of net-new bidirectional converter, with a
  hand-rolled markdown parser and a mention grammar; only three modules import
  it, so what is costly is writing it, not attaching it. `accountId` is 182
  non-test references across 24 files and 9 of the 58 tool input schemas, and
  DC identifies users by `username`/`key`. The 63 request specs in `src/api/*`
  each need an individual DC-availability verdict, and `src/api/bulk.ts` has
  none — those endpoints are Cloud-only. `scripts/fake-jira.mjs` is ~100 KB with
  67 hardcoded Cloud route handlers over 50 paths and would need a twin before a single DC test could
  run offline. Realistic test blast radius: 500-700 of 1778.

  The finding that decides the order, though, is structural rather than
  arithmetic. The seam this codebase has is `JiraRequestFn`, which is
  transport-level; there is no domain-level port. Tools import concrete
  functions out of `src/api/*`, and `PackagesDeps` has no slot for an api
  implementation, so a difference in *route shape* — as opposed to root prefix —
  has nowhere to plug in without branching inside every api function or
  inventing a port that does not exist. Until that port exists, "separate api
  adapter" names an intention, not an available seam.

  **Un-parked by D106 (2026-09-26)** on the owner's direction, in stages, as
  IMPLEMENTATION-PLAN.md Phase 13. The structural finding above is answered
  first: stage 13.1 shipped the port (`api/port.ts`, `ctx.api`), which changes
  nothing on Cloud, stage 13.2 the settings surface (`JIRA_DEPLOYMENT`,
  PAT auth, the context path), and stages 13.3–13.3b a read-only adapter for
  18 tools with wiki markup flattened to text, then stage 13.4 seven writes that
  render their bodies to wiki markup (D109), stage 13.5a two more reads —
  user search by username and project roles (D110), 20 reads in all — and
  stage 13.5b the five user writes — assign, add/remove watcher, add/remove
  vote — by `username` (D111) — stage 13.6a `resolveMentions` written as
  `[~username]` (D112), stage 13.6b eight reversible admin and
  agile writes — component, version and sprint create/update/start, and the
  two issue moves (D113) — stage 13.6c three more reads — the exact
  count, the embedded changelog and the attachment list (D114) — stage
  13.7a the two saved-filter reads, the list scoped to your favourites
  (D115) — and stage 13.7b the create metadata over the paged 8.4+ routes
  only (D116) — and stage 13.8 the attachment download over the
  `/secure/attachment` servlet, the upload left unserved (D117) — and the
  permission check since D122 — 48 tools in all, 28 reads and 20 writes — an unverified
  preview that starts only with `JIRA_DATACENTER_PREVIEW=true` (D107). The
  remaining reads and writes, `jira_close_sprint` among them, wait for a real
  host (D108, D109, D111, D113, D114, D115, D116, D117). The price above is unchanged, and D104's verification
  condition is carried rather than waived — with no DC host, every DC stage
  ships fail-closed and labelled UNVERIFIED.

## Post-1.0 candidates (2026-10-23)

With 1.0.0 on npm and every row of the release plan owner- or
external-blocked (IMPLEMENTATION-PLAN.md), the owner approved three
post-1.0 items on 2026-10-22: the permission check (D122, shipped), the
metadata catalogue cache (D123, shipped), and the lighter `tools/list`
with reference resources (D124, shipped 2026-10-23). This section keeps
the third item's record and the candidates measured against the tree on
2026-10-23, in the order they are worth doing. Nothing here is committed
scope by being listed: a D-row lands with its implementation, as D122's,
D123's and D124's did, and every other entry graduates the same way or
stays here.

A fourth item came from the owner directly on 2026-10-24 and shipped the
same day as D126, after D125: the `portfolio` package, cross-board duplicate, overlap,
reuse and dependency analysis with a Markdown/Mermaid report
(IMPLEMENTATION-PLAN.md Phase 14).

### 1. Shipped as D124: a lighter `tools/list`, examples as resources

Measured on `main` at `874afb6`: the 59 tool descriptions total 24,103
characters (about 6,000 tokens) and their emitted input schemas another
~25 k characters, so a session pays roughly 12,000 tokens of context before
its first call. The five longest descriptions are `jira_delete_version`
(626 characters), then `jira_get_my_permissions`, `jira_bulk_edit_issues`,
`jira_search_users` and `jira_create_issue` at just under 500 each. The
server declares only the `tools` and `logging` capabilities
(`src/mcp/server.ts`); it has no MCP resources and no prompts. The item is
two moves: trim each description to its contract (what the tool does, what
it needs, what it refuses) and move the worked examples, the
markdown-subset notes and the per-tool caveats into `resources/read`
references such as `jira://reference/tools/{name}`. Exit: the manifest
snapshot changes deliberately, a per-description length cap is a test, and
`jira_capabilities` is unchanged.

Outcome (D124): `tools/list` went from 107,073 to 93,722 characters, most
of it from the schema trim; the per-tool, write-mode, JQL and markdown
references and the server `instructions` shipped together, and the
per-description cap is the manifest test. TOOLS.md §Reference resources
is the contract. The surface has grown since (82 tools, 145,968 wire
characters on 2026-10-30); D510 now budgets it per profile in a test.

### 2. The rest of the MCP surface: prompts, the plugin

Cheap and offline-testable, and the natural continuation of item 1: the
resource handler it added is the one these would reuse, and the JQL and
write-gate references it listed shipped with D124.

- **Prompts**: ready-made workflows served on `prompts/list`, as the
  sibling `servicenow-mcp` server does — sprint review, stand-up digest,
  release notes for a version, triage of the unassigned. Each is a fixed
  sequence over existing read tools, so it adds no write surface.
  **Shipped (D125)**: all four, gated on the tools they name; TOOLS.md
  §Prompts is the contract. Argument completions stay out.
- **The plugin**: `.claude-plugin/` ships two manifests and nothing else. A
  skill or two inside it (a stand-up, a release-notes run) would make the
  Claude Code install useful on its first day.

### 3. Gaps in the Jira surface

None of these is in "Considered and parked" below, and each names one
endpoint the tree does not call today (checked over `src/api` and
`src/tools` on 2026-10-23).

Reads:

- **Backlog read**, `GET /rest/agile/1.0/board/{boardId}/backlog`. O-4
  deferred it and was resolved by default into D26; nothing has shipped it
  since, so `jira_move_to_backlog` exists without the read that would show
  what it moved. Shipped as `jira_get_backlog` (D134).
- **Priorities, resolutions and labels** — `GET /rest/api/3/priority`,
  `/resolution` and `/label`. `jira_create_issue` takes a priority by name
  and the model has no list to pick from. All three are immutable
  catalogues the D123 whitelist would admit. Priorities and resolutions
  shipped as `jira_list_priorities` and `jira_list_resolutions` (D138),
  through the paged `/search` routes, beside `jira_list_issue_types`.
  Labels shipped as `jira_list_labels` (D139) but outside the cache — they
  are not immutable; tagging an issue creates one.
- **Remote links**, `GET /rest/api/3/issue/{key}/remotelink`: the pull
  requests and pages attached to an issue. Shipped as
  `jira_get_remote_links` (D141).
- **JQL check**, `POST /rest/api/3/jql/parse`: tell a broken query from a
  working one before it is run or saved. Shipped as `jira_parse_jql` (D146).
- **Server info**, `GET /rest/api/3/serverInfo` (`/rest/api/2/serverInfo`
  on Data Center): the version the server is talking to. The Data Center
  8.4+ routes (D116) are assumed, not detected; with this read the doctor
  can report the version and the adapter can refuse an older host by name.

Writes, standard tier:

- **`jira_update_sprint`** — goal, dates and name over the same
  `POST /rest/agile/1.0/sprint/{id}` partial update that start and close
  already use; the sprint has create, start, close and delete, and no edit.
  Shipped as `jira_update_sprint` (D135).
- **`jira_rank_issues`**, `PUT /rest/agile/1.0/issue/rank`:
  `jira_move_to_sprint` says in its own description that ranking is
  unchanged. Shipped as `jira_rank_issues` (D136).
- **`jira_update_worklog`**, `PUT …/worklog/{id}`: add and delete exist.
  Shipped as `jira_update_worklog` (D142).
- **`jira_add_remote_link`**, `POST …/remotelink`: a web link to a pull
  request or a Confluence page — the one Confluence-shaped need that does
  not need Confluence tools. Shipped as `jira_add_remote_link` (D141).
- **`jira_create_filter`**, `POST /rest/api/3/filter`: "save this JQL".
  Shipped as `jira_create_filter` (D147), with `jira_update_filter` for the
  name, JQL and description of an existing one.

Irreversible tier, under the `issues-delete` ceremony (D45):

- **`jira_delete_attachment`**, `DELETE /rest/api/3/attachment/{id}`, and
  **`jira_unlink_issues`**, `DELETE /rest/api/3/issueLink/{id}` — the
  mirrors of `jira_upload_attachment` and `jira_link_issues`. Shipped as
  `jira_unlink_issues` (D143) and `jira_delete_attachment` (D144).
- **`jira_delete_remote_link`**, `DELETE …/remotelink/{id}` — the mirror of
  `jira_add_remote_link`. Shipped as `jira_delete_remote_link` (D145).

The natural bundles: the agile items (backlog read, sprint update, rank)
with the three catalogues as one "agile completeness" wave; the two
deletes as another, since they share the tier's receipts and gate claims.

### 4. Operational

- **Proxy and custom CA**: shipped as D300 — a CONFIGURATION.md section and
  doctor's local `network` probe; Node's `fetch` does the proxying
  (`NODE_USE_ENV_PROXY=1`), no `undici` dependency.
- **Scoped API tokens**: shipped as D301 — `JIRA_CLOUD_ID` sends basic auth
  through the gateway; doctor explains the 401/403 a scoped token produces.
- **Service accounts**: shipped as D302 — `JIRA_OAUTH_GRANT=client_credentials`
  mints the token in memory; no login, no token file.
- **Human confirmation for irreversible applies**: shipped as D303 —
  `JIRA_IRREVERSIBLE_CONFIRM=elicit` asks through MCP form elicitation, which
  the model cannot answer; opt-in, refused on a client that cannot ask.
- **Closing Gate C** (R03–R05) stays the most valuable open item and is not
  code: it is the sandbox account's permissions.
- ~~**A file output for large reads**~~ — done (D152): `output: "file"` on
  five reads writes the page to a JSONL file in `JIRA_MEDIA_DIR` and links
  it as `jira://exports/{name}`.

Not proposed, because already parked below or rejected in a D-row:
Confluence, JSM, webhooks, a JQL builder, bulk move / transition / watch,
and coalescing concurrent cache misses (D123).

## v3 preparation — parallel work packages (2026-10-28)

The 1.x work that clears the way for 2.0 and 3.0: one Jira Cloud API removal,
small additive contract items, and the refactors 2.0 needs (the server-wide
plan store comes first). Each row is one branch (`wp/<ID>`), one worktree
under `~/Development/_branches/jira-mcp-<ID>`, one merge into `main`. A row
graduates into committed scope through the D-row it writes. Rows marked
`blocked-owner` / `blocked-external` wait for a decision or an outside event
and are not started.

### Rules that keep parallel branches apart

1. **File ownership.** A WP edits only the files in its *Owns* column, plus
   its own new files and tests next to them. If it has to touch a file
   another WP owns, the row lists that WP under *Deps*. A WP that turns out
   to need more files stops and records that in its row.
2. **Pure moves stay pure.** The split WPs (V3-10…V3-13) only move code, with
   no change in behaviour. The old module stays behind as a re-export barrel
   so no importer changes in the same commit. The tests are frozen first:
   the suite must pass unchanged before and after the move.
3. **ID blocks are reserved per WP.** Use only the D-rows and CC numbers from
   the *IDs* column. Never take "the next free number". This avoids the
   placeholder renumbering that parallel v2 waves needed.
4. **Shared append-only files** are `docs/DECISIONS.md`,
   `docs/CORNER-CASES.md`, `CHANGELOG.md` (under `[Unreleased]`) and this
   table. Add rows there; never edit or reorder someone else's. A rebase
   conflict in these files is resolved by keeping both sides.
5. **Status updates.** Change only your own row, in a separate commit that
   touches only this file: `todo` → `done <sha>`.
6. **Contract changes are stop-the-line.** Any change visible to a user
   stops the WP and goes to the owner first: a tool name, an argument, an
   output shape, a default, an env var or the meaning of a plan. That
   includes anything breaking. Additive changes are fine.
7. **Gate:** `npm run check` green after the rebase. `merge` runs it under
   the merge lock.

### Work packages

| ID | Item | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|
| V3-01 | Agile issue reads on `/rest/software/1.0` (RFC-127 / CHANGE-3193; agile issue routes reported removed 2026-11-01). Covers `jira_get_sprint_issues`, `jira_get_backlog` and `jira_sprint_summary` on Cloud. Paging by `nextPageToken`/`isLast`; no `total`, so the summary counts rows. `startAt` stays as a deprecated alias (0 or an opaque resume token). The DC twin stays on `/rest/agile/1.0`. Adds the `software` root, fake-jira routes and the OAuth scope docs. Also documents read-after-write lag after `jira_move_to_sprint` | `src/core/types.ts` (root paths only), `src/api/agile.ts`, `src/api/datacenter.ts`, `src/tools/agile.ts`, `src/tools/sprint-summary.ts`, `scripts/fake-jira.mjs` (agile routes), `docs/JIRA-API.md`, `docs/AUTH.md`; also touched `src/mcp/project-scope.ts` (+test), `docs/TOOLS.md` (two rows), `src/tools/manifest.snapshot.json`, `scripts/docs-lint.mjs` | D500–D504, CC-5000–5019 | — | done 7f2b923 | 4 |
| V3-02 | Rate-limit headers: read `RateLimit` / `RateLimit-Policy` / `RateLimit-Reason` with and without the `Beta-` prefix | `src/core/http-util.ts` | D505, CC-5020–5029 | — | done cd802b5 | 1 |
| V3-03 | Config drift: add `JIRA_META_CACHE_TTL_S` and `JIRA_REPORT_DIR` to `.env.example`; document the Atlassian egress range `131.162.88.0/21` (allow-list by 2027-01-01) in the proxy section | `.env.example`, `docs/CONFIGURATION.md` | — | — | done b81b7ba | 0.5 |
| V3-04 | Additive envelope fields: `executed: true` on applied writes, `reason` on every `ErrorRecord` | `src/mcp/result.ts`, `src/mcp/errors.ts`, `src/mcp/types.ts`, `src/core/types.ts` (`ErrorRecord` only), `docs/TOOLS.md` (envelope section); also touched `src/core/errors.ts` (`toErrorRecord`), `src/mcp/write-mode.ts` (apply stamp), the tests of both plus `src/mcp/registry.test.ts`, `src/mcp/server.test.ts`, `src/tools/issues-delete.test.ts`, `docs/DECISIONS.md`, `docs/CORNER-CASES.md`, `CHANGELOG.md` | D506–D507, CC-5030–5049 | — | done cd2b792 | 2 |
| V3-05 | `maxResults` above the cap is clamped with a hint instead of rejected, one shared arg helper (five behaviours today) | `src/tools/agile.ts`, `src/tools/collab.ts`, `src/tools/issues.ts` and the other `maxResultsArg` sites, `src/mcp/tool-helpers.ts` (also touched `src/tools/search.ts`, `src/tools/users.ts`, the manifest snapshot and `src/tools/page-size.test.ts` (new)) | D508, CC-5050–5069 | V3-01, V3-07 | done 013bbb7 | 2 |
| V3-06 | Call-time enforcement proof: tests showing that a call to a tool that is not listed is refused at invocation. Covers packages, read-only mode, `JIRA_PROJECTS` and plan-only mode | `src/mcp/call-time-guard.test.ts` (new) | CC-5070–5089 | — | done 306d322 | 1.5 |
| V3-07 | `_meta["anthropic/alwaysLoad"]` on the ~4 hottest reads; keyword-first descriptions for exactly those tools | `src/mcp/registry.ts` (meta emission), `src/tools/search.ts`, `src/tools/issues.ts` (descriptions only); the emission landed in `src/mcp/client-hints.ts` (+test) beside D130, not `registry.ts`; also touched `README.md` (generated tool tables), `docs/TOOLS.md`, `docs/DECISIONS.md`, `CHANGELOG.md` | D509 | — | done b8f4d15 | 1.5 |
| V3-08 | Surface ratchet: a per-profile `tools/list` byte budget and a per-tool size cap as a test. Panel 2026-10-29 (MCP-R1): budget model-visible characters, refresh the D124 "~94k" figure to the measured 145k, README guidance for tool-capped clients | `src/mcp/surface.test.ts` (new), `test/surface-budget.json` (new) (landed as `src/tools/surface.test.ts`: eslint zones keep mcp/ off the manifest; also touched `README.md` and the D124 row) | D510 | V3-01, V3-07 | done 51ceee4 | 1.5 |
| V3-09 | Server-wide `PlanStore`, bound to the session and credential that planned, so a stateless wire can find plans. Behaviour unchanged for stdio. A D-row defines the binding. Panel 2026-10-29 (ARC-R3, SEC-R5): plan ids from a CSPRNG (`src/core/rng.ts`), bound to session and credential, TTL and per-session quota | `src/mcp/write-mode.ts`, `src/mcp/server.ts`, `src/mcp/transport-http.ts`, `src/core/rng.ts` | D511–D514, CC-5090–5119 | V3-04, V3-40 | todo | 6 |
| V3-10 | Split `core/http.ts` into stages (request build, send, retry, response). Retry semantics are frozen by tests first; extract, never rewrite. Panel 2026-10-29 (TSN-R1): not a pure move — first extract pure `classifyOutcome`/`decideNext` with table tests, then move the stages | `src/core/http.ts` → `src/core/http/*`, `src/core/http-util.ts` | D515 | V3-02 | done 15fad05 | 6 |
| V3-11 | Split `loadSettings` into per-domain loaders | `src/core/settings.ts` → `src/core/settings/*` | D516 | V3-03 | done 98ca41d | 3 |
| V3-12 | Split `api/issues.ts` (3350 lines) by sub-domain; `issues.ts` stays as a barrel. Panel 2026-10-29 (ARC): split by concern, not only by sub-domain | `src/api/issues.ts` → `src/api/issues/*` | D517 | V3-50, V3-56 | todo | 4 |
| V3-13 | Move the Data Center twins into `src/api/datacenter/` and add an eslint zone for it | `src/api/datacenter.ts` → `src/api/datacenter/*`, DC twins inside `src/api/*.ts`, `eslint.config.js` | D518 | V3-01, V3-12, V3-54, V3-79 | todo | 3 |
| V3-14 | Lazy tool schemas; move the probe/example checks into a test (startup target < 300 ms). Panel 2026-10-29 (TSN-R9): measure first — commit `scripts/bench-startup.mjs` and a baseline; schemas cost 25–34 ms against ~110 ms for the SDK import, so lazy schemas only if over budget | `src/mcp/define.ts`, `src/mcp/schema.ts`, `src/mcp/registry.ts`, `scripts/bench-startup.mjs` (new) | D519, CC-5120–5129 | V3-07 | todo | 1.5 |
| V3-15 | De-flake timing tests: `clock.test.ts` (:55, :80) and `rehearse-live.test.ts` CC-1105 (the never-exiting driver fails under a load average ≈ 55, passes alone) | `src/core/clock.test.ts`, `src/testing/rehearse-live.test.ts` | — | — | todo | 1 |
| V3-16 | Docker image: `Dockerfile`, a ghcr build workflow, and a README install section. The workflow builds only; publishing is R-row V3-23 | `Dockerfile` (new), `.github/workflows/docker.yml` (new), `.dockerignore` (new), `README.md` (install section only) | D520 | V3-32, V3-44 | todo | 2 |
| V3-17 | MCPB Desktop bundle: manifest and a pack script, built in CI | `mcpb/` (new), `scripts/pack-mcpb.mjs` (new), `package.json` (scripts only) | D521 | — | todo | 2 |
| V3-18 | Typed fake-jira split per domain under `src/testing/` | `scripts/fake-jira.mjs` → `src/testing/fake-jira/*` | D522 | V3-01, V3-05, V3-48 | todo | 6 |
| V3-19 | Write gate as an explicit, ordered middleware list. Panel 2026-10-29 (ARC-R5): one write-pipeline constructor, so it also owns `server.ts` | `src/mcp/write-mode.ts`, `src/mcp/registry.ts`, `src/mcp/project-scope.ts`, `src/mcp/server.ts` | D523–D524 | V3-09, V3-14, V3-57 | todo | 6 |
| V3-20 | Docs split: `docs/decisions/Dnnn.md` plus an index; archive the IMPLEMENTATION-PLAN phases 0–16; split CORNER-CASES by domain. **Solo**: runs only when no other WP is open. Panel 2026-10-29 (DOC, ARC-R10): contributor-corpus hygiene only — user/admin docs are V3-69…V3-71; the DECISIONS split may run early as a docs-only solo job | `docs/DECISIONS.md`, `docs/CORNER-CASES.md`, `docs/IMPLEMENTATION-PLAN.md`, `docs/decisions/` (new) | — | V3-01, V3-02, V3-04, V3-05, V3-06, V3-07, V3-08, V3-09, V3-10, V3-11, V3-12, V3-13, V3-14, V3-18, V3-19 | todo | 4 |
| V3-21 | Live check of `/rest/software/1.0` under Basic auth, a scoped token and OAuth 3LO (a 403 has been reported); the fallback itself is V3-29. Panel 2026-10-29 (OPS, JIR-R8): the Basic-auth read half of `verify-live.mjs` is owner-runnable today, before the tag; scoped token and 3LO stay external | — (live run) | — | V3-01 | blocked-owner | 1 |
| V3-22 | Release `main` as 1.1.0 before ~2026-11-01 (a 1.0.1 of V3-01 alone conflicts in 13 files — DevOps review). Docs checklist: V3-30, V3-34; fallback `1.1.0-rc.1` on `beta` | release | — | V3-01, V3-29, V3-38 | todo (D547: ships without waiting for V3-21; the tag, push and publish still need the owner's yes) | 1.5 |
| V3-23 | Distribution: official MCP registry entry, ghcr publish, Docker MCP Catalog, listings | registry, CI secrets | — | V3-16 | blocked-owner | 2 |
| V3-24 | 2.0 contract cleanup: the open v2 §3 renames plus the new inconsistencies; old names stay hidden but callable through 2.x; env aliases print a warning | tool surface | — | V3-05, V3-09, V3-45, V3-46 | blocked-owner | 12 |
| V3-25 | Default profile `standard` (≈50 tools); hide gated irreversible tools. Panel 2026-10-29 (MCP-R3/R4): omit `profile` from schemas when the profile is locked (the "more than one profile" trigger never fires) and tolerate it at call time; gate-aware listing with a plan-only prefix on write descriptions | `src/mcp/registry.ts`, packages | — | V3-08 | deferred to 1.2.0 (D550; `tools/list` unchanged in 1.1.0) | 4 |
| V3-26 | JSM read package `jsm`, opt-in. It reverses the JSM item under "Considered and parked" | `src/api/jsm.ts`, `src/tools/jsm.ts` (new) | — | V3-12, V3-42 | parked (D548 feature freeze) | 6 |
| V3-27 | Data Center: decide between growing it (needs a live host) and removing it in 3.0, by 2026-12-31 (D549, after an eval-host spike; default: deprecate in 2.x, remove in 3.0). Panel 2026-10-29: decide before V3-13, not after; base it on Atlassian's DC read-only date 2029-03-28 (see V3-79) | — | — | V3-79 | blocked-owner | — |
| V3-28 | 3.0 wire: adopt the 2027-03-30 MCP spec, retire 2025-11-25, progressive discovery as default, Skills over MCP | `src/mcp/*` | — | V3-19, V3-24, V3-25 | blocked-external | 20 |

Parallel lanes as of 2026-10-28. Rows in the same lane share files and run in
order; different lanes do not touch each other's files.

- **Agile:** V3-01 → V3-13 / V3-18 / V3-21
- **HTTP:** V3-02 → V3-10
- **Config:** V3-03 → V3-11
- **Envelope and plans:** V3-04 → V3-09 → V3-19
- **Tool surface:** V3-07 → V3-08 / V3-14, then V3-05
- **Issues API:** V3-12
- **Independent:** V3-06, V3-15, V3-16, V3-17
- **Solo, last:** V3-20

The first seven rows that are free now (V3-01, 02, 03, 04, 06, 07, 12) can
run at the same time. Add V3-15, 16 and 17 as cheap fillers.

## Role panel work packages (2026-10-29)

Nine senior reviewers (architect, TypeScript, security, QA, Jira platform,
MCP/agent-DX, product, docs, DevOps) reviewed `main` at `6cd07bd`. The
synthesis, verdicts and convergence are in
[`reviews/2026-10-29-role-panel.md`](reviews/2026-10-29-role-panel.md); each
role's full report sits next to it. Every proposed item (`ARC-R*`, `TSN-R*`,
`SEC-R*`, `QA-R*`, `JIR-R*`, `MCP-R*`, `PRD-R*`, `DOC-R*`, `OPS-R*`) maps to a
row below or to a re-scope of an existing row above (V3-08, 09, 10, 12, 14,
19, 20, 21, 22, 25, 27). Duplicates across roles are merged into one row.
The *Source* column names the report item, so each row's detail —
evidence, file:line, acceptance criteria — is in that report.

The same seven rules apply (file ownership, reserved IDs, append-only shared
files, own-row status commits, stop-the-line contract changes, gate). The
new reserved blocks are **D525–D560** and **CC-5130–5399**; nothing below
takes a number outside its row.

### Release lane — before ~2026-11-01 (P0)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-29 | Cloud software-root fallback: on 403/404 from `/rest/software/1.0`, retry the read once on `/rest/agile/1.0` (not memoised — the api ring has no stable per-profile key; D525), add the `root_fallback` hint. Read-only | JIR-R1, ARC-R1 | `src/api/agile.ts`, `scripts/fake-jira.mjs` (agile routes), `docs/JIRA-API.md` | D525, CC-5130–5139 | V3-01 | done (2026-10-30) | 3 |
| V3-30 | Count and release-marker truth: every tool count generated from the manifest or docs-linted; released-vs-main marker in README; npm description and keywords | DOC-R1, PRD-R2 | `README.md` (status box), `docs/index.html` (count spans), `package.json` (description, keywords), `scripts/generate-readme.mjs`, `scripts/docs-lint.mjs` | D526 | — | todo | 3 |
| V3-31 | THREAT-MODEL resync: the four data-at-rest sinks, tier lists bound to the manifest, `JIRA_PROJECTS` as a control, corrected plan/apply-vs-injection claim; a manifest-driven drift test | SEC-R3, DOC-R3, SEC-01 (doc half) | `docs/THREAT-MODEL.md`, `test/threat-model-drift.test.ts` (new) | CC-5140–5149 | — | todo | 3.5 |
| V3-32 | Secret-safe per-client quick-start (Claude Code user scope, Desktop, Cursor, VS Code), `claude mcp add` one-liner, deeplinks, first-success prompt; drop the "inline token is preferred" line | DOC-R2, PRD-R5 | `README.md` (install section), `docs/CONFIGURATION.md` (registration), `docs/index.html` (#install), `docs/AUTH.md` (registration) | — | V3-30 | todo | 3 |
| V3-33 | Project-scope matrix over the real catalogue; refusals name the offending key | QA-R3 | `src/mcp/project-scope.matrix.test.ts` (new), `src/mcp/project-scope.test.ts` | CC-5150–5169 | — | todo | 4 |
| V3-34 | 1.1.0 release docs: CHANGELOG Highlights / Breaking / Upgrading in user language, internal IDs moved out; `server.json` env list; RELEASING docs checklist | DOC-R7 | `CHANGELOG.md`, `server.json`, `docs/RELEASING.md` | — | V3-30 | todo | 1.5 |
| V3-35 | ARCHITECTURE.md drift fix (three drifts) plus a capabilities docs-lint probe | ARC-R2 | `docs/ARCHITECTURE.md`, `scripts/docs-lint.mjs` | — | V3-30 | todo | 1 |
| V3-36 | Description hygiene: remove tracker IDs from model-visible descriptions, a lint against them, keyword-first on the rest | MCP-R2 | `src/tools/collab.ts`, `src/tools/meta.ts` (description strings), `src/mcp/description-lint.test.ts` (new), `src/tools/manifest.snapshot.json` | CC-5170–5179 | V3-07 | todo | 3 |
| V3-37 | SDK floor `^1.32.1`, refresh the version comment, `npm audit fix` | TSN-R8, SEC-R6 (audit part) | `package.json`, `package-lock.json`, `src/mcp/transport-http.ts` (comment) | — | — | done (2026-10-30) | 0.5 |
| V3-38 | Owner release hygiene: register the npm trusted publisher, prove an OIDC publish, delete `NPM_TOKEN` and revoke it; rotate the API token pasted in chat; `main` and `v*` rulesets, `release` environment reviewer and tag policy, SHA pinning, private vulnerability reporting, secret scanning and push protection | OPS-R1, OPS-R3, SEC-R6 | `docs/RELEASING.md` (§1, §5); npm and GitHub settings | — | — | partial (2026-10-30: GitHub settings applied; npm trusted publisher, `NPM_TOKEN` removal and token rotation remain owner steps) | 2 |

### Proof lane — honest evidence (P0/P1)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-39 | Honest live job: JIRA_* secrets in the `live` environment, a scheduled run without credentials warns or fails instead of passing; rehearsals in CI with a staleness alarm | OPS-R5, QA-R2 | `.github/workflows/ci.yml` (`live` and rehearsal jobs), `docs/TESTING.md` (live section) | — | V3-21 | blocked-owner (secrets) | 3 |
| V3-40 | Read-only seam: read tools get a request object that cannot write; catalogue-wide read-confinement test | QA-R4 | `src/mcp/write-mode.ts`, `src/tools/read-confinement.test.ts` (new) | D527, CC-5180–5189 | — | todo | 3 |
| V3-41 | `safe: true` allowlist test and a real-catalogue wire test per profile | QA-R9, QA-R10 | `src/api/safe-allowlist.test.ts` (new), `src/mcp/catalogue-wire.test.ts` (new) | CC-5190–5199 | — | todo | 3 |
| V3-45 | Frozen 1.x legacy-surface alias suite (must precede V3-24) | QA-R6 | `test/legacy-surface-1.x.json` (new), `src/tools/legacy-surface.test.ts` (new) | CC-5200–5209 | — | todo | 3 |
| V3-46 | Tool-selection eval: deterministic tier in the gate, a documented model tier the owner runs (must precede V3-24, V3-25, V3-28) | MCP-R5 | `test/agent-evals/tasks.json` (new), `src/mcp/agent-eval.test.ts` (new), `scripts/agent-eval-model.mjs` (new) | D528, CC-5210–5219 | — | todo | 5 |
| V3-47 | Full Gate C pass over all 82 tools under classic token, scoped token and 3LO (software root and inferred scopes included) and a generated live-proof ledger | QA-R1, JIR-R8, PRD-R9 | `scripts/verify-live.mjs`, `docs/LIVE-PROOF.md` (new, generated), `docs/RELEASING.md`, `docs/AUTH.md` (scopes) | — | V3-29, V3-33 | blocked-external (owner-admin sandbox, bulk permission) | 7 |
| V3-48 | Recorded fixture corpus and a fake-vs-fixture shape contract test; V3-18 cannot merge without it | QA-R5 | `test/fixtures/**` (new), `src/testing/fake-contract.test.ts` (new) | CC-5220–5229 | V3-47 | blocked-external (live recording) | 6 |
| V3-78 | Mutation-testing baseline on the safety core, scheduled job | QA-R7 | `stryker.config.json` (new), `.github/workflows/mutation.yml` (new) | — | V3-33, V3-40 | todo | 4 |

### Security lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-42 | `JIRA_WRITE_CONFIRM`: opt-in elicitation for every write (optional taint trigger), not only irreversible ones; confirm prompt never quotes raw tenant text | SEC-R1, SEC-06 | `src/mcp/write-mode.ts`, `src/mcp/server.ts`, `src/core/settings.ts`, `docs/THREAT-MODEL.md`, `docs/CONFIGURATION.md` | D529–D530, CC-5230–5249 | V3-19, V3-31, V3-11 | todo | 7 |
| V3-43 | Separate export directory, upload refuses server-written files; media byte quota; media store hardening (bounded read, partial writes, single download) | SEC-R2, SEC-R7, TSN-R12 | `src/mcp/exports.ts`, `src/tools/attachments.ts`, `src/core/settings.ts` (two keys) | D531, CC-5250–5269 | V3-11 | todo | 6 |
| V3-44 | HTTP transport: `JIRA_HTTP_TOKEN` minimum strength, session bound to the token, container bind D-row (blocks V3-16) | SEC-R4 | `src/core/settings.ts` (one key), `src/mcp/transport-http.ts` | D532, CC-5270–5279 | V3-09, V3-11 | todo | 3 |

### Jira platform lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-49 | October 2026 JQL refresh: text-field `=`/`IN` exact-phrase semantics, entity-property JQL removal (2026-11-16), direct validation on `/search/jql`; reposition `jira_parse_jql` | JIR-R2 | `docs/JIRA-API.md`, the JQL reference resource, `src/tools/search.ts` (descriptions), `docs/TOOLS.md` | — | V3-07, V3-29 | todo | 2 |
| V3-50 | Bulkfetch cap to the published value (1000 since 2026-08-28) after re-reading the reference; D149 amended | JIR-R3 | `src/api/issues.ts`, `src/tools/issues.ts`, `docs/DECISIONS.md` (D149 note), `src/tools/manifest.snapshot.json` | D533, CC-5280–5289 | — | todo | 1.5 |
| V3-51 | Retry alignment: honour `Retry-After` on 503, a quota circuit after a quota 429, documented 429-on-write rationale | JIR-R4 | `src/core/http/*`, `src/core/http-util.ts`, `docs/JIRA-API.md` | D534, CC-5290–5309 | V3-10 | todo | 4 |
| V3-52 | Software-route correctness: truncation hint for the comment/changelog cap; `reconcileIssues` read-after-write ring for search and software reads | JIR-R5, JIR-R6 | `src/api/agile.ts`, `src/api/search.ts`, `src/tools/agile.ts`, `src/core/reconcile.ts` (new), `scripts/fake-jira.mjs` | D535, CC-5310–5329 | V3-29 | todo | 5 |
| V3-53 | Plan-mode report of rich-content loss when a description is replaced | JIR-R9 | `src/tools/issues-write.ts`, `src/core/adf.ts` | CC-5330–5339 | — | todo | 3 |
| V3-67 | DC `serverInfo` version gate | JIR-R7 | `src/api/datacenter/*`, `src/tools/capabilities.ts` | CC-5340–5349 | V3-13 | todo | 3 |

### Type-safety and architecture lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-54 | Typed DC assembly via `satisfies JiraApi`; remove `Partial<JiraApi>` and `as unknown as` | TSN-R2 | `src/api/datacenter.ts` | — | — | todo | 2 |
| V3-55 | `createJiraError` as the only constructor: convert the ~40 direct `new JiraError(` sites, `no-restricted-syntax` rule | TSN-R3 | `src/core/errors.ts`, `eslint.config.js`, the sites in `src/core`, `src/mcp`, `src/api`, `src/tools/index.ts` | D536 | V3-10, V3-12 | todo | 3 |
| V3-56 | Shared `api/guards.ts` and `api/wire.ts` (dedupe `isRecord` ×12, `shapeError` ×10, `send*`, `abortError`) | TSN-R4 | `src/api/guards.ts` (new), `src/api/wire.ts` (new), `src/api/*.ts`, `src/core/clock.ts` | — | — | todo | 4 |
| V3-57 | Split `createProjectScope` (612 lines) after its matrix lands | TSN-R5 | `src/mcp/project-scope.ts` | — | V3-33 | todo | 3 |
| V3-58 | Structural signal/deadline binding in the registry and an all-tools abort contract test | TSN-R6 | `src/mcp/registry.ts`, `src/mcp/tool-helpers.ts`, `src/mcp/abort-contract.test.ts` (new) | CC-5350–5359 | — | todo | 3 |
| V3-59 | Lint and compiler strictness: `switch-exhaustiveness-check`, `assertNever`, `consistent-type-imports`, a `strictTypeChecked` trial, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`; narrow the zod re-export and fix the stale quarantine message (D9 note). **Solo**: wide diff | TSN-R7, TSN-R10, TSN-R11 | `eslint.config.js`, `tsconfig.json`, `src/mcp/define.ts`, affected sites | D537 | V3-10, V3-11, V3-12, V3-13 | todo | 6 |
| V3-60 | The port owns DTO types and `api.limits`; tools stop importing Cloud types from `api`; enforced by the port-boundary test | ARC-R6 | `src/api/port.ts`, `src/tools/*` (imports), `src/tools/port-boundary.test.ts` | D538 | V3-12 | todo | 3 |
| V3-61 | `mcp/sdk.ts` anti-corruption module: one place imports the MCP SDK; eslint ban elsewhere | ARC-R7 | `src/mcp/sdk.ts` (new), the nine `src/mcp/*` SDK importers, `eslint.config.js` | D539 | V3-09, V3-19 | todo | 2 |
| V3-62 | Process-scoped vs session-scoped `buildServer` | ARC-R4 | `src/mcp/server.ts`, `src/index.ts` | D540 | V3-14, V3-19 | todo | 3 |
| V3-63 | Deployment-dependent schemas: Cloud tools drop DC-only arguments (`username`) | ARC-R9, MCP-R7 | `src/tools/collab.ts`, `src/mcp/registry.ts`, `src/tools/manifest.snapshot.json` | D541 | V3-79 | blocked-owner (schema change) | 2 |

### Agent-DX lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-64 | Paging documentation: every paged description names its cap and continuation field, with a test | MCP-R6 | `src/tools/*.ts` (description strings), `src/mcp/paging-doc.test.ts` (new) | CC-5360–5369 | V3-05 | todo | 3 |
| V3-65 | Changelog `order: "newest"` and key-or-id project arguments (additive) | MCP-R8 | `src/tools/issues.ts`, `src/tools/meta.ts`, `src/tools/agile.ts`, `src/api/projects.ts` (resolver) | D542, CC-5370–5389 | V3-12 | todo | 3.5 |
| V3-66 | Completions stage B: `projectKey` from a TTL cache | MCP-R10 | `src/mcp/completions.ts`, `src/mcp/server.ts` | CC-5390–5399 | V3-62 | todo | 2 |
| V3-68 | Reversible batch update `jira_update_issues` (≤ 50 issues, one plan) — reopens a parked item | MCP-R9 | `src/tools/issues-write.ts`, `src/api/issues/*` | D543–D544 | V3-09, V3-12 | parked (D548 feature freeze) | 6 |

### Docs lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-69 | `docs/TROUBLESHOOTING.md`, one anchor per `ErrorKind`; a tag-pinned `docUrl()` helper for doctor, startup and `--help` remediations (no `blob/main`), with anchor tests | DOC-R4 | `docs/TROUBLESHOOTING.md` (new), `src/cli/doctor.ts`, `src/index.ts`, `src/core/doc-url.ts` (new) | D545 | V3-32, V3-11 | todo | 3.5 |
| V3-70 | `docs/ADMIN-OVERVIEW.md` (controls matrix, identity, scopes, egress, data at rest, audit, revoke) and an AUTH scope map bound to the manifest, with read-only and core-writes presets | DOC-R5, DOC-R6 | `docs/ADMIN-OVERVIEW.md` (new), `docs/AUTH.md`, `src/tools/scope-map.test.ts` (new) | — | V3-31 | todo | 5.5 |
| V3-71 | Audience-split doc map; remove D-/CC-IDs from user docs and runtime strings, with a lint ban | DOC-R8 | `docs/README.md`, `docs/CONFIGURATION.md`, `src/tools/issues-write.ts`, `src/tools/meta.ts` (strings), `scripts/docs-lint.mjs` | — | V3-69, V3-36 (before V3-20) | todo | 3 |

### Release infrastructure lane (P1/P2)

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-73 | Publish pipeline v2: split build and publish jobs, publish the packed tgz with `--ignore-scripts`, GitHub Release, `mcp-publisher` OIDC step | OPS-R2 | `.github/workflows/publish.yml`, `docs/RELEASING.md` (§3–§4) | — | V3-38 | todo | 3.5 |
| V3-74 | Audit as its own CI job with an expiring `audit-allowlist.json`; publish fails only on unlisted high/critical | OPS-R4 | `package.json` (scripts), `scripts/audit-gate.mjs` (new), `audit-allowlist.json` (new), `.github/workflows/ci.yml` (audit job) | D546 | — | todo | 2 |
| V3-75 | Packed-tarball clean-install smoke and an SDK lower-bound job | OPS-R6 | `.github/workflows/ci.yml` (new job), `scripts/smoke-pack.mjs` (new) | — | V3-74 | todo | 2 |
| V3-76 | Close the plugin version-pin window (atomic bump-and-tag push or a ref-pinned marketplace source); post-release checklist | OPS-R7 | `docs/RELEASING.md`, `.claude-plugin/marketplace.json` | — | V3-73 | todo | 1 |
| V3-77 | CI, coverage and Dependabot hygiene: drop the duplicate coverage job, exclude the rehearsal script, per-file safety floors, derive counts in tests, `delete_branch_on_merge`, unstick #20/#21 | OPS-R8, QA-R8 | `.github/workflows/ci.yml` (`coverage` job), `.c8rc.json`, `src/tools/index.test.ts`; GitHub settings | — | V3-74, V3-15, V3-33 | todo (settings part blocked-owner) | 2.5 |
| V3-81 | Supply-chain criteria for V3-16/17/23: digest-pinned, non-root, multi-arch image with SBOM and provenance; MCPB on the Release; OIDC-only distribution | OPS-R9 | `docs/DECISIONS.md` (D520/D521 amendment) | — | — | todo | 0.5 |

### Product and owner lane

| ID | Item | Source | Owns | IDs | Deps | Status | Est h |
|---|---|---|---|---|---|---|---|
| V3-72 | Positioning: hero and three proof bullets (enforced safety, not breadth), dated "Rovo / other servers / when to use which" table, GPL FAQ line; reproducible demo GIF against fake-jira (plan → refused out-of-scope call → apply) | PRD-R3, PRD-R4 | `README.md` (top + new section), `docs/index.html` (hero), `scripts/record-demo.mjs` (new), `docs/assets/demo.gif` (new) | — | V3-30, V3-32 | todo (owner reviews wording) | 6 |
| V3-79 | Owner decision rows: feature freeze until distribution lands and 45 days of metrics (PRD-R15); DC freeze, decision by 2026-12-31 after an eval-host spike (ARC-R8, PRD-R13); complexity budget with V3-08 as the ceiling and V3-25 before V3-26 (ARC-R11) | PRD-R15, PRD-R13, ARC-R8, ARC-R11 | `docs/DECISIONS.md` | D547–D550 | — | done (2026-10-30, D547–D550) | 6 |
| V3-80 | Feedback and reach: GitHub Discussions and a weekly metrics script; plugin skills `standup` and `release-notes`; launch drafts via the `launch-marketing` skill (posting needs the owner's yes) | PRD-R11, PRD-R14, PRD-R12 | `.github/ISSUE_TEMPLATE/config.yml`, `scripts/metrics.mjs` (new), `.claude-plugin/` skills (new) | — | V3-22, V3-72 | todo (toggles and posting blocked-owner) | 7 |

Rows V3-16, V3-17 and V3-23 (Docker, MCPB, distribution) already cover
PRD-R6…R8; they now also carry V3-81's criteria. V3-07 + V3-25 cover
PRD-R10 (1.2.0 `standard` profile). Unused reserve: D551–D560.

### Priority order after the panel

1. **Release before ~2026-11-01:** V3-29, V3-21 (owner), V3-30, V3-31,
   V3-32, V3-33, V3-34, V3-36, V3-37, V3-38 (owner) → **V3-22 (owner's yes)**.
   Fallback: `1.1.0-rc.1` on the `beta` dist-tag.
2. **First two weeks after:** V3-23, V3-16, V3-17, V3-72, V3-25, V3-07,
   V3-08; V3-39, V3-40, V3-41, V3-47; V3-49, V3-50; V3-74, V3-73.
3. **Before any 2.0 contract change:** V3-45, V3-46, V3-48, V3-79.
4. **Refactors** (V3-10…V3-14, V3-18…V3-20, V3-54…V3-62) after step 3, or
   as the owner's feature-freeze decision allows.

Lanes that run in parallel without touching each other's files: release
docs (V3-30 → V3-32/34/35), proof tests (V3-33, V3-41, V3-45, V3-46), the
agile fallback (V3-29 → V3-52), the HTTP lane (V3-10 → V3-51), and CI
(V3-74 → V3-75/77).

## Considered and parked

- Confluence tools — separate server (`confluence-mcp`), not scope creep here.
- JSM (requests, SLAs, queues) — separate package family at best.
- Webhooks/events — MCP has no push channel to the model. Static reference
  resources shipped with D124; subscriptions stay parked until there is served
  content that changes.
- Embedded JQL builder — the model writes JQL better than a DSL; docs instead.
- Bulk move (`/bulk/issues/move`) — the payload is a per-target-project
  mapping monster (classification, status and custom-field mapping per
  destination); there is no offline way to validate the mapping semantics
  honestly.
- Bulk transition (`GET`+`POST /bulk/issues/transition`) — needs the
  available-transitions handshake per issue group; the single-issue
  `jira_transition_issue` already covers the resolvable case.
- Bulk watch/unwatch — trivially loopable with the existing single-issue
  tools; not worth two more irreversible-adjacent surfaces.
- `GET /bulk/issues/fields` (lists the editable fields) — meta discovery for a
  UI wizard; the bulk-edit tool exposes a fixed, documented field subset
  instead.
