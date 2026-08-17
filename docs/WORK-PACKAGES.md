# Parallel execution plan — agent work packages

> Status: historical — the execution plan as written 2026-08-07, kept as the
> record of how the work was cut and scheduled. Companion to
> IMPLEMENTATION-PLAN.md: **phases stay the milestone truth**; this document is
> the scheduling overlay that decomposes them into work packages (WPs) small
> enough to hand to independent agents and run in parallel waves.

## 1. Analysis — what parallelizes, and what decides the speed

### 1.1 The coupling is in contracts, not code

The eslint-enforced layering (`core ← api ← mcp ← tools`) already makes the
rings file-disjoint. What actually couples agents is a short list of **shared
contracts**. Once these are frozen, agents can work blind to each other:

| Contract | Consumed by | Owner file |
|---|---|---|
| `JiraRequest` function signature + `JiraResponse<T>` | every `api/*`, fakes | `core/http.ts` (type re-exported from a types module) |
| `JiraError` + `kind` catalog | everything | `core/errors.ts` |
| `ToolResult<T>` envelope + hint vocabulary | `mcp/result.ts`, all tools | `mcp/result.ts` types |
| `ToolSpec` / `PackageSpec` + `defineTool` input shape | all tool packages, registry | `mcp/define.ts` types |
| `Settings` shape + env var names | core, doctor, buildServer | `core/settings.ts` types (CONFIGURATION.md is the spec) |
| `Clock`, `Logger`, `Redactor` interfaces | everything | `core/clock.ts` / `core/log.ts` / `core/redact.ts` types |
| Testing seams: network fence, `withFetch`, `withEnv`, fakes | every WP's tests | `src/testing/`, `core/fakes/` |

**Rule: Wave 0 freezes all of the above as type-only + seam code. After the
freeze, a contract change is stop-the-line: only the integrator applies it, and
affected WPs rebase.** This is the single most important mechanism that makes
the fan-out safe.

### 1.2 Sizing reality (measured in the donors, 2026-08-07)

- The servicenow-mcp Jira port is **small**: `config+host+http+http-util+shared`
  ≈ 590 lines + 141 lines of ADF tests. WP-sized, not phase-sized.
- The heavy items are the **new** tiktok-style modules: donor `doctor.ts` is
  ~950 lines, `settings.ts` + `env-lock.ts` ~1150, `eslint.config.js` 141,
  facebook testing+fakes ~1.6k. These dominate the schedule, not the port.
- Consequence: the critical path runs through furniture + contracts, then the
  HTTP client, then `api/search|issues`, then tools, then integration. ADF,
  agile, meta, doctor and the write gate are all **off** the critical path.

### 1.3 Preconditions for fan-out (from the two panels)

1. **Initial commit + remote (owner decision O-1)** — agent isolation via git
   worktrees *requires a committed baseline*. Without a commit there is no
   branch/worktree mechanics, no merge, no rollback. This is now a hard
   prerequisite for multi-agent execution, not just a safety nicety.
2. ~~**E-P1 spec items (exit 0.5a)** close before Wave 1~~ — **done 2026-08-09**,
   together with E-P2 (exit 0.5b). The contracts a core WP is written against
   (call budget, log-event table, correlation id, doctor contract, result
   envelope, hint/error catalogs, plan-mode + journal) are all frozen in
   `docs/`; a brief may cite them as normative.
3. **Owner decisions O-3…O-6 (v1 tool scope, locked profile)** close before
   Wave 3 briefs are written — they change the manifest content. O-7 (plan_id
   apply) is resolved: D14.
4. **Scratch Jira site** blocks only WP-V (live fixtures + doctor live pass).
   Synthetic fixtures unblock everything else — the site is NOT a fan-out
   blocker, it is an integration-wave dependency.

### 1.4 Merge strategy

- **Exclusive file ownership**: no two WPs may touch the same file. The
  ownership lists below are exhaustive; anything not listed belongs to the
  integrator (notably `src/index.ts`, `src/tools/index.ts` manifest,
  `package.json`, config files after Wave 0).
- Each WP runs in its **own worktree/branch** (`wp/<id>-<slug>`), lands via a
  merge performed by the integrator in wave order, and must be green on the
  full `npm run check` *after* merge, not just in isolation.
- Tool packages register only through the `PACKAGES` manifest; the integrator
  adds one import line per landed package — that is the only cross-WP merge
  point in Wave 3.

