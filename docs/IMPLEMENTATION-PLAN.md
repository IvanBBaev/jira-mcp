# Implementation plan

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. Phases 0–7 with their exits are the milestone truth for this
> project; a phase is done when its exit criteria hold, not when its tasks look
> finished.

> Parallel-execution overlay: `docs/WORK-PACKAGES.md` decomposes these phases
> into agent-sized work packages (waves, file ownership, owner gates A–C). The
> phases below remain the milestone truth; the overlay is scheduling only.

## Standing decisions

The ledger is **DECISIONS.md** (accepted `D-nn` rows, owner decisions `O-nn`,
gates A–C). The plan below references decisions by id and never restates their
content — nor which ids exist, nor which are still open. Those are the ledger's
to state, and an id range copied here is a number that rots while the ledger
stays right.

Everything that is still open is owner-gated rather than unwritten. The publish
runbook for the mechanical half is [RELEASING.md](RELEASING.md).

## Phase 0 — Scaffold  ✅

- [x] `git init`; AI-harness files excluded via `.git/info/exclude`.
- [x] `docs/` spec set (this directory).
- [x] `package.json` (`type: module`, engines ≥22, `mcpName:
      "io.github.IvanBBaev/jira-mcp-ai"`, deps: SDK ^1.30 + zod `^3.25` (D9;
      superseded — the shipped range is `^4.4.3` since D82) —
      **no dotenv**, env files load via `process.loadEnvFile()` (D10); `files`
      allowlist with explicit negations verified by an `npm pack --dry-run`
      tarball-content assertion in `check`), `tsconfig.json` (ES2023, NodeNext,
      strict, noUncheckedIndexedAccess, rootDir src), `.c8rc.json`, prettier
      (`singleQuote`, `printWidth: 90`), `eslint.config.js` copied from
      facebook-mcp with layer zones renamed.
      *Two deltas from what this line originally said.* The nominative-use
      `trademark` note was dropped in Wave 8 — npm does not render the field, so
      it was decoration with a maintenance cost. And the allowlist negations are
      not the ones sketched here: the shipped set excludes maps, compiled tests,
      `build/testing` and `build/core/fakes` from `build/`, because `files` is an
      allowlist of two directories rather than a whole-tree filter. The
      assertion (`scripts/check-tarball.mjs`) is the normative statement of what
      ships; this line is not.
- [x] `scripts/docs-lint.mjs` — mechanical docs-regime checks (single-writer
      fact ownership per docs/README.md, CC-nn/D-nn/O-nn references resolve,
      status banners present); wired into `npm run check`. Grew past this scope:
      eight checks now, including version-pin mirroring (D61/D68), test-claim
      binding (D74), a guard against calling a resolved owner decision open, and
      corner-case citations checked in `src/**` and `scripts/**` as well as docs.
- [x] `bin/jira-mcp-ai.cjs` two-file Node guard — `.cjs`, ES5-parseable, so
      ancient Node prints the version message instead of a syntax error
      (tiktok-mcp lesson); `.nvmrc` (24), `.editorconfig`, `.gitattributes`,
      `.npmrc`, `.env.example`. The old-Node behaviour was proven against the
      real tarball in Wave 11 rather than by CI probe: the shim refuses readably
      on Node 20 and exits 1.
- [x] CI: `.github/workflows/ci.yml` (check on Node 22/24), `dependabot.yml`
      (npm + actions, weekly, 7-day npm cooldown); `codeql.yml` shipped in
      Wave 9 once the repo was public — as an **advanced-setup** workflow, which
      is why CodeQL default setup must stay off (D67, RELEASING.md §1).
