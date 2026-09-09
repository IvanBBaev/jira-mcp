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
