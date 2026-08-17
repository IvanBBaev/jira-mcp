# Implementation plan

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. Phases 0–7 with their exits are the milestone truth for this
> project; a phase is done when its exit criteria hold, not when its tasks look
> finished.

> Parallel-execution overlay: `docs/WORK-PACKAGES.md` decomposes these phases
> into agent-sized work packages (waves, file ownership, owner gates A–C). The
> phases below remain the milestone truth; the overlay is scheduling only.

## Standing decisions

The ledger is **DECISIONS.md** (accepted D1–D58; open owner decisions
O-1…O-13 minus the resolved O-3…O-7 and O-11, with gates A–C). The plan below
references decisions by id and never restates their content.

## Phase 0 — Scaffold  ✅

- [x] `git init`; AI-harness files excluded via `.git/info/exclude`.
- [x] `docs/` spec set (this directory).
- [ ] `package.json` (`type: module`, engines ≥22, `mcpName:
      "io.github.IvanBBaev/jira-mcp-ai"`, nominative-use `trademark` note re
      the Jira mark, deps: SDK ^1.30 + zod `^3.25` (D9) — **no dotenv**, env
      files load via `process.loadEnvFile()` (D10); `files` allowlist with
      explicit negations (`!**/*.test.*`, `!src`, `!docs`) verified by an
      `npm pack --dry-run` tarball-content assertion in `check`),
      `tsconfig.json` (ES2023, NodeNext, strict, noUncheckedIndexedAccess,
      rootDir src), `.c8rc.json`, prettier (`singleQuote`, `printWidth: 90`),
      `eslint.config.js` copied from facebook-mcp with layer zones renamed.
- [ ] `scripts/docs-lint.mjs` — mechanical docs-regime checks (single-writer
      fact ownership per docs/README.md, CC-nn/D-nn/O-nn references resolve,
      status banners present); wired into `npm run check`.
- [ ] `bin/jira-mcp-ai.cjs` two-file Node guard — `.cjs`, ES5-parseable, so
      ancient Node prints the version message instead of a syntax error
      (tiktok-mcp lesson; CI gets a launcher probe on old Node); `.nvmrc` (24),
      `.editorconfig`, `.gitattributes`, `.npmrc`, `.env.example`.
- [ ] CI: `.github/workflows/ci.yml` (check on Node 22/24), `dependabot.yml`
      (npm + actions, weekly, 7-day npm cooldown); `codeql.yml` parked until
      the repo goes public (needs public repo or GHAS).
