# Authentication

> Status: target-state spec (pre-code). This document owns the **credential
> lifecycle** and the **doctor ops contract**.

## v1: Jira Cloud, Basic auth with API token

- Header: `Authorization: Basic base64(JIRA_EMAIL + ":" + JIRA_API_TOKEN)`.
- Token creation: https://id.atlassian.com/manage-profile/security/api-tokens —
  tokens created after 2024 have mandatory expiry (max 1 year); the doctor
  subcommand surfaces auth failures with a renewal reminder. Optional
  `JIRA_TOKEN_EXPIRES` (ISO date) lets doctor and the startup report warn when
  the horizon drops under 30 days — a cron/CI deployment otherwise discovers
  expiry as a hard 401 at 3 a.m.
- The token inherits the user's permissions — the server can never do more than
  the human account can. This is a feature (no privilege escalation) and a
  documentation duty (permission errors often masquerade as 404, see JIRA-API.md).
- Scoped API tokens (Atlassian's newer granular-scope tokens) work identically
  over Basic auth; if used, `read:jira-work` + `write:jira-work` (+
  `read:jira-user`) cover the v1 surface. Doctor reports 401/403 per probe so a
  missing scope is visible immediately.

## Credential storage

- Preferred: env vars set by the MCP client config (Claude Code `.mcp.json`).
- Alternative: `~/.config/jira-mcp-ai/.env`, written atomically 0600 by
  `doctor --save` (prompts) — never hand-edited instructions in README.
- The token value is registered with the redactor at load; it can never appear
  in logs, errors, or tool results.

## Multi-account

Named profiles (`JIRA_PROFILE_WORK_SITE=…`, `JIRA_ACTIVE_PROFILE=work`) allow
several sites/accounts; tools accept an optional `profile` argument unless
`JIRA_LOCK_PROFILE` is set. Follows the servicenow-mcp AsyncLocalStorage design.

**v1 default: locked** (O-6). A process serves one profile; per-call switching
requires unsetting `JIRA_LOCK_PROFILE` deliberately. Rationale: a model that
can pick the tenant per call can also leak an issue from tenant A into a
summary about tenant B, and the audit story ("which site did that write hit?")
gets much harder — one server per site is the cheap alternative.

**Secret registration is exhaustive at startup**: every credential in the
environment is registered with the redactor before anything can log — the
active profile's token, the tokens of **inactive** profiles, and
`JIRA_HTTP_TOKEN`. A secret that is merely present but unused is still a
secret that must never appear in a transcript.

## Doctor (CLI `jira-mcp-ai doctor`) — ops contract

Probes, in order (ALL run — no short-circuit on first failure, so one run
shows the complete picture):

1. settings load + report (missing/malformed vars);
2. host resolution + allowlist verdict;
3. env-file permissions (0600) when an env file is in use;
4. `GET /myself` → identity, accountId, timezone;
5. `GET /serverInfo` → deployment type sanity (warns if not Cloud);
6. one-page `search/jql` probe (`jql: "order by created desc"`, maxResults 1) —
   verifies search permission and the new-endpoint availability;
7. agile root probe (`GET /rest/agile/1.0/board`, maxResults 1) — the Agile API
   is a separate root with its own permission surface; a green platform probe
   does not imply it;
8. journal-write probe when `JIRA_JOURNAL_PATH` is set (open/append check);
9. token-expiry horizon (`JIRA_TOKEN_EXPIRES`; warn ≤ 30 days);
10. write-mode + package gating summary.

Contract (D11 in DECISIONS.md):

- Human report on **stdout** — doctor is a CLI run, not an MCP session;
  structured log events stay on stderr.
- Exit codes: `0` all probes green (warnings allowed), `1` at least one probe
  failed, `2` usage/config error prevented probing at all.
- `--json`: single machine-readable report object on stdout (for CI/cron).
- `--offline`: local probes only (1–3, 8–10) — no network; pairs with startup's
  offline-only rule (OBSERVABILITY.md).
- Prompts (`doctor --save`) only on a TTY; non-interactive runs fail with a
  message instead of hanging.

## v2 (not in v1 — see ROADMAP.md)

- **OAuth 2.0 (3LO) with PKCE** via `npx jira-mcp-ai login`: browser flow,
  refresh-token rotation, `api.atlassian.com/ex/jira/{cloudId}` gateway base
  URL (note: different host + cloudId indirection — the host layer must learn
  the gateway pattern). Needed only if org policy blocks API tokens.
- **Data Center PATs**: `Authorization: Bearer <pat>`, host via
  `JIRA_ALLOWED_HOSTS`, API version differences (v2 endpoints, no ADF —
  wiki-markup) make this a genuinely separate adapter, not just an auth switch.
