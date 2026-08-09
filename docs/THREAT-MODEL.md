# Threat model

> Status: target-state spec (pre-code) — code may lag until the phase noted in
> IMPLEMENTATION-PLAN.md. This document is the **owner of the write-gate
> contract** and the security posture; TOOLS.md, ARCHITECTURE.md and
> CONFIGURATION.md point here. (The root `SECURITY.md`, created in Phase 0, is
> the vulnerability-reporting policy — a different document.)

## Threat model (what we defend against)

1. **Credential leakage** — the API token appearing in logs, error messages, tool
   results, or the write journal.
2. **SSRF / host confusion** — a prompt-injected or buggy model steering requests
   to an attacker host via `JIRA_SITE`-like inputs or server-provided URLs.
3. **Unintended writes** — the model creating/mutating Jira data the user did not
   ask for, or retry logic duplicating writes.
4. **Transport exposure** — the HTTP transport reachable beyond localhost or
   without auth; DNS rebinding.
5. **Prompt injection via Jira content** — issue descriptions/comments are
   untrusted input that flows into the model's context.
6. **Supply chain** — compromised dependencies.

## Defenses

### Credentials
- Single redaction choke point (`core/redact.ts`): secret values registered at
  startup; all logs, `JiraError` messages (redacted in constructor), and shaped
  results pass through it. Structural stripping of `Authorization` echoes and
  token-bearing query strings happens before value redaction.
- **Scope note: redaction targets secrets, not PII.** Emails, display names and
  account ids in tool results are legitimate payload — minimizing them is a
  shaping-level concern (see Data handling below and the user-shaping contract
  in TOOLS.md), not the redactor's job. Conflating the two would either break
  results or give false privacy assurance.
- Basic-auth header built in `core/http.ts` only; `extraHeaders` rejects
  `authorization`/`accept`/`content-type` overrides (ported rule).
- Env files 0600, atomic writes, cross-process lock.

### SSRF / egress
- Default-deny host allowlist: the canonical Cloud suffix (JIRA-API.md §Hosts)
  plus explicit `JIRA_ALLOWED_HOSTS` (exact host or anchored regex; `endsWith`
  matching is banned by construction).
- Server-provided absolute URLs (`self`, `paging.next`) are never followed;
  requests are always rebuilt from path + params against the resolved host.
- Redirects off-host or to absolute paths are rejected.

### Write safety (normative gate contract — single owner: this document)
- `JIRA_WRITE_MODE=plan` is the default: write tools return a plan (what would be
  sent where) instead of executing. `apply` mode still requires per-call
  `apply: true`.
- Write tiers: v1 ships only `standard` tier tools (create/update/comment/
  transition/assign/worklog/link/sprint-move). `irreversible` tier (deletes,
  bulk) is reserved for v2 and will require plan_id + before-state diff, per the
  facebook-mcp gate design.
- Non-idempotent writes are NEVER auto-retried after an ambiguous failure
  (timeout/5xx after send); the error instructs the model to verify state first.
- Optional write journal (`JIRA_JOURNAL_PATH`): JSONL audit of every write call
  (content form: open decision O-8 in DECISIONS.md).

### Transport
- stdio: console guard; protocol on stdout, diagnostics on stderr.
- HTTP: loopback bind only; fails closed without `JIRA_HTTP_TOKEN`;
  `timingSafeEqual` bearer comparison; same-origin `Origin` check.

### Untrusted content
- ADF flattening produces plain text — no markdown link smuggling from rendered
  HTML; inlineCard URLs are printed verbatim, not fetched.
- **Taint envelope (D15).** Reads that can carry Jira-authored free text
  (issue, search, comments, changelog, worklogs) are branded `_untrusted: true`
  + hint `untrusted_content`, and their text rendering leads with the injection
  warning inside stable delimiters. The threat is concrete: JSM portals and
  mail handlers let people **outside** the tenant write into descriptions and
  comments, so "internal tool" does not mean "trusted input".
- This is a visibility control, not a boundary — the server cannot sanitize
  intent, only bound size (truncation budget) and make provenance obvious. The
  hard control against a text-driven write is the plan/apply gate above:
  an injected instruction still needs `JIRA_WRITE_MODE=apply`, `apply: true`
  and a `plan_id` the human's plan produced.
- Normative contract (which tools, what the envelope looks like): TOOLS.md
  §Untrusted content.

### Supply chain
- Runtime deps limited to `@modelcontextprotocol/sdk` and `zod` (dotenv dropped
  — D10 in DECISIONS.md: env files load via `process.loadEnvFile`).
- `npm audit --omit=dev --audit-level=high` inside `npm run check`; lockfile
  committed; dependabot with 7-day cooldown; CodeQL parked while the repo is
  private (O-10).

## Data handling & acceptable use

This section (mirrored in the README skeleton) states what the tool does with
data, because an MCP server is a data conduit, not just a client:

- **Outbound flow**: every tool result — issue content, comments, user names —
  enters the MCP client's model context and is transmitted to the AI provider
  (e.g. Anthropic) under *that* subscription's terms. The server adds no
  telemetry and calls no endpoint other than the configured Jira site, but it
  cannot control what the client does with results. Whether provider terms
  permit training on the data depends on the user's plan (consumer vs
  Team/Enterprise) — open decision O-13 records which applies here.
- **Authorization duty**: pointing this server at an employer's Jira tenant
  makes the operator responsible for having the right to export that data into
  an AI context — same duty as with any Jira API script, but worth stating
  because the data flow is less obvious.
- **Transcript persistence**: Jira content survives in MCP client transcripts
  and logs outside this server's control; the write journal (if enabled) is the
  only server-side persistence, and its content form is deliberately minimized
  (O-8).
- **Acceptable use**: the tool surface (worklogs, changelogs, user search) can
  technically reconstruct colleague activity. Using it for workplace
  monitoring/surveillance of individuals is outside the intended use and, in
  most jurisdictions, subject to labor/privacy law — the README says so
  explicitly.
- **PII minimization**: user objects are shaped to
  `{ accountId, displayName, active? }`; email appears only when a tool is
  explicitly asked (`includeEmail: true`) — see TOOLS.md shaping contract.

## Reporting

`SECURITY.md` at repo root (publish artifact) will carry the standard disclosure
policy, mirroring servicenow-mcp.
