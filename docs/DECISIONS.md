# Decision ledger

> Status: living document. Single source of truth for project decisions —
> ARCHITECTURE.md's ADR summary and IMPLEMENTATION-PLAN.md's standing
> decisions are pointers into this file. Append-only: a reversed decision gets
> a new row superseding the old one, never an edit in place.

## Accepted

| ID | Date | Decision | Rationale |
|---|---|---|---|
| D1 | 2026-08-07 | Custom server, not Atlassian Rovo MCP | Rovo (as of 2026-08) has no agile/changelog/worklog surface (~14 tools, no boards/sprints/backlog), only coarse read/write/search permission groups, no plan gate, remote-hosted. (Original "OAuth-only" argument retired: Rovo added API-token auth 2026-02-24.) |
| D2 | 2026-08-07 | Cloud-only v1, Basic auth (email + API token) | Covers the actual use case; DC/PAT and OAuth are additive later (see AUTH.md v2). |
| D3 | 2026-08-07 | Port servicenow-mcp's dark Jira client | Proven code: host resolution, retry policy, ADF helpers, tests. Pinned at servicenow-mcp@5acdcc7 (donors: facebook-mcp@6de6f87, tiktok-mcp@59c4ce0); porting from a later SHA requires re-checking the panel's donor findings. |
| D4 | 2026-08-07 | facebook-mcp skeleton + tiktok-mcp strictness | House template v2; best-of of both repos. |
| D5 | 2026-08-07 | Low-level SDK `Server`, not `McpServer` | Keeps the `structuredContent` envelope under our control; `registerTool`'s private zod validation throws `McpError`. |
| D6 | 2026-08-07 | `/rest/api/3/search/jql` only | Legacy search endpoints removed by Atlassian 2025-08-01. |
| D7 | 2026-08-07 | No delete-issue tool in v1 | Irreversible; revisit with the tiered gate in v2. |
| D8 | 2026-08-07 | Package name `jira-mcp-ai`, private `0.0.0` start | Mirrors `servicenow-mcp-ai`; publish decision deferred to Phase 5. Name verified free on npm 2026-08-07 (fallback: `@ivanbbaev/jira-mcp-ai`); reservation timing = open decision O-9. |
| D9 | 2026-08-09 | zod v3 (`^3.25`) for v1 tool schemas | Donor parity — all three donors ship zod 3.25.x, so ported assertion/schema idioms transfer verbatim; SDK ^1.30 peer range accepts v3 and v4. zod runtime usage is quarantined in `mcp/define.ts` (ARCHITECTURE.md), so a v4 migration is a bounded v2 task, not a rewrite. |
| D10 | 2026-08-09 | No dotenv dependency — env files load via Node's `process.loadEnvFile()` | dotenv ≥ 17 prints a stdout banner, which corrupts the MCP protocol on stdio; Node ≥ 22 ships `process.loadEnvFile`/`util.parseEnv` natively; tiktok-mcp already avoids the import for exactly this reason. One less runtime dep (supply chain). |
| D11 | 2026-08-09 | Doctor reports on **stdout**; structured logs stay on stderr | Doctor is a CLI run, not an MCP session — the stdout-purity rule protects the protocol, and no protocol is running under `doctor`. Exit codes and flags: AUTH.md §Doctor. |
| D12 | 2026-08-09 | Keep the donor's in-process telemetry counters; surface them only in `jira_capabilities` + doctor, export nothing | Counters answer "why is this slow / how often are we throttled" for free; an exporter would add a dependency, a config surface and an egress path to a tool whose whole premise is local-first. OBSERVABILITY.md §Counters. |
| D13 | 2026-08-09 | No circuit breaker in v1 | A single-user server never reaches the load where a breaker pays off, and a tripped breaker reads to a model as "the tool is broken". Replaced by: `upstream_degraded` after 3 consecutive failures + status-page remediation text. OBSERVABILITY.md. |
| D14 | 2026-08-09 | `plan_id`-bound apply (O-7 default taken at Phase 0.5 close) | Binding an apply to the plan it came from closes the window where a model re-invokes with drifted arguments and executes something the human never reviewed. In-memory, single-use, dies with the process. Contract: TOOLS.md §Plan-mode; CC-32. Owner may still override before Phase 4. |
| D15 | 2026-08-09 | Taint envelope on content-bearing reads — **one per result**, not per field | JSM portals and mail handlers let non-tenant users write into descriptions/comments, so Jira text is attacker-influenceable; branding it makes the confused-deputy risk visible to the model at ~one warning line per result. Per-field wrapping was rejected as budget-hostile. Port of facebook-mcp `mcp/taint.ts`. Contract: TOOLS.md §Untrusted content; CC-35. |
| D16 | 2026-08-09 | Worklog `started` offset comes from the **authenticated user's Jira timezone** (`/myself`, cached per process), falling back to the host TZ | Jira stores the worklog against the site's calendar; the host's TZ is an accident of where the agent runs (a CI box is UTC, the human is not). `Z` is never sent (CC-23); the offset source is injectable so tests pin it without touching the host clock. |
| D17 | 2026-08-09 | ADF traversal caps: `MAX_NODE_DEPTH = 64` (cycle/hostile-input terminator), distinct from the CC-09 list-indent cap of 6 | No spec pinned a node-depth cap; taken during WP-13. 64 is far above any document a human authors but bounds a hostile or cyclic tree; the indent cap stays a *rendering* rule, the depth cap a *safety* rule. Constants exported from `api/adf.ts`; owner may retune. |
| D18 | 2026-08-09 | Settings numeric ranges enforced at parse: timeout/budget 1..600000 ms, `JIRA_MAX_PAGES` 1..1000, port 1..65535; out-of-range → `invalid_number` startup finding, never a silent fallback | No spec pinned ranges; taken during WP-11. A typo'd `JIRA_REQUEST_TIMEOUT_MS=300000000` silently accepted would surface as a hung tool call — failing at startup names the actual mistake. Ranges live in `core/settings.ts` only (CONFIGURATION.md stays the naming/default authority). |
| D19 | 2026-08-09 | HTTP transport demoted to v1.5 (O-11 default applied at the Phase 2a start) — v1 is stdio-only; `JIRA_TRANSPORT=http` produces a startup error naming v1.5 | No concrete use case materialized by the decide-by point, and the http path drags in a token gate, loopback binding and session handling (CC-30) for zero current users. Settings keep parsing the http vars so the config surface is stable; only `mcp/transport.ts` refuses. Owner may still reinstate before Phase 4. |

