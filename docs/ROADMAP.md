# Roadmap (post-v1)

> Status: aspirational — nothing here is committed scope; graduation into v1
> requires a DECISIONS.md entry.

## v1.5

- **Markdown ↔ ADF subset**: headings, bullet/ordered lists, code fences with
  language, inline code, bold/italic, links, mentions (`@name` resolved via user
  search). Read side gains optional `format: "markdown"` on `jira_get_issue` /
  `jira_get_comments`.
- `jira_move_to_backlog`; sprint create/start/close (write tier standard).
- `jira_list_filters` / `jira_get_filter` (saved JQL reuse).

## v2

- **OAuth 2.0 (3LO) + PKCE** login CLI; `api.atlassian.com/ex/jira/{cloudId}`
  gateway support in the host layer; refresh rotation; multi-site cloudId
  discovery.
- **Jira Data Center adapter**: PAT bearer auth, v2 REST (wiki-markup, not ADF),
  `JIRA_ALLOWED_HOSTS`-driven host policy. Separate api adapter, shared core.
- **Attachments**: metadata list, download to `JIRA_MEDIA_DIR`, upload
  (multipart, `X-Atlassian-Token: no-check`); size caps.
- **Irreversible write tier**: issue/comment/worklog delete, bulk edit — gated by
  plan_id + before-state diff (facebook-mcp write-gate design).
- Watchers/votes, components/versions CRUD, project role listing.

## Considered and parked

- Confluence tools — separate server (`confluence-mcp`), not scope creep here.
- JSM (requests, SLAs, queues) — separate package family at best.
- Webhooks/events — MCP has no push channel to the model; revisit with MCP
  spec evolution (resources/subscriptions).
- Embedded JQL builder — the model writes JQL better than a DSL; docs instead.
