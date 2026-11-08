# docs/ — spec corpus for `jira-mcp-ai`

> Status: normative and implemented — these documents and the code ship
> together; drift is a bug. Each document carries a status banner like this one.

## Index

Grouped by who reads it. User and admin documents explain behaviour in plain
prose and cite a decision at most as a trailing "(rationale: Dnnn)"; the
contributor documents carry the `Dnnn` / `CC-nn` ids (docs-lint check 12).

### Use it — people running the server

| Document | What it is |
|---|---|
| [../README.md](../README.md) | Install, register with a client, first call, the tool tables. |
| [CONFIGURATION.md](CONFIGURATION.md) | Every env var with its default. |
| [AUTH.md](AUTH.md) | Credential lifecycle, storage, profiles, the doctor ops contract. |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | One entry per error kind: symptom, cause, fix, the `doctor` check that covers it. |
| [TOOLS.md](TOOLS.md) | Tool catalog: packages, names, inputs, defaults, hint/error vocabularies. |

### Approve it — Jira admins and security reviewers

| Document | What it is |
|---|---|
| [ADMIN-OVERVIEW.md](ADMIN-OVERVIEW.md) | One page: controls, identity, scopes, egress, data at rest, audit, revocation. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Security posture; **normative write-gate contract**; data handling. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability. |

### Build it — contributors

| Document | What it is |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Setup, the `check` gate, commit and review conventions. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layering, DI boundary, MCP style, envelopes, seams — read first. |
| [JIRA-API.md](JIRA-API.md) | Jira Cloud wire constraints: endpoints, pagination, ADF, retry policy. |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Log-event contract, never-log list, correlation ids, startup, call budget. |
| [TESTING.md](TESTING.md) | Test tiers, fixtures, network fence, coverage, the `check` gate. |
| [CORNER-CASES.md](CORNER-CASES.md) | Enumerated behaviours as stable `CC-nn` ids, referenced by test names and the plan. |
| [DECISIONS.md](DECISIONS.md) | Decision ledger: accepted D-rows, open owner O-rows, gates A–C. |

### Run the project — maintainers

| Document | What it is |
|---|---|
| [ROADMAP.md](ROADMAP.md) | Post-1.0 work: the v1.5 and v2 history, the v3 and role-panel work packages (`V3-nn` rows), the priority order, parked items. |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | Phases 0–16 and v2 waves 1–6 with exits and milestones; the release-progress block. |
| [WORK-PACKAGES.md](WORK-PACKAGES.md) | Historical: the parallel-execution overlay that cut the v1 phases into agent-sized work packages. |
| [RELEASING.md](RELEASING.md) | Publish-day runbook: the owner actions no file can perform. |
| [../CHANGELOG.md](../CHANGELOG.md) | Release notes. |
| [reviews/](reviews/) | Dated review and analysis reports (panels, baselines, state and backlog analyses), immutable once published. |

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
| Client registration: credential placement, version pin, per-client paths, PATH failure, log locations | CONFIGURATION.md |
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
