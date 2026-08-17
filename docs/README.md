# docs/ — spec corpus for `jira-mcp-ai`

> Status: normative and implemented — these documents and the code ship
> together; drift is a bug. Each document carries a status banner like this one.

## Index

| Document | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layering, DI boundary, MCP style, envelopes, seams — read first. |
| [JIRA-API.md](JIRA-API.md) | Jira Cloud wire constraints: endpoints, pagination, ADF, retry policy. |
| [TOOLS.md](TOOLS.md) | Tool catalog: packages, names, inputs, defaults, hint/error vocabularies. |
| [CONFIGURATION.md](CONFIGURATION.md) | Every env var with its default. |
| [AUTH.md](AUTH.md) | Credential lifecycle, storage, profiles, the doctor ops contract. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Security posture; **normative write-gate contract**; data handling. |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Log-event contract, never-log list, correlation ids, startup, call budget. |
| [TESTING.md](TESTING.md) | Test tiers, fixtures, network fence, coverage, the `check` gate. |
| [CORNER-CASES.md](CORNER-CASES.md) | Enumerated behaviours as stable `CC-nn` ids, referenced by test names and the plan. |
| [DECISIONS.md](DECISIONS.md) | Decision ledger: accepted D-rows, open owner O-rows, gates A–C. |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Phases 0–7 with exits and milestones. |
| [WORK-PACKAGES.md](WORK-PACKAGES.md) | Parallel-execution overlay: agent-sized work packages in waves. |
| [ROADMAP.md](ROADMAP.md) | Post-v1 items (v1.5 / v2). |
| [RELEASING.md](RELEASING.md) | Publish-day runbook: the owner actions no file can perform. |
| [reviews/](reviews/) | Panel review reports (dated, immutable once published). |

## Fact ownership (single-writer rule)

Every normative fact has exactly ONE owning document; every other mention must
be a pointer, not a copy. `scripts/docs-lint.mjs` (Phase 0 / WP-00) enforces
the mechanical subset.

What the rule bans is a second **definition** — a place where a reader could
change the value and be right. Naming an owned literal while pointing at its
owner is not a violation: a decision row that records *which* endpoint was
chosen (D6), a catalog column that lists the endpoint a tool calls, or a
threat-model bullet that restates the host suffix it is defending are all
derived mentions. The test is whether the sentence would have to change if the
owner changed the value — if yes, it is a copy and must become a pointer.

| Fact class | Owner |
|---|---|
| Env var names + defaults | CONFIGURATION.md |
| Wire constants (endpoints, retry numbers, pagination) | JIRA-API.md |
| Host forms: canonical `.atlassian.net` suffix, allowlist matching rules | JIRA-API.md |
| Tool names, counts, per-tool defaults | TOOLS.md |
| Credential lifecycle + doctor contract | AUTH.md |
| Write-gate contract + tiers | THREAT-MODEL.md |
| Log-event names/fields + never-log list | OBSERVABILITY.md |
| Decision status (accepted/open) | DECISIONS.md |
| Corner-case ids CC-nn | CORNER-CASES.md |

## Normative tags

Specs mark how each rule is enforced:

- **[eslint]** — enforced by a lint rule; violating code cannot land.
- **[test]** — asserted by a named test (corner cases reference CC ids).
- **[honor]** — review-enforced convention; no mechanical check.

An untagged statement is descriptive, not normative.