- [ ] Root `README.md` skeleton with generated-tools markers; `CHANGELOG.md`,
      `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (MIT).

- [ ] OWNER: authorize the initial commit + create the private GitHub repo —
      the spec corpus currently exists only in this working tree (single point
      of failure).
- [ ] OWNER: provision the scratch Jira Cloud site (free tier): team-managed
      AND company-managed project, rich-ADF sample issues per TESTING.md, a
      second user, API token. Needed by the Phase 1 exit, Phase 2b fixtures,
      and Phase 4.

Exit: `npm run check` green on an empty-but-wired repo (one placeholder test).

## Phase 0.5 — Spec revision (from the 2026-08-07 senior panel)

Findings and full action list: `docs/reviews/2026-08-07-senior-panel.md`;
second (extended) panel — ops, release, docs, product, privacy, delivery:
`docs/reviews/2026-08-07-extended-panel.md` (its E-P1/E-P2 checklists feed
this phase).

- [x] P0 factual fixes applied (tool count 27, token-400 signature, GET-only
      retry matrix + `safe` flag, Retry-After cap 60 s, statuses endpoint,
      maxResults default).
- [x] ARCHITECTURE.md (2026-08-09): determinism seams (injected RNG for jitter;
      timeout via `clock.sleep` + explicit `AbortController`, `AbortSignal.timeout`
      banned); typing-strategy section (hand-rolled interfaces + runtime guards,
      OpenAPI codegen rejected); plan-mode seam (dry-run-capturing `jiraRequest`
      injected at `buildServer`); host as `{ origin, pathPrefix }`.
- [x] TOOLS.md (2026-08-09): normative result-envelope, hint catalog (12 codes),
      error-kind catalog (13 kinds), truncation marker; plan-mode
      "NOT performed" contract + `plan_id` binding (D14); `apply`/`profile`
      as auto-injected control fields; transition id-or-name (CC-21).
- [x] Extended-panel E-P1 items (2026-08-09): ops contract — call budget
      `JIRA_CALL_BUDGET_MS` (CONFIGURATION.md + JIRA-API.md), doctor ops
      contract with stdout report/exit codes/`--json`/`--offline` + new probes
      (AUTH.md, D11), normative log-event table + never-log list + correlation
      id + token-expiry horizon (OBSERVABILITY.md, new doc); docs regime —
      DECISIONS.md ledger, CC-01…CC-30 stable ids, docs/README.md
      fact-ownership map + status banners, docs-lint spec'd into Phase 0;
      `docs/SECURITY.md` → `docs/THREAT-MODEL.md` rename; privacy —
      data-handling & acceptable-use section (THREAT-MODEL.md); release —
      zod-major ADR (D9), dotenv decision (D10), files-allowlist +
      `npm pack --dry-run` assertion into Phase 0. The two E-P1 items that are
      owner decisions (initial commit = Gate A, npm name reservation) remain
      open as O-1/O-9 in DECISIONS.md.
- [x] Extended-panel E-P2 items (2026-08-09): read-shaping contract + server
      `instructions` + JQL idioms (TOOLS.md), comment `orderBy` and changelog
      `expand` passthrough, write-journal spec (OBSERVABILITY.md, O-8 default,
      CC-33), HTTP-transport lifecycle spec'd with the O-11 demotion default
      recorded (ARCHITECTURE.md), telemetry-counters decision (D12), no
      circuit breaker (D13, `upstream_degraded`). New corner cases
      CC-31…CC-34 appended.
- [x] Owner decisions recorded in the decision table (2026-08-09): v1 scope of
      `jira_update_comment` / backlog read / assignable search (O-3/O-4/O-5,
      Gate B); locked-profile default (O-6); plan_id-bound apply — taken by
      default at this phase close as **D14**. Recorded ≠ decided: O-1…O-13
      (minus O-7) stay open with their defaults and decide-by dates
      (extended-panel doc §E-P3).
- [x] First-panel P3/P4 items (2026-08-09): untrusted-content taint envelope
      (D15 — TOOLS.md §Untrusted content, hint `untrusted_content`, THREAT-MODEL
      §Untrusted content, `mcp/taint.ts` in ARCHITECTURE + WP-14, CC-35); the
      two panel open questions answered as spec defaults — raw ADF stays
      `jira_get_issue`-only, worklog offset comes from the authenticated user's
      Jira timezone (**D16**, propagated to CC-23 / TOOLS `jira_add_worklog` /
      JIRA-API worklog bullet); test regime — fixture PII lint, fixtures as the
      source for `fakeJiraRequest`, stdout-purity and env↔docs-sync suites,
      env-gated weekly live read suite, `TZ=UTC` determinism knob
      (TESTING.md, `JIRA_LIVE_TEST` in CONFIGURATION.md); publish hardening +
      pinned `.mcp.json` example (Phase 5).

Exit 0.5a (gates Phase 1): P1-class items closed or explicitly deferred with a
decision entry. Exit 0.5b (gates Phase 2a; may run in parallel with Phase 1
code): P2-class items closed likewise.

**Status 2026-08-09: both exits met on the spec side.** Everything that does
not require an owner decision is written down; what remains of this phase is
O-1…O-13 in DECISIONS.md, of which only **Gate A (O-1)** blocks starting work.

## Phase 1 — Core

- [x] **Port-with-mandatory-deltas** from servicenow-mcp (`core/jira/config.ts`
      → `core/config.ts`, `core/jira/host.ts` → `core/host.ts`,
      `core/jira/http.ts` **+ `core/http-util.ts`** → `core/http.ts` +
      `core/http-util.ts` — the canonical retry semantics live in the donor's
      `http-util.ts`, not in `http.ts`). This is a DI
      rewrite: only retry semantics, error extractor and algorithms survive —
      the shell is re-authored (no module singletons, no env reads, no
      `Date.now`/`setTimeout`/`Math.random`/`AbortSignal.timeout`). Each
      security delta lands with a named wire test: exact/anchored allowlist
      matching (donor's `endsWith` is banned), blocklist enforced even with an
      allowlist, `redirect: "manual"` + off-host rejection, per-segment
      `encodeURIComponent` + id validation. Adapt env names per
      CONFIGURATION.md.
- [x] New: `core/clock.ts`, `core/log.ts` (incl. the AsyncLocalStorage cid
      seam — no separate `core/request-context.ts`; profiles join it in
      Wave 2), `core/redact.ts`, `core/errors.ts` (`JiraError` + kind
      catalog), `core/settings.ts` (`loadSettings` with report),
      `core/env-lock.ts` (from tiktok-mcp).
- [x] `src/testing/`: network-fence, with-fetch, with-env; `core/fakes/`:
      fakeClock, fakeJiraRequest, fakeRedactor.
- [x] CLI `doctor` (probes per AUTH.md), wired in `src/index.ts` dispatch.
- [ ] Record the minimum fixture set (TESTING.md) in the same session the
      scratch site comes up; hand-craft the synthetic fixtures (429, expired
      token).

Exit (**Milestone M1 — first runnable artifact**): wire-tier HTTP policy tests
green (retry matrix, allowlist, headers; CC-11…15, CC-27…30); `doctor`
exits 0 with all probes green against the scratch site.

## Phase 2a — MCP layer + search tools

> Status 2026-08-12 (Wave 4): everything below is done — mcp ring in Waves
> 1–2, tools in Wave 3, `buildServer`/`main` + smoke + snapshot in Wave 4.

- [x] `mcp/define.ts` (assertions per ARCHITECTURE.md), `mcp/result.ts`
      (envelope + truncation), `mcp/errors.ts`, `mcp/registry.ts` (gating
      triple), `mcp/transport.ts` (stdio; http behind flag), `buildServer`/`main`
      split.
- [x] `api/shared.ts` (both pagination helpers), `api/search.ts`,
      `api/users.ts` (myself).
- [x] Tools: `jira_capabilities`, `jira_get_myself`, `jira_search`,
      `jira_count`.
- [x] MCP smoke test + first manifest snapshot test.

Exit (**Milestone M2 — first usable**): server registered in Claude Code; real
JQL search works end-to-end (the default field set carries no ADF, so
`api/adf.ts` is not needed yet). CC-01…05, CC-25/26 covered.

## Phase 2b — ADF + issue read

> Status 2026-08-09 (Wave 1): `api/adf.ts` is done (ported + property tests,
> synthetic fixtures; real ADF fixtures still need the scratch site — Gate C).

- [x] `api/adf.ts` (port + property tests; real-site ADF fixtures stay under
      Gate C), `api/issues.ts` (read side).
- [x] Tool: `jira_get_issue`.

Exit: issue read with ADF flattening works end-to-end; CC-06…10 covered.

## Phase 3 — Full read surface

- [x] `api/meta.ts`, `api/agile.ts`, remaining read wrappers.
- [x] Tools: comments, transitions, changelog, worklogs, projects (list/get),
      fields, create-meta, statuses, link-types, user search, boards, sprints,
      sprint issues.
- [x] README tool table generation + readme-sync test (Wave 4).
- [ ] Fixture set completed (see TESTING.md) — recording blocked on Gate C
      (scratch site); synthetic fixtures are in place.

Exit: every `reader`-profile tool returns `ok: true` in a scripted pass against
the scratch site; c8 thresholds (70/60/75/70) enforced in `npm run check` from
this phase on; CC-16…19 covered.

## Phase 4 — Writes

- [x] `mcp/write-mode.ts` (plan/apply gate), optional write journal.
- [x] `api/issues.ts` write side + `api/agile.ts` sprint move.
- [x] Tools: create, update, transition, comment, assign, worklog, link,
      move-to-sprint. CC-20…24.
- [ ] End-to-end write test against scratch Jira site (manual script under
      `scripts/smoke/`, not in CI) — blocked on Gate C.

Exit: the full tool surface locked by the TOOLS.md catalog and manifest
snapshot; write path proven on a real site in both plan and apply modes.

## Phase 5 — Hardening & release

- [x] Raise coverage thresholds; property tests; audit in check. (Wave 5:
      floors 94/82/97/94 enforced by `check` via `test:coverage` — D36.)
- [x] `server.json` (MCP registry manifest), `.claude-plugin/` plugin +
      marketplace manifests, generated README finalized. (Wave 5 — D37;
      plugin source stays `"./"` until an npm publish exists.)
- [ ] Decide npm publish (`jira-mcp-ai`) vs private; if publish: `publish.yml`
      via npm **trusted publishing** (GitHub OIDC — no `NPM_TOKEN` secret;
      classic tokens revoked 2025-12, granular tokens cap at 90 days; needs
      npm ≥ 11.5 → Node 24 release runner), `prepublishOnly: npm run
      check:publish` (D62),
      tarball-content assertion (`npm pack --dry-run` vs expected list),
      CHANGELOG discipline, version 1.0.0.
- [x] Publish hardening (applies whether or not we publish publicly):
      `--provenance` on publish so the tarball carries a signed link back to the
      workflow run and commit that built it (free with OIDC trusted publishing,
      and the thing that makes "is this really our build" answerable);
      **2FA/`publish` access level required on the npm account** even with OIDC,
      so a stolen cookie cannot hand-publish over the automated release;
      `engines.node` enforced (`>=22`) so a Node-20 host fails at install, not
      at the first `process.loadEnvFile` (D10); the `.mcp.json` example ships a
      **pinned version** rather than a floating `npx -y jira-mcp-ai`
      (CONFIGURATION.md) — an unpinned agent-side spawn re-resolves to the
      newest publish with no review step; `npm audit --omit=dev` already in
      `check` gates the release, and lockfile-only dependency bumps get the same
      `check` run as code.
- [ ] OWNER: Actions `JIRA_*` secrets for the weekly live suite; revisit repo
      visibility + CodeQL.

Exit: coverage raised per TESTING.md (or a lower target recorded with
rationale); all corner cases then defined (CC-01…CC-35) traceable to named
tests; publish decision
recorded in the decision table (publish → v1.0.0 tagged + `publish.yml` green;
private → pinned version, README states the distribution mode).

Status 2026-08-13: everything above is done except the two owner gates —
O-9/O-10 (publish + visibility) and the Gate-C-blocked live verification.
The gate stands at 976/976 with coverage enforced.

## Phase 6 — v1.5 (graduated by D38, Wave 6)

- [x] WP-60: markdown ↔ ADF subset converters in `api/adf.ts`;
      `format: "markdown"` on `jira_get_issue` / `jira_get_comments`
      (default `text` unchanged; taint envelope preserved). CC-41…45.
- [x] WP-61: agile writes — `jira_move_to_backlog`, `jira_create_sprint`,
      `jira_start_sprint`, `jira_close_sprint` (standard tier, CC-34
      shaping, D22 cap semantics). CC-36/37, D39/D40.
- [x] WP-62: `jira_list_filters` / `jira_get_filter` (search package) +
      `jira_update_comment` (D26 deferral matures). CC-38/39/40, D41.
- [x] Integrator: shared-doc deltas (TOOLS/JIRA-API/CORNER-CASES/ROADMAP)
      applied; write-side `format` wired into all 7 rich-text write tools
      (CC-46, D44); manifest snapshot + README regenerated; full gate green.

Exit: new tools in the manifest snapshot + generated README; converters
CC-06..10-clean; gate green with coverage floors intact.

## Phase 7 — v2 subset (graduated by D45, Wave 7)

- [x] WP-70: attachments — `core/http.ts` contract extension (binary download,
      multipart upload, per-request headers for `X-Atlassian-Token: no-check`;
      http.ts stays the only network module), `api/attachments.ts`, attachment
      tools (list metadata / download / upload). `JIRA_MEDIA_DIR` consumed
      (refuse `config` when unset); Jira-supplied filenames sanitized
      (path-traversal defense); size caps both directions.
- [x] WP-71: collaboration surface — watchers list/add/remove, votes
      add/remove, components list/create/update, versions list/create/update,
      project role listing. Standard write tier; no deletes.
- [x] WP-72: irreversible write tier — gate semantics for
      `writeTier: 'irreversible'` in `mcp/write-mode.ts`
      (`JIRA_ALLOW_IRREVERSIBLE` opt-in; the plan captures a before-state
      snapshot of what the apply destroys), `jira_delete_issue`,
      `jira_delete_comment`, `jira_delete_worklog`.
- [x] Integrator (pre-dispatch): settings pre-wired — `JIRA_MEDIA_DIR`,
      `JIRA_ALLOW_IRREVERSIBLE` in core/settings + CONFIGURATION.md +
      `.env.example` — so agent file ownership stays disjoint.
- [x] Integrator (post-wave): doc deltas folded (TOOLS / JIRA-API /
      CORNER-CASES CC-47…66 / DECISIONS D46…D58 / THREAT-MODEL / CHANGELOG);
      manifest snapshot + README regenerated; full gate green.

Exit: new tools in the snapshot + README; irreversible applies refused without
the opt-in (tested); `core/http.ts` still the only fetch site; gate green with
coverage floors intact.

Status 2026-08-14: **exit met.** The three work packages were executed by three
background agents on 2026-08-13 and integrated on 2026-08-14; the manifest
snapshot and the generated README carry the full surface, an irreversible apply
without `JIRA_ALLOW_IRREVERSIBLE` is refused by a named test, `core/http.ts` is
still the only module that touches the network (binary and multipart went into
it, not beside it), and the gate is green at 1265/1265 with the D36 coverage
floors intact.

## Risks

| Risk | Mitigation |
|---|---|
| `search/jql` token instability (community-reported) | restart-with-guard strategy (CC-01); fixture for expired-token response |
| ADF fidelity complaints (formatting lost) | explicit v1 scope (plain text), markdown subset tracked for v1.5 |
| Scoped-token permission surprises | doctor probes per-endpoint; error remediation names the scope |
| Rate limits under agent load | semaphore + capped Retry-After honouring; hints teach the model to narrow fields/maxResults |
| Scratch-site drift in fixtures | fixtures redacted + stable placeholders; record script versioned |
| Scratch site absent when Phase 1 exit needs it | Phase 0 owner task with an explicit checklist (site + both project types + ADF sample data + second user + token) |
| Multi-week pause (solo side project) | WORKLOG + plan checkboxes kept current every session; donor SHAs pinned; park only at phase exits |
