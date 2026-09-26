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
  18 tools with wiki markup flattened to text — an unverified preview that starts only with
  `JIRA_DATACENTER_PREVIEW=true` (D107). Writes and the remaining reads are
  still ahead (IMPLEMENTATION-PLAN.md 13.3b, 13.4). The price above is unchanged, and D104's verification
  condition is carried rather than waived — with no DC host, every DC stage
  ships fail-closed and labelled UNVERIFIED.

## Considered and parked

- Confluence tools — separate server (`confluence-mcp`), not scope creep here.
- JSM (requests, SLAs, queues) — separate package family at best.
- Webhooks/events — MCP has no push channel to the model; revisit with MCP
  spec evolution (resources/subscriptions).
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