## Open (owner)

Defaults apply if no decision is recorded by the decide-by point. Full context:
`reviews/2026-08-07-extended-panel.md` §E-P3.

| ID | Decision | Default | Decide by |
|---|---|---|---|
| O-1 | Initial commit + private `IvanBBaev/jira-mcp` remote (**Gate A** — blocks all agent fan-out) | Do it — requires Ivan's explicit go | now |
| O-2 | Scratch Jira site provisioning (**Gate C**) | Owner console task, checklist in Phase 0 | before Phase 1 exit |
| O-3 | `jira_update_comment` in v1 | Defer to v1.5 | before Phase 2a snapshot (**Gate B**) |
| O-4 | Backlog read in v1 | Defer | before Phase 2a snapshot (**Gate B**) |
| O-5 | Assignable search as inputs on `jira_search_users` | IN (no new tool) | before Phase 2a snapshot (**Gate B**) |
| O-6 | Locked single profile per process | YES | before Phase 1 |
| ~~O-7~~ | `plan_id`-bound in-session apply | **Resolved 2026-08-09 by default → D14** | — |
| O-8 | Journal content: redacted fields vs args-hash | Minimized hash form + rotation | before Phase 4 |
| O-9 | npm name: reserve early vs wait + accept fallback scope | Wait, unless publish is likely | with O-1 |
| O-10 | Repo visibility | Private through v1 (CodeQL parked) | with O-1 |
| ~~O-11~~ | HTTP transport in v1 | **Resolved 2026-08-09 by default → D19** (stdio-only v1) | — |
| O-12 | Unattended (cron/CI) use as v1 acceptance criterion | Sizes priority of ops items F1–F3 | Phase 0.5 |
| O-13 | Anthropic-terms context (consumer vs Team plan) for the data-handling text | State the actual plan in the doc | Phase 0.5 |
