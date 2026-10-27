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
is the contract.

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
- **A file output for large reads**, as the sibling server's
  `format: "file"`: today `JIRA_MAX_RESULT_CHARS` truncates and the hint
  tells the model to narrow; a file would let a thousand-row search be
  handed to a script instead.

Not proposed, because already parked below or rejected in a D-row:
Confluence, JSM, webhooks, a JQL builder, bulk move / transition / watch,
and coalescing concurrent cache misses (D123).

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
