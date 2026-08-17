# Roadmap (post-v1)

> Status: aspirational — nothing here is committed scope; graduation into v1
> requires a DECISIONS.md entry.

## v1.5

The original v1.5 block — markdown ↔ ADF subset with read-side
`format: "markdown"`, backlog move + sprint create/start/close, saved-filter
reads, comment edit — graduated into committed scope via D38 (2026-08-13) and
shipped in Wave 6 (write-side `format` followed in the same wave, D44). One
carve-out stays here:

- `@name` mention **resolution** via user search on the markdown write path —
  the converters are pure and network-free (D38), so resolving display names
  to accountIds remains future scope.

(Comment **delete**, excluded from v1 by D7, matured into the irreversible
write tier — D45, Wave 7.)

## v2

The offline-implementable slice — attachments, the irreversible write tier
(issue/comment/worklog delete), watchers/votes, components/versions
list/create/update and project role listing — graduated into committed scope
via D45 (2026-08-13), Wave 7. What stays here needs live infrastructure, an
owner decision, or a deliberate scope call:

- **OAuth 2.0 (3LO) + PKCE** login CLI; `api.atlassian.com/ex/jira/{cloudId}`
  gateway support in the host layer; refresh rotation; multi-site cloudId
  discovery.
- **Jira Data Center adapter**: PAT bearer auth, v2 REST (wiki-markup, not ADF),
  `JIRA_ALLOWED_HOSTS`-driven host policy. Separate api adapter, shared core.
- **Bulk operations** (bulk edit / bulk delete) under the irreversible tier —
  the tier shipped in Wave 7 (D45); bulk itself stays future scope.
- **Component and version deletes** — deliberately absent from the `collab`
  package, because Jira rewrites every issue that referenced the deleted value:
  they belong to the irreversible tier, not to a package whose contract is that
  nothing in it deletes anything (D50).

## Considered and parked

- Confluence tools — separate server (`confluence-mcp`), not scope creep here.
- JSM (requests, SLAs, queues) — separate package family at best.
- Webhooks/events — MCP has no push channel to the model; revisit with MCP
  spec evolution (resources/subscriptions).
- Embedded JQL builder — the model writes JQL better than a DSL; docs instead.