### 1.5 Definition of done — every WP, no exceptions

1. Colocated `*.test.ts` for the WP's own contract (named per corner-case IDs
   where applicable).
2. Full `npm run check` green locally (typecheck, lint incl. layer zones,
   format, build, test).
3. No new dependencies without an integrator decision.
4. A 5-line handoff note: what landed, what was deferred, any contract friction
   observed (candidate spec bug → report, don't silently fix).

## 2. Waves and work packages

Phase mapping: Wave 0 ≈ Phase 0 + contract freeze; Wave 1–2 ≈ Phases 1 + 2a/2b;
Wave 3 ≈ Phases 2a/3/4 tool surface; Wave 4 ≈ integration slices of Phases
2–4; Wave 5 ≈ Phase 5. Sizes: S ≤ ~150 lines, M ~150–400, L ~400+ (source,
excluding tests; tests typically match source size).

### Wave 0 — Foundation (sequential; single agent or lead; blocks everything)

| WP | Scope | Size |
|---|---|---|
| WP-00 Furniture | `package.json` (incl. `mcpName`, `trademark`, files allowlist per D9/D10), `tsconfig.json`, `eslint.config.js` (zones renamed), prettier, `.c8rc.json`, `bin/jira-mcp-ai.cjs`, `scripts/docs-lint.mjs` (docs-regime checks per docs/README.md, wired into `check`), `.nvmrc`/`.editorconfig`/`.gitattributes`/`.npmrc`/`.env.example`, CI + dependabot, README skeleton, CHANGELOG, LICENSE, root SECURITY.md placeholder | M |
| WP-01 Contract freeze | Type-only modules for every row of §1.1 + `src/testing/` (network fence, `withFetch`, `withEnv`) + `core/fakes/` (fakeClock, fakeJiraRequest, fakeRedactor) with placeholder tests | M |

Exit: `npm run check` green on the wired repo; contracts tagged `FROZEN` in a
header comment; baseline committed (owner has authorized); branches can fork.

### Wave 1 — Core ring (parallel × 5)

| WP | Owns | Depends on | Size |
|---|---|---|---|
| WP-10 HTTP client | `core/http.ts`, `core/http-util.ts` — port + mandatory security deltas (anchored allowlist, blocklist, `redirect: "manual"`, per-segment encoding), retry matrix incl. `safe` flag, call budget, Retry-After jitter, semaphore + wire tests (CC-11…15, 27…30) | WP-01 | L (critical path) |
| WP-11 Config & settings | `core/config.ts`, `core/host.ts`, `core/settings.ts` (loadSettings + report), `core/env-lock.ts` | WP-01 | L |
| WP-12 Observability | `core/clock.ts`, `core/log.ts` (log-event table, correlation id via AsyncLocalStorage), `core/redact.ts`, `core/errors.ts` implementation | WP-01 | M |
| WP-13 ADF | `api/adf.ts` port + ported tests + property tests (fast-check); synthetic ADF fixtures until the site exists | WP-01 | M |
| WP-14 MCP primitives | `mcp/define.ts` (import-time assertions), `mcp/result.ts` (envelope + truncation incl. CC-25/26), `mcp/taint.ts` (untrusted-content envelope, D15/CC-35), `mcp/errors.ts` | WP-01 | M |

Also in Wave 1, S-sized, any free agent: **WP-15** `api/shared.ts` (both
pagination helpers + loop guards; donor is servicenow-mcp `api/table.ts` —
`api/jira/shared.ts` is the ADF donor and belongs to WP-13) — blocks all
Wave-2 api WPs, schedule it first. CC-01 (token-400 restart), CC-02
(write-recency) and CC-03 (default `fields`) are endpoint-specific: they land
in WP-20/WP-21, not here — shared.ts only propagates a failed caller-supplied
start token.

### Wave 2 — API ring + plumbing (parallel × 5)

| WP | Owns | Depends on | Size |
|---|---|---|---|
| WP-20 Search & users api | `api/search.ts` (token pagination, reconcile, count), `api/users.ts` | WP-10, WP-15 | M (critical path) |
| WP-21 Issues api | `api/issues.ts` read + write (create/update/transition/comment/assign/worklog/link) | WP-10, WP-13, WP-15 | L |
| WP-22 Meta api | `api/meta.ts` (projects, fields, createmeta, statuses, link types) | WP-10, WP-15 | M |
| WP-23 Agile api | `api/agile.ts` (boards, sprints, sprint issues, move) | WP-10, WP-15 | M |
| WP-24 Registry & gate | `mcp/registry.ts` (gating triple), `mcp/write-mode.ts` (plan/apply + plan_id binding), `mcp/transport.ts` (stdio; http per O-11) | WP-14 | M |
| WP-25 Doctor | `src/cli/doctor.ts` (full ops contract: probes, exit codes, `--json`, `--offline`) | WP-10, WP-11, WP-12 | L (off critical path) |

### Wave 3 — Tool surface (parallel × 5; needs O-3…O-6 closed)

| WP | Owns (tools packages) | Depends on | Size |
|---|---|---|---|
| WP-30 | `tools/core.ts` (capabilities, myself) + `tools/search.ts` (search, count) | WP-20, WP-24 | M (critical path) |
| WP-31 | `tools/issues.ts` (5 read tools) | WP-21, WP-24 | M |
| WP-32 | `tools/issues-write.ts` (7 write tools, plan/apply semantics) | WP-21, WP-24 | L |
| WP-33 | `tools/meta.ts` (6 tools) | WP-22, WP-24 | M |
| WP-34 | `tools/users.ts` + `tools/agile.ts` (1 + 4 tools) | WP-20, WP-23, WP-24 | M |

Every tool WP ships: schemas, envelope shaping per the read-shaping contract,
hints, and contract-tier tests against `fakeJiraRequest`.

### Wave 4 — Integration (mostly sequential; integrator + 1 agent)

| WP | Scope | Depends on |
|---|---|---|
| WP-40 Server assembly | `buildServer`/`main` split, `src/index.ts` dispatch, `tools/index.ts` manifest, MCP smoke test, manifest snapshot, README table generation + readme-sync test | all Wave 3 |
| WP-41 Live verification | Fixture recording on the scratch site (replacing synthetic where possible), doctor live pass, scripted reader pass, e2e write script under `scripts/smoke/` | WP-40 + **owner: scratch site** |

### Wave 5 — Hardening (parallel × 2–3, maps to Phase 5)

Coverage raise, docs-lint script, `server.json` + plugin manifests, publish
pipeline (trusted publishing) if O-9/O-10 land that way, per IMPLEMENTATION-PLAN Phase 5.

## 3. Agent brief template

Every WP is dispatched with this brief (keep under a page):

```
WP-nn <name> — branch wp/nn-<slug>
READ (spec):   <exact docs/ sections — not "the docs">
READ (donor):  <donor files at the pinned SHAs>
OWN (write):   <exhaustive file list — touch nothing else>
CONTRACTS:     frozen — consume as-is; friction = report, don't fix
DoD:           tests per §1.5; corner cases <CC-ids>; npm run check green
DEFERRED:      <explicitly out of scope for this WP>
```

## 4. Coordination rules

1. One integrator (the lead session) owns: merges in wave order, the manifest,
   `package.json`, contract changes, and the wave-gate `npm run check`.
2. Contract friction discovered by an agent is a **finding**, not a license to
   edit shared files — it goes in the handoff note; the integrator triages
   (spec bug vs WP misunderstanding).
3. Fan-out width: 4–5 concurrent WPs is the sweet spot — wider than that, the
   integrator's merge/verify becomes the bottleneck (and Wave 3 has exactly 5
   independent packages).
4. Between waves, run the full gate + a short drift check (manifest snapshot,
   layer-zone lint) before opening the next wave's briefs.

## 5. Schedule shape

Critical path: WP-00/01 → WP-10 → WP-20 → WP-30 → WP-40 (→ WP-41 when the
site exists). Everything else hangs off it in parallel. With 4–5 agents per
wave, the wall-clock is roughly the length of the critical path — about
**6–7 focused sessions** (W0: 1, W1: 1–2, W2: 1–2, W3: 1, W4: 1) versus ~2×
that fully sequential. Wave 5 is open-ended and mostly decision-bound.

Hard gates that only the owner can open:

- **Gate A (before any fan-out):** initial commit authorized + remote created.
- **Gate B (before Wave 3):** O-3…O-6 recorded (tool scope → manifest).
- **Gate C (before WP-41):** scratch Jira site provisioned.