- [x] Root `README.md` with generated-tools markers; `CHANGELOG.md`,
      `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (MIT). `CODE_OF_CONDUCT.md`,
      issue forms and a PR template joined them in Wave 9 (D67).

- [x] OWNER: authorize the initial commit + create the GitHub repo. Done, and
      not as written: the repo is **public**, because O-10 resolved that way on
      2026-08-15 before the first push landed on 2026-08-17 (`a8cb4b0`, on top
      of the two scaffold commits). O-1's row in the ledger still says
      "private"; that wording is stale, not a second decision.
- [ ] OWNER: provision the scratch Jira Cloud site (free tier): team-managed
      AND company-managed project, rich-ADF sample issues per TESTING.md, a
      second user, API token. Needed by the Phase 1 exit, Phase 2b fixtures,
      and Phase 4. **Still open — this is Gate C (O-2), the single largest
      unclosed item in the project.** Narrowed twice. On 2026-08-17 the read
      phase and the doctor preflight ran green against a live company tenant. On
      2026-08-18 the write phase ran against a sandbox project on the same
      tenant and applied thirteen write tools, which leaves a smaller and much
      more specific ask: a site where the account may **administer a project and
      delete issues**. Without that, seven tools cannot be proven anywhere and
      the gate cannot clean up after itself — the 2026-08-18 run stranded two
      issues it was not allowed to delete. (The other five still unproven — the
      sprint writes — need no permission, only another run: the gate's own
      over-long sprint name stopped them, and that is fixed.) Fixture recording
      still needs the same site.

Exit: `npm run check` green on an empty-but-wired repo (one placeholder test).
**Met.** The gate has been green continuously since Phase 1 and is now green on
the full tree.

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
      owner decisions (initial commit = Gate A, npm name reservation) went into
      DECISIONS.md as O-1 and O-9, undecided at the time; that ledger carries
      their status now.
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
      default at this phase close as **D14**. Recorded ≠ decided: at this close
      every owner decision other than O-7 was still carrying its default and its
      decide-by date (extended-panel doc §E-P3).
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

**Status 2026-08-09: both exits met on the spec side.** Everything that did not
require an owner decision was written down; what remained of this phase were the
owner decisions in DECISIONS.md, of which only **Gate A (O-1)** blocked starting
work — and that gate has since been resolved.

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
      token). **Half done.** Both synthetic fixtures exist and are marked
      `"synthetic": true`; the recorder that would capture the rest exists
      (`scripts/record-fixture.mjs`, D70/D71, Wave 9) and its redaction is
      itself tested (D75, Wave 10). The recording is what is missing, and it is
      blocked on Gate C. Wave 10 explicitly refused to synthesize the remainder
      against the offline fake — that would launder the fake's assumptions into
      files labelled as recorded from Jira.

Exit (**Milestone M1 — first runnable artifact**): wire-tier HTTP policy tests
green (retry matrix, allowlist, headers; CC-11…15, CC-27…30); `doctor`
exits 0 with all probes green against the scratch site. **Met, 2026-08-17** —
the wire tier since Phase 1, and `doctor` now on a live tenant: it exited 1 on
first contact (the unbounded search probe, D88) and exits 0 with 6 passed / 4
informational since the fix. The site was a company tenant rather than the
scratch org, so the probes that would write are still unexercised.

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
      (scratch site); synthetic fixtures are in place. Same item as the Phase 1
      one above; it is listed twice because it gates two exits.

Exit: every `reader`-profile tool returns `ok: true` in a scripted pass against
the scratch site; c8 thresholds (70/60/75/70) enforced in `npm run check` from
this phase on; CC-16…19 covered. **Coverage half met and long since exceeded**
(D36 raised the floors in Wave 5); the scripted pass exists as
`scripts/verify-live.mjs`, was rehearsed offline first (D72), and **has now run
against a live tenant** — read half green on 2026-08-17, write half partially
green on 2026-08-18. Every `reader`-profile tool it exercises returned
`ok: true`; what the run did not reach is the ten write tools listed under
Gate C below.

## Phase 4 — Writes

- [x] `mcp/write-mode.ts` (plan/apply gate), optional write journal.
- [x] `api/issues.ts` write side + `api/agile.ts` sprint move.
- [x] Tools: create, update, transition, comment, assign, worklog, link,
      move-to-sprint. CC-20…24.
- [x] End-to-end write test against a live Jira site — **run 2026-08-18**, on a
      sandbox project rather than the scratch org this line assumed. Thirteen
      write tools applied against Atlassian; seven are still unproven for want of
      project-admin and delete permissions, and five more — the sprint writes —
      because the gate asked for a sprint name past Jira's undocumented cap.
      It did not land where this line predicted in shape either: there
      is no `scripts/smoke/`, because the driver grew into
      `scripts/verify-live.mjs` (C01–C26 in Wave 8, the agile write surface
      C27–C30 in Wave 10, the site confirmation and residue claims C00 and
      C31–C33 in Wave 13, votes/transitions/links/comment edits/components as
      C37–C41 in Wave 14), reads-by-default with `--write` and `--irreversible`
      opt-ins, refused outright unless the operator names the host. It has been
      rehearsed against a stateful offline fake (D72) — the pass set is
      TESTING.md's to state — which is evidence about the *driver*, not about
      Jira.

Exit: the full tool surface locked by the TOOLS.md catalog and manifest
snapshot; write path proven on a real site in both plan and apply modes.
**First half met** (snapshot test + generated README); the second half is
Gate C, whose **read phase ran green on 2026-08-17** (19/19 on a live company
tenant, RELEASING.md §6) and whose **apply phase ran on 2026-08-18** — both
modes are now proven on a real site, plan by C14/C15 and apply by the thirteen
writes that landed. It is a partial pass, not an exit: four claims came back as
permission refusals the tenant is entitled to give, so ten tools stay unproven
and the run stranded artifacts it was not allowed to delete (D73). That is why
what published on 2026-08-17 is `0.9.0`, what published on 2026-08-18 is
`0.9.4`, and neither is `1.0.0` (D87).

## Phase 5 — Hardening & release

- [x] Raise coverage thresholds; property tests; audit in check. (Wave 5:
      floors 94/82/97/94 enforced by `check` via `test:coverage` — D36.)
- [x] `server.json` (MCP registry manifest), `.claude-plugin/` plugin +
      marketplace manifests, generated README finalized. (Wave 5 — D37;
      plugin source stays `"./"` until an npm publish exists.) Wave 12 put the
      three manifests under a test rather than under review — TESTING.md
      suite 10 checks them against CONFIGURATION.md and pins their four version
      fields to `package.json`'s, which is the half of the release runbook's
      version-bump set a file can enforce.
- [x] Decide npm publish (`jira-mcp-ai`) vs private — **O-9 resolved 2026-08-17:
      publish.** Everything the decision needed was already built and inert
      (D37): `publish.yml` via npm **trusted publishing** (GitHub OIDC; needs
      npm ≥ 11.5 → Node 24 release runner), with one correction found on the way
      out — a trusted publisher cannot be registered for a package that does not
      exist, so 0.9.0 is bootstrapped with the `NPM_TOKEN` secret and the secret
      is deleted immediately after (D86, RELEASING.md §5). Classic tokens were
      revoked 2025-12 and granular tokens cap at 90 days, which is exactly why
      the token is a one-run credential rather than the mechanism.
      Also in place: `prepublishOnly` chaining `check:publish` (D62) plus the
      map-free publish build and its tarball assertion (RELEASING.md §3.1),
      tarball-content assertion (`npm pack --dry-run` vs expected list, which
      also follows `exports`/`main`/`types`/`bin` since Wave 11), CHANGELOG
      discipline, version 0.9.0 (D87). The name was free on the registry
      (`npm view jira-mcp-ai` → E404, checked 2026-08-17) and had been
      advertised on an indexed Pages site since 2026-08-12, so the squatting
      risk was real and growing. Publishing closed it: `jira-mcp-ai` 0.9.0 is on
      npm as of 2026-08-17, unscoped, with a provenance attestation — the
      fallback `@ivanbbaev/` scope was never needed.
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
      visibility + CodeQL. **Partly closed.** Visibility resolved 2026-08-15
      (O-10: public) and CodeQL ships as a workflow (D67), so both halves of the
      "revisit" are answered. The secrets are not: the `live` environment exists
      and holds none (checked 2026-08-17). That was consistent while no tenant
      existed; since 2026-08-18 one does, and the reason has changed rather than
      gone away — the credentials that ran the gate belong to a company tenant
      whose `SAN` project this repository has no standing claim on, so putting
      them in a public repository's environment is a decision for whoever owns
      the site, not a chore. The remaining repository settings are enumerated
      with their measured state in RELEASING.md §1.

Exit: coverage raised per TESTING.md (or a lower target recorded with
rationale); all corner cases then defined (CC-01…CC-35) traceable to named
tests; publish decision
recorded in the decision table (publish → v0.9.0 tagged + `publish.yml` green;
private → pinned version, README states the distribution mode).

Status 2026-08-17: the coverage and traceability halves are met and have since
been generalized — every corner case the ledger defines, not only CC-01…CC-35,
is bound to a test *name* under `src/**` and the binding is mechanically checked
(D74, Wave 10). The publish decision is not recorded, because it is O-9 and
nobody but the owner can record it. This exit therefore stands at "met except
for the one clause that is a decision".

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
it, not beside it), and the gate was green at 1265/1265 with the D36 coverage
floors intact. That count is the reading on the day this exit was signed off,
kept as the historical record; the current one is in the snapshot below.

## After Phase 7 — hardening waves, not a Phase 8

Phases 0–7 are closed. Everything since has been hardening on an
implemented server, run as agent waves against the existing phases rather than
as new ones, so there is deliberately no Phase 8 to open: nothing below adds
scope, and a phase that adds no scope is bookkeeping. The waves are recorded
here because the phase list alone would suggest the project stopped on
2026-08-14, and this document is supposed to be the milestone truth.

| Wave | Date | What it closed |
|---|---|---|
| 8 | 2026-08-14 | `core/http.ts` hardening (per-attempt guard covers headers and body; the media 303's two legs share one attempt timeout; a 2xx with a failed body is a transport failure, not a silent empty success). Status banners flipped to "normative and implemented" (D59). Gate C kit written: the owner runbook plus `scripts/verify-live.mjs`. First release audit. |
| 9 | 2026-08-15 | Adversarial pass: redactor depth cap is a stack bound, not a log-field bound (D64); the media store refuses a symlink escaping `JIRA_MEDIA_DIR` (D65); taint delimiters escaped inside their own JSON (D66); a short write is a failure, not a result (D69). Community-health layer and CodeQL as advanced setup (D67/D68). Fixture recorder (D70/D71). Gate C rehearsed offline against a stateful fake (D72). [RELEASING.md](RELEASING.md) written. |
| 10 | 2026-08-16 | The corpus's test claims made mechanical: every normative test tag carries a pointer and every corner case appears in a test *name* (D74) — the backlog of unbound claims went to zero rather than being grandfathered. Fixture PII lint implemented (D75). Gate C extended over the agile write surface, accepting that each `--write` run strands a sprint (D73). Media-store audit returned an honest null result (D76). |
| 11 | 2026-08-17 | The **shipped artifact** audited rather than the source: a cold install of the real tarball starts, answers `initialize` + `tools/list`, and keeps stdout protocol-pure; the Node floor is proven by refusal, not argued. `exports` gained `./package.json`; `check-tarball` now follows the manifest instead of a hand-maintained table. Three of four agents were killed mid-edit by a usage limit — their findings are lost, and `cli/doctor.ts` went back into the queue because of it. **First push**: `a8cb4b0`. |
| 12 | 2026-08-17 | Release mechanics and the last deferrals. The publish build (RELEASING.md §3.1) removes the dangling `sourceMappingURL` footer every shipped file used to carry, and RELEASING.md §1 now records the measured state of each repository setting instead of an undated claim that they are all off. The distribution-manifest suite (TESTING.md suite 10) is why the version-bump set is now guarded by a test. A placeholder credential can no longer shred the diagnostics silently — it is warned about by name (D79) — and `doctor --json` emits JSON a parser will take even when it does (D81), after two real bugs in that command. All three deferred dependency majors landed (D82, closing O-14), and the hole that made them risky closed with them: the manifest snapshot now records every emitted JSON Schema, not just its key list (CC-82). |
| 13 | 2026-08-17 | Gate C stopped being a procedure and became one command that refuses to run against a site the operator has not named (D83), ends every run with an inventory of the five residue classes it leaves and a `--purge` for the removable ones, and is rehearsed offline over eleven passes instead of seven. Two fail-closed corrections: an environment value still holding a client's `${…}` placeholder is a failure rather than a credential (D84), and the redaction step now refuses a result it cannot re-read instead of falling back to the unredacted envelope (D85). The **stranger's-eye** audit of the install path found the flagship registration snippet was tagged `jsonc`, carried a U+2026 where the token goes, and could not be parsed by anything a user would paste it into; it is valid JSON in all four places now, and the two things that actually break a first run — Claude Desktop's minimal PATH, and where stderr goes — are written down for the first time. docs-lint grew check 8, so code may cite a corner case only if the ledger defines it. |
| 14 | 2026-08-18 | The gate's tool coverage closed. Seven tools — votes (add/remove), transition, link, comment edit, component create/update — had no claim at all; all seven are writes, so none could be reached from the read half. C37–C41 cover them, and two buy more than a checkbox: C38 proves a transition id is read off the issue rather than remembered (CC-21 from the refusal side as well as the happy path), and C40 proves comment edits replace the whole body (CC-31) against Atlassian's own ADF converter rather than against ours. C39 links a **second** throwaway issue instead of a tenant issue, because a link has no delete tool either — both ends must be issues the gate created and removes. C41 records the cost honestly: a component is the **third** artifact a `--write` run strands (D73), and its note says so on screen. The offline fake gained the fidelity the new claims depend on: Jira's own-reporter vote 404, a validating `POST /issueLink` that records state, and real `issuelinks` on reads emitted from one side only, the way Jira does — a fake that echoed both ends would let a direction bug through. Then the write phase **ran live** for the first time, against the tenant's `SAN` sandbox: 33 PASS / 5 FAIL / 3 SKIP, thirteen write tools proven against Atlassian, and one defect that eleven green offline passes had no way to see — Jira caps a sprint name at 29 characters and the gate's was 32, so C27 took C28–C30 down with it. Fixed in the driver, enforced in the fake, and written into JIRA-API.md because the Cloud reference does not state the cap. The other four failures are the account's missing project-admin and delete permissions on that project, each reported with the right kind and a remediation naming the permission — D90's behaviour observed rather than asserted. |
| 15 | 2026-08-18 | **0.9.4 shipped**, carrying the three defects the live runs found (D88, D89, D90) and nothing else — the tool surface is byte-identical to 0.9.0. The corpus was swept for claims the tenant had made false: the site's hero badge still said "not on npm yet" and its FAQ still said there was nothing to install, a day after 0.9.0 published; README's status banner said the same. The live-coverage number was wrong everywhere it appeared — "42 of 52" had been reached by adding thirteen applied writes to a read-phase count of 29 that itself double-counted two tools exercised in *plan* mode only, where no request is sent. Recounted from the run log against the registered tool list: **40 of 52**, all 27 reads and 13 of 25 writes, with 12 outstanding (seven on permission, five on the sprint name). The lesson is the same one C38 encodes about transition ids — a number worth publishing is read off the artifact, not remembered. |

**Snapshot, 2026-08-18.** Full suite green: 1488 tests across 63 files,
coverage 98.13 statements / 92.99 branches / 98.46 functions / 98.13 lines
against the D36 floors of 94 / 82 / 97 / 94; `scripts/docs-lint.mjs` reports 17
files clean. These are measurements, not commitments: the counts move with every
wave, and the floors — not the counts — are the thing the gate enforces. Treat a
mismatch here as this line being stale, and the floors in TESTING.md as the
claim with teeth.

### What is left, and why none of it is code

Nothing in the remaining work is blocked on a keyboard:

- **Gate C (O-2)** — a scratch Jira Cloud site. Half of this is now done: the
  read phase ran green against a real tenant on 2026-08-17 (22 claims, exit 0),
  which cost three defects no fixture could have produced (D88, D89, D90) and
  proved all 27 read tools against Atlassian. The write phase then ran on
  2026-08-18 against the same tenant's `SAN` sandbox project — **33 PASS, 5 FAIL,
  3 SKIP** — which applied 13 of the 25 write tools and took the live-proven
  surface to 40 of 52, at the cost of one defect in the gate's own naming (Jira
  caps a sprint name at 29 characters; ours was 32, and four claims died behind
  it). What it did **not** do is close the gate: the account is not a project
  administrator on `SAN` and cannot delete issues there, so seven write tools —
  the watcher pair, the version pair, the component pair and `jira_delete_issue`
  — came back as correctly shaped permission refusals rather than as proof they
  work. Those seven, the five sprint writes that the naming defect stranded, and
  a site where the gate can clean up after itself, are what still stand between
  0.9.4 and 1.0.0 (D87). RELEASING.md §6 has the full account.
- ~~**O-9**~~ — resolved 2026-08-17: published. It cost one repository variable,
  one environment and one tag, as the inert-by-construction design intended
  (D37). What it left behind is the bootstrap token to retire (D86,
  RELEASING.md §5).
- **Repository settings** — enumerated with their measured values in
  RELEASING.md §1. Six of the eight are readable without a browser; changing
  any of them still is not.

## Risks

| Risk | Mitigation |
|---|---|
| `search/jql` token instability (community-reported) | restart-with-guard strategy (CC-01); fixture for expired-token response |
| ADF fidelity complaints (formatting lost) | explicit v1 scope (plain text), markdown subset tracked for v1.5 |
| Scoped-token permission surprises | doctor probes per-endpoint; error remediation names the scope |
| Rate limits under agent load | semaphore + capped Retry-After honouring; hints teach the model to narrow fields/maxResults |
| Scratch-site drift in fixtures | fixtures redacted + stable placeholders; record script versioned |
| Scratch site absent when Phase 1 exit needs it | **Materialized, and it stayed the project's critical path until 2026-08-17.** The mitigation held only in the sense that the checklist exists and the work routed around the absence: seven phases were completed and the live driver was rehearsed offline instead. What it did not do is stop the gap from compounding — every phase since Phase 1 closed with a Gate-C clause outstanding, and when a tenant finally arrived the first two runs found four defects in a day (D88–D90 plus the gate's own sprint name). Now shrinking rather than compounding: 40 of 52 tools are proven live, and what is left is a permission grant, not a site. |
| Multi-week pause (solo side project) | WORKLOG + plan checkboxes kept current every session; donor SHAs pinned; park only at phase exits |
