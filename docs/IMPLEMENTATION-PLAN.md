# Implementation plan

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. Phases 0–13 with their exits are the milestone truth for this
> project; a phase is done when its exit criteria hold, not when its tasks look
> finished. Phases 0–12 are closed; Phase 13 is open (stages 13.1–13.7 done).

> Parallel-execution overlay: `docs/WORK-PACKAGES.md` decomposes these phases
> into agent-sized work packages (waves, file ownership, owner gates A–C). The
> phases below remain the milestone truth; the overlay is scheduling only.

<!-- release-progress:begin -->
## Release progress (Opus 5.5 hours)

> Maintained by the `relase-opus-5-5-persentage` skill. Unit: wall-clock hours
> of one autonomous Opus 5.5 session at this project's gate standard.
> Numbers are computed by the skill's script from the table below.

| | |
|---|---|
| Release target | `1.0.0` — the version published after Gate C closes on Cloud (D87, RELEASING.md §6) (current version `1.0.0`, released by owner decision before Gate C closed — D121) |
| Progress | **88.4 %** — 153 h of 173 h earned |
| Remaining | **20 h** Opus 5.5 (0 h workable now, 20 h blocked) |
| Blocked by | test-account permissions (project admin, delete, bulk changes); a live `--write` run of Gate C; npm trusted publisher + token revoke (D86); leaked API token rotation; `live` Actions secrets |
| Calibration | Phase 13.1–13.3 landed in ~1.5 h of commits (2026-09-26 13:51→15:14); defect hunts 17–20 ran ~1 h each (2026-10-10 18:43→22:43); phases 9–12 took one session of 4–5 h each |
| Updated | 2026-10-16 at `8b03d46` |

Out of target: verifying the Data Center preview against a real DC host
(Phase 13 exit, D104/D106). It stays a labelled UNVERIFIED preview and does not
block `1.0.0`.

| ID | Item | Source | Status | Est h |
|---|---|---|---|---|
| D01 | Phases 0–0.5: scaffold and spec revision | Phase 0, Phase 0.5 | `done` | 8 |
| D02 | Phases 1–3: core, MCP layer, ADF, full read surface | Phases 1–3 | `done` | 16 |
| D03 | Phase 4: writes behind the plan/apply gate | Phase 4 | `done` | 8 |
| D04 | Phase 5: hardening and release engineering | Phase 5 | `done` | 8 |
| D05 | Phase 6: v1.5 graduation (D38) | Phase 6 | `done` | 6 |
| D06 | Phase 7: v2 subset (D45) | Phase 7 | `done` | 6 |
| D07 | Waves 8–13: hardening, Gate C kit, doctor, dependency majors | After Phase 7 | `done` | 18 |
| D08 | First publish, `0.9.0` | RELEASING.md §5 | `done` | 2 |
| D09 | Gate C read half live (C1–C41 read claims) | RELEASING.md §6 | `done` | 4 |
| D10 | Gate C write half, first live run, and `0.9.4` | RELEASING.md §6 | `done` | 4 |
| D11 | Phase 8: OAuth 2.0 (3LO) | Phase 8 | `done` | 8 |
| D12 | Phase 9: markdown mention resolution (D100) | Phase 9 | `done` | 4 |
| D13 | Phase 10: loopback Streamable HTTP transport (D101) | Phase 10 | `done` | 4 |
| D14 | Phase 11: component, version and sprint deletes (D102) | Phase 11 | `done` | 4 |
| D15 | Phase 12: bulk operations (D103) | Phase 12 | `done` | 5 |
| D16 | Review fix pass over phases 9–12 | WORKLOG 2026-09-07/08 | `done` | 4 |
| D17 | Coverage sweep, defect hunts 1–22, owner sweeps D118/D119 (CC-134…CC-430) | CORNER-CASES.md | `done` | 28 |
| D18 | Phase 13.1–13.8: Data Center preview, 47 tools (D106–D117) | Phase 13 | `done` | 16 |
| R01 | Register the npm trusted publisher, delete `NPM_TOKEN`, revoke the token (D86) | RELEASING.md §5 | `blocked-owner` | 0.5 |
| R02 | Rotate the API token pasted in chat; delete stranded `SAN-1204`/`SAN-1205` | CLAUDE.md status | `blocked-owner` | 0.5 |
| R03 | Grant the test account project admin, delete and "Make bulk changes" on the sandbox | RELEASING.md §6 | `blocked-owner` | 0.5 |
| R04 | Gate C `--write` run over the 18 unproven tools, incl. `jira_link_issues` direction | RELEASING.md §6, README status | `blocked-external` | 4 |
| R05 | Fix what that run finds (each past live run found 3–4 defects) | Risks table | `blocked-external` | 6 |
| R06 | Record the minimum fixture set against the live site | Phase 1, Phase 3 open items | `blocked-external` | 3 |
| R07 | `live` environment `JIRA_*` secrets; weekly live suite green | Phase 5 open item | `blocked-owner` | 1 |
| R08 | Flip docs to 1.0.0: README status, live counts, CHANGELOG, RELEASING, site | D87, D121 | `done` | 3 |
| R09 | Publish `1.0.0`: tag, publish workflow, registry and provenance checks | RELEASING.md §4–§5, D121 | `done` | 1.5 |

### History
- 2026-10-13 `6484ffb` — 88.4 %, 20 h left (first run; baseline)
- 2026-10-14 `22ee78f` — 88.4 %, 20 h left (±0 pp; 22nd hunt and CC-430 fold into D17, already `done`; no status, estimate or scope change — every remaining row is still owner/external-blocked)
- 2026-10-16 `5f605ca` — 88.4 %, 20 h left (±0 pp; 57 commits — defect hunts 23–36 (CC-5xx–CC-8xx), the 0.9.5 changelog, CI action bumps — are quality work outside the 1.0.0 rows; no status, estimate or scope change, every remaining row still owner/external-blocked)
- 2026-10-16 `8b03d46` — 88.4 %, 20 h left (±0 pp; 23 commits — defect hunts 37–43 (CC-860/861, CC-880, CC-900, CC-920–922, CC-960–964, CC-980–982) — are quality work outside the 1.0.0 rows; no status, estimate or scope change, every remaining row still owner/external-blocked)
<!-- release-progress:end -->

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
      over-long sprint name stopped them, and that is fixed.) Phases 11 and 12
      then widened the ask without reopening it: the three D102 deletes have
      never met Atlassian and need the same project-admin grant, and the three
      D103 bulk tools landed after the last run — the two writes also need
      site-wide "Make bulk changes". Eighteen of 58 unproven, one grant and one
      run away. Fixture recording still needs the same site.

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

Status 2026-08-18: that clause is met too. O-9 resolved on 2026-08-17 by
publishing rather than reserving — `jira-mcp-ai` 0.9.0 from tag `v0.9.0` with
`publish.yml` green, and 0.9.4 from `v0.9.4` the next day (D86, RELEASING.md
§5). What the publish left behind is the credential sequence in §5 — trusted
publisher, then delete `NPM_TOKEN`, then revoke — which is owner work after the
exit, not a clause of it.

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

## After Phase 7 — hardening waves 8–15

Phases 0–7 are closed. Waves 8–15 were hardening on an implemented server, run
against the existing phases rather than as new ones, because none of them added
scope and a phase that adds no scope is bookkeeping. They are recorded here
because the phase list alone would suggest the project stopped on 2026-08-14,
and this document is supposed to be the milestone truth.

This section used to say there would deliberately never be a Phase 8. That held
for as long as the remaining work was hardening. It stopped holding on
2026-08-21, when OAuth 2.0 (3LO) graduated out of ROADMAP.md (D91): it adds an
auth mode, a module, a CLI command, an env block and a second origin, which is
scope by any reading. The rule was never "no more phases" — it was "no phase
without scope", and Phase 8 below is what that rule looks like when the
condition is finally met.

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

### What was left outside Phase 8, and why none of it was code

Status as written on 2026-08-18, kept as the record of that point: Phase 8 was
the code still to come (phases 9–12 followed and closed — see below), and
everything else outstanding was blocked on an owner action rather than on a
keyboard:

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
  a site where the gate can clean up after itself, were what stood between
  0.9.4 and 1.0.0 at the time (D87). Phases 11 and 12 have since added six tools
  that have never run live — the D102 deletes and the D103 bulk tools — so the
  count is eighteen of 58 now; the Phase 0 O-2 note above and RELEASING.md §6
  keep the current account.
- ~~**O-9**~~ — resolved 2026-08-17: published. It cost one repository variable,
  one environment and one tag, as the inert-by-construction design intended
  (D37). What it left behind is the bootstrap token to retire (D86,
  RELEASING.md §5).
- **Repository settings** — enumerated with their measured values in
  RELEASING.md §1. Six of the eight are readable without a browser; changing
  any of them still is not.

## Phase 8 — OAuth 2.0 (3LO) (graduated by D91)

Five work packages with disjoint file ownership, dispatched as parallel agents on
2026-08-21. The ids are local to this phase: `docs/WORK-PACKAGES.md` decomposes
the v1 phases and was not re-cut for this one, so do not go looking for WP-80
there.

- [x] WP-80: `core/oauth.ts` — the flow logic and nothing else. Authorize-URL
      construction, PKCE S256 derived from `node:crypto` through the injected
      `CryptoRandom` and never from `Rng` (D96), the code exchange and the
      refresh as JSON bodies rather than form-encoded (JIRA-API.md §OAuth 2.0
      (3LO)), refresh-token rotation on every use, expiry arithmetic on the
      injected `Clock` with a skew margin, single-flight refresh under
      concurrent tool calls (CC-98), the terminal/retryable split that keeps a
      token POST from ever being replayed (D94, CC-100), and cloudId discovery
      including the several-sites-no-pin case (CC-103). The module makes no
      network call of its own — it goes through the injected `AuthRequestFn`
      (D93), so `core/http.ts` stays the only fetch site.
- [x] WP-81: `core/http.ts` and `core/host.ts` seams — one Authorization
      producer switching on the `JiraCredentials` discriminated union (D92); the
      gateway base URL in oauth mode, with a cloudId that is not a plain
      identifier refused before it can become a path segment (CC-101); the two
      OAuth origins added to the host allowlist only when the mode is oauth
      (D97); no redirect following on the auth origin.
- [x] WP-82: settings, credentials and config — the `JIRA_AUTH_MODE` switch and
      the `JIRA_OAUTH_*` block, validated per mode so a half-configured oauth
      profile fails as configuration at startup rather than as an auth error on
      the first tool call (CC-102); the async `CredentialResolver` (D92) that
      reads, refreshes and rewrites the token store; the store itself at 0600,
      written atomically, and a rotated refresh token persisted before it is
      used (D95, CC-99). CONFIGURATION.md and `.env.example` move with this
      package — the env table is set-equal to the code by test, so it cannot
      drift.
- [x] WP-83: `login` / `logout`, doctor and dispatch — the loopback callback
      bound to the loopback address only (CC-104), `state` compared before the
      code is spent (CC-97), the browser hand-off, the refusals (wrong mode,
      missing client id, port already bound), doctor probe 11 and the reworded
      probe 9 (AUTH.md), and stdout kept protocol-pure in every mode, `--json`
      included.
- [x] WP-84: the documentation corpus — AUTH.md's OAuth narrative and the
      per-tool-family scope map, D91…D99, CC-97…CC-104, the two token events in
      OBSERVABILITY.md, the wire facts and the endpoint table in JIRA-API.md,
      threat 9, the offline OAuth suite in TESTING.md, and this section.
- [x] Integrator: cross-file wiring, `npm run check`, and the manifest snapshot
      only if the tool surface moved — it should not, because OAuth adds an auth
      mode, not a tool.

Exit: `login` obtains a grant and stores it; every existing tool serves through
the gateway with an access token; a rotated refresh token survives a restart; a
terminal refresh failure ends the session with a remediation naming `login`
instead of a retry storm; `core/http.ts` is still the only module that touches
the network; `scripts/docs-lint.mjs` is clean, which now requires each of the
eight new corner cases (CC-97…CC-104) to be carried by a test name; gate green
with the D36 coverage floors intact.

Deliberately **not** in that exit: proof against a real Atlassian tenant. Phase 8
can be finished offline, but it cannot be *believed* offline — the redirect URI
this design registers is unverified (D99), and Phase 1's risk row is the standing
lesson about what an untested assumption costs when it is finally run. The live
half belongs to Gate C, not to this phase's exit.

Status 2026-08-21: **closed offline.** The integrator ran the gate on the merged
tree: `npm run check` exits 0 — 1679 tests, 0 failures, 97.9 % statements /
92.19 % branches / 97.79 % functions against the D36 floors, `docs-lint: 17
file(s) clean` (so CC-97…CC-104 are each carried by a test name), and
`npm audit --omit=dev` reports no vulnerabilities. The tool surface did not move,
so the manifest snapshot was not re-taken; `server.json` gained the nine
`JIRA_*` rows and nothing else.

That closes the offline half and only the offline half. Nothing above has been
run against Atlassian: no `login` has completed a real authorize → exchange, no
access token has served a real tool call through the gateway, and the redirect
URI (D99) is still the unverified assumption it was when this section was
written. Until Gate C covers the OAuth path, every claim here is a claim about
the suite, not about the product.

## Phase 9 — Markdown mention resolution (graduated by D100)

Four work packages with disjoint file ownership, dispatched as parallel agents
on 2026-08-29. As with Phase 8, the WP ids are local to this phase —
`docs/WORK-PACKAGES.md` decomposes the v1 phases and was not re-cut for this
one.

- [x] WP-90: `api/adf.ts` — the `@[name]` grammar in the inline scanner, one
      code path for both uses: extraction (`extractMentions`, a collector sink)
      and conversion (`adfFromMarkdown` with an optional
      `mentions: ReadonlyMap<string, MentionTarget>` options bag). Code spans,
      fences and `\@[` escapes stay inert (CC-109); unterminated, empty and
      over-long tokens stay literal text; with no map the output is
      byte-identical to the pre-feature converter (CC-108), which is what keeps
      the round-trip property suite valid unchanged.
- [x] WP-91: `api/users.ts` — `resolveMentionNames` over the existing
      user-search machinery: plain query scope (mentionable ≠ assignable), one
      page per name, case-insensitive dedupe under a distinct-name cap refused
      before any search (CC-112), active non-app candidates only (CC-113), the
      unique exact-displayName tiebreak, and `validation` refusals that name
      the failing token and list candidates (CC-106, CC-107) — fail fast on the
      first failing name, document order.
- [x] WP-92: `tools/issues-write.ts` — the `resolveMentions` schema arg on the
      7 rich-text write tools with the superRefine refusal outside markdown
      format, one resolution pass per call across all rich-text fields, the
      `mentions_skipped` hint (and its `HINT_CODES` entry), and resolution in
      the tool ring before the api builder so plan mode captures the exact ADF
      an apply would send (D44 order preserved; CC-105, CC-111).
- [x] WP-93: the documentation corpus — D100, CC-105…CC-113 (with CC-43's
      wording amended in place), the ROADMAP carve-out graduated, the
      `mentions_skipped` catalog row plus the plan-mode and untrusted-content
      amendments in TOOLS.md and THREAT-MODEL.md, the resolver's wire pin in
      JIRA-API.md §Users, the scope note in AUTH.md, suite 12 in TESTING.md,
      and this section.
- [x] Integrator: cross-file wiring, `npm run check`, and the manifest snapshot
      re-taken — the tool surface grew no tool, but 7 input schemas grew an
      argument, and the snapshot locks schemas, not counts. Landed 2026-08-30:
      snapshot regenerated (and prettier-formatted — `JSON.stringify` and the
      repo style disagree on short arrays), one integration fix in the CC-111
      test (its `mentionIds` helper was handed the wire envelope `{ body }`
      instead of the ADF document, so it vacuously saw no mentions), gate green
      at 1715 tests with coverage 97.94/92.34/97.82/97.94 and a clean docs-lint.

Exit: the converter is still pure — resolution happens in the tool ring, and
`core/http.ts` is still the only module that touches the network; the no-map
output of `adfFromMarkdown` is byte-identical to the pre-feature converter;
`scripts/docs-lint.mjs` is clean, which now requires each of the nine new
corner cases (CC-105…CC-113) to be carried by a test name; gate green with the
D36 coverage floors intact.

Deliberately **not** in that exit: proof against a real Atlassian tenant. No
`@[name]` has resolved against a live directory — the exact-match and
ambiguity behaviour of the real user-search endpoint, like everything else this
corpus asserts about the wire, is a claim about the suite until Gate C covers
it (the standing lesson of Phases 1 and 8).

## Phase 10 — Loopback Streamable HTTP transport (graduated by D101)

Three work packages with disjoint file ownership, dispatched as parallel
agents on 2026-08-30. As with Phases 8 and 9, the WP ids are local to this
phase — `docs/WORK-PACKAGES.md` decomposes the v1 phases and was not re-cut
for this one.

- [x] WP-100: `mcp/transport-http.ts` — the listener and everything it
      guards. Bound to `127.0.0.1` only (CC-115); every request passes the
      pipeline in one order — `/mcp` path, `Host` and `Origin` against
      loopback (CC-116), the constant-time bearer check (CC-114) — before any
      JSON-RPC is processed. One MCP session per `Mcp-Session-Id`, each
      holding its own `Server` from the injected factory, destroyed on
      `DELETE` or idle timeout with its plan_id table (CC-117); the idle
      sweeper is an async sleep-loop on the injected `Clock`, so tests drive
      it with fake time over real sockets. Shutdown closes the listener,
      drains sessions and emits `shutdown` once (CC-118). Fails closed
      without `JIRA_HTTP_TOKEN` even if handed settings that should not exist
      past `assertStartupOk` (CC-30, second lock).
- [x] WP-101: the wiring — `mcp/transport.ts` loses the D19 refusal
      machinery (`assertTransportSupported` and the verbatim-asserted message
      die with it), `TransportHandle.transport` becomes optional because each
      http session owns its own; `index.ts` branches at connect time and
      hands the http path a `buildServer` factory instead of an eager server;
      the doctor transport probe reports `http` as a supported answer instead
      of failing it with the v1.5 wording; `.env.example`'s three transport
      comments follow. The two sync tests the design expected to carry
      refusal wording turned out not to — they assert the documented stdio
      default, which is still true, and stand unedited.
      CC-119 — stdout byte-empty under a real http child process — binds in
      `src/index.test.ts`.
- [x] WP-102: the documentation corpus — D101, CC-114…CC-119, the
      ARCHITECTURE §Transport rewrite from kept design to implemented truth,
      the THREAT-MODEL transport and supply-chain amendments, the
      CONFIGURATION transport rows, TESTING suite 13, the ROADMAP graduation,
      the OBSERVABILITY stdout amendment, the site's four transport claims,
      and this section.
- [x] Integrator: removed WP-100's interim boundary cast (the local
      `HttpTransportHandle` bridge died once WP-101 made
      `TransportHandle.transport` optional); fixed one test bug — the CC-117
      plan-death case ran its harness in plan mode, where the gate re-plans an
      `apply: true` call instead of consuming the id, so only
      `writeMode: 'apply'` can show a dead plan being refused; corrected this
      section's WP-101 row (the two sync tests never asserted the refusal —
      design §4.6 was wrong, and they stand unedited). The manifest snapshot
      is deliberately untouched — the tool surface did not change, and the
      snapshot locks schemas, not transports. Gate: `npm run check` exit 0 —
      1727 tests / 82 suites, 0 fail (was 1715); coverage 97.91 / 92.25 /
      97.85 / 97.91 against floors 94 / 82 / 97 / 94; docs-lint 17 files
      clean (binds CC-114…CC-119 to test names); audit 0 vulnerabilities.

Exit: `JIRA_TRANSPORT=http` binds `127.0.0.1:JIRA_HTTP_PORT` and serves the
full tool surface over Streamable HTTP behind the bearer gate; stdio remains
the default and byte-identical in behaviour; `scripts/docs-lint.mjs` is
clean, which now requires each of the six new corner cases (CC-114…CC-119) to
be carried by a test name; gate green with the D36 coverage floors intact.

Deliberately **not** in that exit: proof against a real MCP client. No client
has spoken Streamable HTTP to this listener — the suite drives it with raw
`http.request`, so client behaviours the SDK does not pin (resumability
expectations, SSE reconnects, session reuse across restarts) are claims about
the suite, not about a client, in exactly the sense Phases 8 and 9 reserve
their live-tenant claims for Gate C.

## Phase 11 — Component, version and sprint deletes (graduated by D102)

Three work packages with disjoint file ownership, dispatched as parallel
agents on 2026-09-01. As with Phases 8–10, the WP ids are local to this
phase — `docs/WORK-PACKAGES.md` decomposes the v1 phases and was not re-cut
for this one.

- [x] WP-110: the api layer — `api/collab.ts` gains the component and
      version single-reads (`getComponent`, `getVersion`) and their
      `relatedIssueCounts` companions (a body without a numeric count maps
      to `{}`, never to a guessed zero — CC-66), plus `deleteComponent`
      (`DELETE /component/{id}?moveIssuesTo=`) and `deleteVersion` via
      `POST /version/{id}/removeAndSwap` — the bare `DELETE /version/{id}`
      is deprecated upstream and this codebase never calls it (CC-122,
      bound in `collab.test.ts`); swap targets go on the wire as numbers.
      `api/agile.ts` gains `deleteSprint`
      (`DELETE /rest/agile/1.0/sprint/{sprintId}`); the wire half of CC-124
      binds in `agile.test.ts`.
- [x] WP-111: the tools layer — `jira_delete_component`,
      `jira_delete_version` and `jira_delete_sprint` join the
      `issues-delete` package (id kept so an existing
      `JIRA_PACKAGES_DENY=issues-delete` keeps denying everything
      irreversible — CC-120; the title generalized to "Deletes
      (irreversible)"), all `writeTier: 'irreversible'` behind the D45
      ceremony. Each plan snapshots what it would destroy: the component
      plan carries the blast radius `issueCount` beside the reassignment
      target (CC-121, CC-125), the version plan all three related-issue
      counts (CC-123), the sprint plan the sprint's `state` — an audit
      trail, not a guard (CC-124). The component lead survives as a display
      name only, and absent swap targets read as cleared, never as errors.
- [x] WP-112: the documentation corpus — D102 (completing D50 and
      superseding the sprint-delete half of D73), CC-120…CC-125, the
      TOOLS/ARCHITECTURE/CONFIGURATION/JIRA-API/THREAT-MODEL/TESTING/AUTH
      amendments, the ROADMAP graduation (§v2 shrinks to the DC adapter and
      bulk operations), the README and site count updates (55 tools, 28
      writes, 15 not yet run live), and this section. RELEASING §6's
      residue paragraph now points at the delete tools instead of the UI.
- [x] Integrator: prettier-formatted the regenerated manifest snapshot (the
      `UPDATE_SNAPSHOT` writer does not emit prettier-clean JSON, and
      `format:check` rightly refused it); fixed one test bug — the
      contract-tier fake matches string routes by PREFIX and WP-111
      registered `GET /component/{id}` before
      `GET /component/{id}/relatedIssueCounts`, so the counts read matched
      the shorter rule, answered with the component body, and the
      blast-radius counts silently vanished from the before-state — the
      CC-121 and CC-123 assertions caught it, and the counts routes now
      register first, as the fake's own contract requires; taught
      `scripts/fake-jira.mjs` the five delete-adjacent routes and
      `scripts/rehearse-live.mjs` Pass I the purge truth (component DELETE,
      version removeAndSwap and sprint delete each hit exactly once, no
      `gate-c-` artifact surviving); rewrote the stale `core/settings.ts`
      comment that claimed no sprint-delete tool exists. Gate:
      `npm run check` exit 0 — 1761 tests / 82 suites, 0 fail (was 1727);
      coverage 97.96 / 92.26 / 97.89 / 97.96 against floors
      94 / 82 / 97 / 94; docs-lint 17 files clean (binds CC-120…CC-125 to
      test names); audit 0 vulnerabilities; the full rehearsal
      (`scripts/rehearse-live.mjs`) green across all nine passes, Pass I
      now proving the purge path end to end against the fake.

Exit: the three non-issue deletes exist as first-class tools — plan mode
shows what each would destroy (counts, targets, sprint state) and apply
executes only behind `JIRA_WRITE_MODE=apply` plus `JIRA_ALLOW_IRREVERSIBLE`;
the tool surface is 55 (28 writes, 6 in `issues-delete`, all six
irreversible); `scripts/docs-lint.mjs` is clean, which now requires each of
the six new corner cases (CC-120…CC-125) to be carried by a test name; gate
green with the D36 coverage floors intact.

Deliberately **not** in that exit: proof against a real tenant. None of the
three tools has ever deleted anything on a real Jira site — they are three
of the 15 live-unproven writes (the proven count stays 40, now of 55), and
the `--purge` pass that would prove them has run only against the fake. The
sprint delete additionally sits outside the default OAuth scope set
(`delete:sprint:jira-software`, AUTH.md finding 5), so in oauth mode it is a
scope refusal until the operator widens `JIRA_OAUTH_SCOPES` and logs in
afresh.

## Phase 12 — Bulk operations (graduated by D103)

Three work packages with disjoint file ownership, dispatched as parallel
agents on 2026-09-02, the same cut as Phases 8–11; the WP ids are local to
this phase.

- [x] WP-120: the api layer — new `api/bulk.ts`: `submitBulkDelete`
      (`POST /rest/api/3/bulk/issues/delete`), `submitBulkEdit`
      (`POST /rest/api/3/bulk/issues/fields` — there is no
      `/bulk/issues/edit`; the module builds `editedFieldsInput` and derives
      `selectedActions` itself, in the fixed order labels, priority,
      assignee, fixVersions — CC-130), and `getBulkStatus`
      (`GET /rest/api/3/bulk/queue/{taskId}`), which maps
      `BulkOperationProgress` to counts and takes the documented epoch-millis
      example, not the schema's date-time strings, as the wire truth for the
      three timestamps. Four edit families ship (labels, priority, assignee
      with `user: null` as the unassign, fixVersions);
      `sendBulkNotification` stays off the wire when the caller says nothing
      (CC-131); pairing violations refuse before any request exists (CC-133,
      the D22 shape); a bulk 403 permission failure gains the "Make bulk
      changes" hint on the CC-34 pattern, and an auth 403 passes through by
      identity.
- [x] WP-121: the tools layer — `jira_bulk_delete_issues` and
      `jira_bulk_edit_issues` join `issues-delete` (the id keeps an existing
      `JIRA_PACKAGES_DENY=issues-delete` denying the whole irreversible
      surface — CC-126; the title generalizes a second time, to "Deletes and
      bulk changes (irreversible)"), both `writeTier: 'irreversible'` behind
      the D45 ceremony, the 1..1000 cap enforced in the schema before
      anything is sent (CC-128), and a before-state that is the request's
      own blast radius — a count and the first twenty ids, `truncated` only
      when true — never a pre-fetch (CC-129). The apply answer is a `taskId`
      and an ENQUEUED hint: a 201 means queued, not done (CC-127).
      `jira_get_bulk_status` is a safe read in the `issues` package, so a
      deployment that denies `issues-delete` can still watch tasks submitted
      from the UI (CC-132). CC-120's set equality grows to eight names on
      both sides.
- [x] WP-122: the documentation corpus — D103, CC-126…CC-133, the
      TOOLS/JIRA-API/TESTING/THREAT-MODEL amendments (the threat model no
      longer claims bulk operations stay out of scope), the ROADMAP
      graduation (§v2 shrinks to the Data Center adapter; bulk move,
      transition and watch plus the editable-fields read are parked with
      reasons), suite 15 in TESTING.md, and suite 14's honest denominator
      (17 unproven writes of 30).
- [x] Integrator: taught `scripts/fake-jira.mjs` the three bulk routes (the
      submits mutate immediately, the queue stages
      ENQUEUED → RUNNING → COMPLETE across polls); gave
      `scripts/verify-live.mjs` a `pollBulkTask` helper and two new claims
      in the delete phase — C42 bulk-edits a label onto the run's own
      throwaway issues, polls to COMPLETE and re-reads the label off the
      issue; C43 creates a dedicated throwaway under the anchored gate-c
      summary, bulk-deletes it and proves the re-read is `not_found` — both
      skipping rather than failing on a tenant that withholds the global
      Bulk Change permission; bumped rehearsal Pass A's exact claim count
      41 → 43 and pinned C42/C43 as PASS there; regenerated the manifest
      snapshot and README tables; updated the surface-count test to
      58 / 30 / 8. Two advisories (fast-uri high, qs moderate — both
      transitive via the MCP SDK) arrived upstream mid-phase;
      `npm audit fix` bumped the lockfile six lines and the audit is clean
      again. Gate: `npm run check` exit 0 — 1790 tests / 82 suites, 0 fail
      (was 1761); coverage 98.01 / 92.36 / 97.95 / 98.01 against floors
      94 / 82 / 97 / 94; docs-lint 17 files clean (binds CC-126…CC-133 to
      test names); audit 0 vulnerabilities; the full rehearsal green across
      all eleven passes, Pass A now exercising both bulk claims against the
      fake.

Exit: bulk delete and bulk edit exist as first-class irreversible tools —
plan mode shows the blast radius the request itself names, apply returns a
task receipt rather than a claim of completion, and the queue read reports
the server's own verdict, `invalidOrInaccessibleIssueCount` included; the
tool surface is 58 (30 writes, 8 in `issues-delete`, all eight
irreversible); `scripts/docs-lint.mjs` is clean, which now requires each of
CC-126…CC-133 to be carried by a test name; gate green with the D36
coverage floors intact.

Deliberately **not** in that exit: proof against a real tenant. None of the
three bulk tools has ever spoken to a real Jira site — the proven count
stays 40, now of 58 — and the two submits additionally need the global
"Make bulk changes" permission, which is exactly why C42 and C43 are
allowed to SKIP on a tenant that withholds it. Both claims have run only
against the fake, whose queue reaches COMPLETE in three polls; a real queue
that answers slowly, reorders, or dies with FAILED is territory only Gate C
can survey.

## Phase 13 — Jira Data Center adapter (un-parked by D106)

D104 priced this and parked it; D106 lifts the park on the owner's direction
while keeping D104's order and its verification condition. The phase is cut
into stages so that each one lands green and none leaves a half-working Data
Center mode reachable by a user.

- [x] 13.1 — the domain-level port. `api/port.ts`: `JiraApi` and `CLOUD_API`
      (the existing functions by identity); `ToolCtx.api`; `RegistryDeps.api`
      defaulting to `CLOUD_API`; every tool handler calls through `ctx.api`.
      Converters that are ADF-specific (`adfFromMarkdown`, `extractMentions`,
      `shapeIssueFields`) are port members; backend-neutral pure helpers and
      constants are not. Pinned by `api/port.test.ts` (identity, freeze),
      `tools/port-boundary.test.ts` (no direct import of an api-ring function
      from a tool — named, aliased or `import * as`; a deliberate mutation of
      `tools/core.ts` showed the first draft let an aliased import through,
      and each of the three checks was then seen to fail on a mutated tool) and two registry
      tests (default adapter, injected adapter reaches the handler).
- [x] 13.2 — the settings surface, fail-closed. `JIRA_DEPLOYMENT`
      (`cloud` | `datacenter`), `JIRA_AUTH_MODE=pat` with `JIRA_PAT`, and the
      pairing rule between them (CC-255); `buildPatResolver` on the existing
      `bearer` arm (CC-260), chosen by an exhaustive switch in `src/index.ts`;
      the context path `resolveHost` used to strip, now kept under
      `datacenter` only, with a Cloud host refused and no `.atlassian.net`
      completion (CC-257…CC-259); a `v2` root in `JIRA_ROOT_PATHS`. Selecting
      `datacenter` is a startup error (CC-254), and doctor under it builds no
      request and skips its Cloud-route probes by name (CC-261). A deliberate
      mutation confirmed two guards are load-bearing: removing the fail-closed
      error fails three tests, and removing the basic-only condition on
      doctor's credential source — which let a leftover `JIRA_EMAIL`/
      `JIRA_API_TOKEN` under `pat` become Basic credentials for the DC host —
      fails CC-261.
- [x] 13.3 — a read-only DC adapter, as an unverified preview behind
      `JIRA_DATACENTER_PREVIEW=true` (D107, CC-269). `api/datacenter.ts` serves
      15 read tools (`DATACENTER_TOOLS`); `JiraApi.serves` lets an adapter
      declare them and the registry excludes the rest as
      `deployment_unsupported` (CC-263). Same-shape routes reuse the Cloud
      function through `onV2`; users are projected by a `deployment` dialect
      (`shapeDataCenterUser`, CC-264) threaded through the issue and project
      shaping; `/search`, `/project`, `/status` and `/myself` have DC twins
      (CC-267, CC-268, CC-270). The per-route verdicts are JIRA-API.md §Jira Data
      Center. Doctor probes a DC site with the PAT (CC-266). Pinned by
      `tools/datacenter.test.ts`, which runs every served tool end to end
      against Data Center-shaped responses (CC-265). Deliberate mutations:
      dropping the dialect from `getIssue` fails 2 tests (an email address
      reached the result), disabling the v2 rewrite fails 8.
- [x] 13.3b — what 13.3 did not do, stated rather than dropped. **Done:**
      wiki markup flattened to text by `api/wiki.ts` (CC-271…CC-274; a
      mutation that switches the flattening off fails CC-274), and
      `jira_list_watchers`, `jira_list_components`, `jira_list_versions`
      served over their long-standing Data Center routes (D108, CC-275) — 18
      tools. `scripts/fake-jira.mjs --deployment datacenter` is the fake's
      Data Center twin (v2 and agile routes under a `/jira` context path, PAT
      Bearer only, DC users with an email to strip, wiki bodies, classic
      `/search`, Cloud-only routes 404 — CC-290…CC-294), and
      `scripts/rehearse-datacenter.mjs` drives all 18 tools through the built
      server over stdio MCP against it: exact tool list, every call ok, no
      email/avatar/`accountId` in any result, every DC route hit and nothing
      else, a wrong PAT → `auth` (CC-295…CC-297; outside `npm run check`, like
      the Cloud rehearsal — TESTING.md). Deliberate mutations: letting the
      user projection keep `emailAddress` gives 46 findings, disabling the v2
      rewrite 40, sending the PAT as `Token` 69, dropping the fake's watchers
      route 3. The comment and worklog pages embedded in a default
      `jira_get_issue` (`fields.comment`, `fields.worklog`), which the
      rehearsal found unflattened, are flattened since 13.4b and the rehearsal
      checks the embedded comments too (CC-298). Users and roles are served
      since 13.5a (D110); the count, changelog and attachment list since
      13.6c (D114); the filters (`jira_list_filters`, `jira_get_filter`)
      since 13.7a (D115), without `/filter/search`; and create metadata
      (`jira_get_create_meta`) since 13.7b (D116), over the paged 8.4+ routes
      only — a pre-8.4 host answers `unsupported` rather than a guessed
      legacy route. Nothing of 13.3b is open any more; what remains on Data
      Center (upload, the deletes, `jira_close_sprint`, bulk) waits for a
      real host (ROADMAP.md §v2).
- [x] 13.4a — an ADF → wiki-markup writer, `api/wiki-writer.ts`:
      `wikiFromAdf` over the node and mark subset that `adfFromMarkdown` and
      `toAdf` emit, with `wikiFromMarkdown` / `wikiFromText` on top. It is
      built on the ADF tree because the Cloud write builders already produce
      ADF, and 13.4b rewrites those documents. Text is escaped so tenant text
      never gains markup: `\X` for the metacharacters, and numeric references
      for what a backslash cannot say (`wikiToText` now decodes them last).
      Mentions are written as literal display text, never `[~id]`. Anything
      outside the subset is a `validation` error. Pinned by CC-276…CC-289 and CC-299…CC-301,
      including three property tests (round trip, escape soundness, totality).
      Deliberate mutations, each failing the named tests:
      - dropping `_` from the escape set fails CC-277, CC-299 and CC-300;
      - dropping the line-leading `#` reference fails CC-278 and CC-300;
      - dropping the `unsafeHref` check fails CC-283;
      - dropping the `{noformat}` fallback fails CC-284 and CC-299;
      - dropping reference decoding fails 7 tests;
      - dropping the mark boundary check fails CC-282 and CC-299;
      - dropping an unknown block instead of throwing fails CC-287;
      - writing mentions as `[~id]` fails CC-286 and CC-299;
      - dropping the `;)` rule fails CC-279 and CC-300;
      - dropping the cell `[ ] |` references fails CC-288;
      - dropping the reader's escaped-macro lookbehind fails CC-277.

      Not wired into any tool, the port or the served set.
- [x] 13.4b — DC write request specs (D109): seven writes are served —
      create, update, transition, add/update comment, add worklog, link —
      on the Cloud builders' routes under `/rest/api/2`, with every ADF body
      rendered through `wikiFromAdf` below the plan seam (`onV2Wiki`), so a
      plan shows the wiki body the apply sends. `assigneeAccountId` /
      `reporterAccountId` are refused as `validation` with a `name`
      remediation; `resolveMentions` is `unsupported` (no DC user search);
      comment and worklog results project the DC author. Assignee, watcher,
      vote, delete, sprint, component, version and bulk writes stay unserved.
      The rehearsal lists the writes but calls none. Pinned by CC-302…CC-306
      (`src/tools/datacenter-write.test.ts`) and CC-298. Deliberate
      mutations, each failing the named tests:
      - skipping the wiki render in `onV2Wiki` fails CC-302, CC-303 and CC-306
        (11 tests);
      - dropping `deployment: 'datacenter'` from `addComment` or `addWorklog`
        fails CC-305;
      - making `refuseAccountId` a no-op fails CC-304 (3 tests);
      - dropping the embedded-page flattening fails CC-298;
      - dropping the rehearsal's embedded-comment check fails CC-298.

      **UNVERIFIED:** the writer's entity pass-through and every write shape
      are confirmed or replaced only once a real Data Center host runs.
- [x] 13.5a — DC user reads (D110): `jira_search_users` over `GET
      /rest/api/2/user/search?username=` and `/user/assignable/search`
      (`issueKey`/`project`, issue wins), with rows in the DC user projection.
      `includeEmail: true` is refused as `validation`, and a row carrying an
      accountId or missing name/key is `unexpected_shape`.
      `jira_list_project_roles` reads `/project/{p}/role[/{id}]` on the v2 root,
      and user actors come back as `{ type, name, displayName }`. That makes 20
      reads. The fake serves the four routes (21 in all); a `query=` user search
      is a 400 and a violation. The rehearsal calls both tools, plus the
      assignable search and the role list. Pinned by CC-307…CC-312. Deliberate
      mutations, each failing the named tests:
      - sending `query` instead of `username` on DC fails CC-307 and CC-308;
      - dropping the `includeEmail` refusal fails CC-309;
      - mapping DC actors with the Cloud `mapActor` fails CC-311;
      - dropping `deployment: 'datacenter'` from the served `getProjectRole`
        fails CC-311.

      Assign, watcher and vote writes follow in 13.5b (D111); `resolveMentions`
      follows in 13.6a (D112).
      **UNVERIFIED:** the `username` parameter and the actor `name` are
      confirmed only once a real Data Center host runs.
- [x] 13.5b — DC user writes (D111): `jira_assign_issue`,
      `jira_add_watcher`, `jira_remove_watcher`, `jira_add_vote` and
      `jira_remove_vote` are served by `username`. Assign sends
      `PUT /rest/api/2/issue/{key}/assignee` with `{ "name": … }` (`null`
      unassigns); add watcher sends the username as a bare JSON string;
      remove watcher sends `?username=` and no body; the votes reuse the
      Cloud function through `onV2`. The assign and watcher schemas gain an
      optional `username` and take exactly one identifier (CC-22 extended);
      the Cloud functions refuse `username` and the Data Center twins refuse
      `accountId`, both as `validation` before any request. Cloud request and
      result shapes are unchanged; the DC results carry `username`. Pinned by
      CC-317…CC-322 (`src/tools/datacenter-write.test.ts`,
      `src/tools/issues-write.test.ts`, `src/tools/collab.test.ts`).
      Deliberate mutations, each failing the named tests:
      - making `refuseUsernameOnCloud` a no-op fails CC-321 (3 tests);
      - making `refuseAccountIdOnDataCenter` a no-op fails CC-318 (5 tests);
      - sending `{ accountId: name }` from the DC assign twin fails CC-317
        (2 tests) and CC-320;
      - sending `?accountId=` from the DC remove-watcher twin fails CC-317
        and CC-320;
      - dropping `root: 'v2'` from the DC add-watcher twin fails CC-317 and
        CC-319;
      - serving `addVote` without `onV2` fails CC-317 and CC-319;
      - dropping `jira_add_watcher` from `DATACENTER_WRITE_TOOLS` fails CC-302
        and CC-320;
      - dropping the watcher schema's ambiguity check fails CC-322;
      - letting the assign schema accept `username` with `unassign` fails
        CC-322.

      **UNVERIFIED:** the `{ "name": null }` unassign, the bare-string
      watcher body and the `username` query parameter are Atlassian's
      documented Data Center shapes, never run against a host.
- [x] 13.6a — DC mention resolution (D112): `resolveMentions: true` is
      served on Data Center. `resolveMentionNames` has a DC twin that searches
      `GET /rest/api/2/user/search?username=` and applies the D100 rules and
      errors unchanged (exact display name, active only, one match, at most
      20 names). The mention id is the DC username (`name`). The DC
      `adfFromMarkdown` tags only mention nodes built from targets that twin
      returned (a module-private `WeakSet`), with a module-private symbol that
      JSON and `structuredClone` drop. The wiki writer emits a tagged mention
      as `[~username]`; every other mention, caller-supplied ADF included,
      stays literal (CC-286). The username must match
      `^[\p{L}\p{N}._@+-]{1,255}$`, checked in the resolver, the tagger and
      the writer, so `]`, `|`, `{`, `}`, `[`, `\`, whitespace and newlines
      never reach the wire; a refusal is `validation` before any write. Plan
      mode shows the `[~username]` body (the resolving GET passes through, as
      CC-111). The CC-263 stub list loses `resolveMentionNames`. The fake and
      the reads-only rehearsal are unchanged. Cloud requests, bodies and the
      manifest are unchanged. Pinned by CC-323…CC-329
      (`src/tools/datacenter-write.test.ts`, `src/api/wiki-writer.test.ts`).
      Deliberate mutations (each made, built, tested, reverted), each failing
      the named tests:
      - the writer ignores the tag fails CC-323 (2), CC-325, CC-326, CC-327
        and CC-329;
      - the writer emits every mention as `[~id]` fails CC-286, CC-299
        (property), CC-327 (2), CC-328 and CC-329;
      - dropping the tagger's username check fails CC-324 (the unit test);
      - tagging every target, not only resolver-produced ones, fails CC-327
        and CC-328;
      - resolving through the Cloud directory on DC fails 16 tests across
        CC-323…CC-327;
      - leaving `resolveMentionNames` unserved fails 17 tests across
        CC-323…CC-327;
      - serving the Cloud `adfFromMarkdown` on DC fails CC-323 (2), CC-325,
        CC-326 and CC-327.

      Two mutations survive by design, as defense in depth: dropping the
      resolver's username check alone (the tagger still refuses, so CC-324
      holds end to end) and dropping the writer's re-check alone (a tag can
      only be set by the tagger, which validates).
      **UNVERIFIED:** that `username=` matches display names on real DC
      releases, that `[~username]` (not `[~key]`) in a v2 wiki body
      notifies the user, and that the PAT's user needs only the permission
      to browse users (AUTH.md). None has run against a host.

- [x] 13.6b — DC admin and agile writes (D113): `jira_create_component`,
      `jira_update_component`, `jira_create_version`,
      `jira_update_version` on `/rest/api/2` with the Cloud body fields, and
      `jira_create_sprint`, `jira_start_sprint`, `jira_move_to_sprint`,
      `jira_move_to_backlog` on `/rest/agile/1.0` as the Cloud functions.
      `leadAccountId` is refused as `validation` in the adapter before any
      request; the component answer's lead is projected in the DC dialect
      (`mapComponent` now takes the deployment). `jira_close_sprint` stays
      unserved — a closed sprint cannot be reopened — with the deletes and
      bulk tools. No schema, description or manifest change. The preview now
      serves 20 writes. Pinned by CC-330…CC-334
      (`src/tools/datacenter-write.test.ts`, `src/tools/datacenter.test.ts`).
      Deliberate mutations (change, build, run tests, revert), each failing
      the named tests:
      - removing the `refuseComponentLead` calls fails CC-331 (4 tests) and
        CC-333;
      - dropping `deployment: 'datacenter'` from the component writes fails
        CC-332 (the lead leaks the Cloud projection);
      - serving `createVersion` without `onV2` fails CC-330 and CC-332;
      - dropping `jira_move_to_backlog` from `DATACENTER_WRITE_TOOLS` fails
        CC-302 and CC-333;
      - serving `closeSprint` from `CLOUD_API` fails CC-334 and CC-263.

      **UNVERIFIED:** the v2 component/version bodies, the sprint `goal`
      field and ISO-8601 sprint dates on older Jira Software Data Center
      releases, and the 204 answers of the two moves are Atlassian's
      documented shapes, never run against a host.

- [x] 13.6c — DC count, changelog and attachment reads (D114): three more
      reads over long-standing routes; with 13.6b that is 23 reads and 20
      writes, 43 tools in all. `jira_count` sends `POST /rest/api/2/search` with `maxResults: 0`
      and answers `{ count: total, approximate: false }` with no
      `approximate` hint (`countIssuesDataCenter`); Cloud still answers
      `approximate: true` with the hint. `jira_get_changelog` reads
      `GET /rest/api/2/issue/{key}?expand=changelog&fields=` and pages
      inside the embedded history in the Cloud shape, items passed through,
      authors in the DC projection (`listChangelogDataCenter`); an embedded
      block shorter than its `total` adds `incomplete` with an
      `INCOMPLETE:` note, and paging stops at the window.
      `jira_list_attachments` reads `GET /rest/api/2/issue/{key}?fields=attachment`
      with the Cloud allowlist and the DC author (`listAttachmentsDataCenter`).
      Download, upload, filters and create metadata stay unserved. No new
      fake routes: all three reuse the search and issue routes (the fake
      still serves 21); the rehearsal calls the three tools and checks the
      exact count, named authors, no `incomplete` and no attachment URL. The
      manifest is unchanged. Pinned by CC-340…CC-349
      (`src/tools/datacenter.test.ts`, `src/testing/rehearse-datacenter.test.ts`).
      Deliberate mutations (change, build, run the tests, revert), each
      failing the named tests:
      - answering `approximate: true` from the DC count fails CC-340;
      - dropping the non-negative integer check on `total` fails CC-341;
      - sending `maxResults: 50` from the DC count fails CC-340;
      - never setting `incomplete` fails CC-343 (2 tests);
      - shaping DC changelog entries with the Cloud projection fails the
        CC-265 case for `jira_get_changelog`;
      - offering `nextStartAt` up to `total` instead of the window fails
        CC-343;
      - reading a missing changelog block as empty fails CC-344;
      - projecting the DC attachment author with the Cloud mapper fails
        CC-265, CC-345 and CC-346;
      - reading DC attachments on the v3 root fails CC-265, CC-345 and
        CC-346;
      - dropping `jira_count` from the rehearsal plan fails CC-297, and the
        rehearsal itself reports the tool as served but not listed;
      - dropping the rehearsal's `approximate: false` check fails CC-349 (the
        rehearsal still holds, so the checker test is what guards it).

      **UNVERIFIED:** that a Data Center host honours `maxResults: 0` and
      still answers the exact `total`; that `fields=` (empty) with
      `expand=changelog` returns the changelog with no fields; how many
      histories a Data Center release embeds before it truncates (the
      `incomplete` path is pinned only against fixtures); and the attachment
      rows' author shape — all are Atlassian's documented Data Center
      behaviour, never run against a host.
- [x] 13.7a — DC saved filters (D115): `jira_list_filters` and
      `jira_get_filter` served without `/filter/search`; with 13.6c that is
      25 reads and 20 writes, 45 tools in all. `jira_get_filter` reads
      `GET /rest/api/2/filter/{id}` (`getFilterDataCenter`).
      `jira_list_filters` reads `GET /rest/api/2/filter/favourite` once
      (`searchFiltersDataCenter`) — the caller's favourites only — and says
      so in `scope: { source: "favourites", note }`; `filterName` is applied
      here (case-insensitive substring), paging is client-side over the one
      response in the Cloud `paging` shape, and `accountId` is refused as
      `validation` before any request. Owners take the DC user projection;
      share internals never appear; malformed bodies are `unexpected_shape`.
      The fake serves the two routes (23 in all) and answers `/filter/search`
      with a 404 and a violation; the rehearsal calls both tools (28 calls)
      and checks a named owner, the favourites scope, the JQL and no share
      internals. The manifest, the README and the Cloud requests and results
      are unchanged. Pinned by CC-350…CC-359 (`src/tools/datacenter.test.ts`,
      `src/testing/rehearse-datacenter.test.ts`). Deliberate mutations
      (change, build, run the tests, revert), each failing the named tests:
      - not refusing `accountId` fails CC-353;
      - ignoring `filterName` fails CC-351;
      - returning every matched row instead of the page fails CC-352;
      - passing the DC owner through unprojected fails CC-265 (both tools),
        CC-350 (2 tests) and CC-355;
      - reading the single filter on the v3 root fails CC-265, CC-350,
        CC-354 and CC-355;
      - reading a non-array favourites answer as an empty list fails CC-354;
      - dropping `scope` fails CC-350;
      - mapping Cloud filters with the DC owner projection fails CC-356;
      - not recording the fake's `/filter/search` violation fails CC-358.

      **UNVERIFIED:** that `/filter/favourite` answers a bare, unpaged array
      of full filter beans carrying the owner, JQL, description and
      `favourite`; that `/filter/{id}` on v2 has the Cloud-like shape; that
      the owner is a `name`/`key` user; and that `/filter/search` cannot be
      relied on across Data Center releases — all are Atlassian's documented
      Data Center behaviour, never run against a host.

- [x] 13.7b — DC create metadata (D116): `jira_get_create_meta` is served on
      the Data Center preview — with 13.7a, 26 reads and 20 writes, 46 tools in
      all. It
      reads only the paged pair Data Center 8.4 added —
      `GET /rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes` and
      `.../issuetypes/{issueTypeId}` — never the legacy
      `GET /issue/createmeta?expand=projects.issuetypes.fields` (removed in
      Jira 9.0), not even as a fallback. The paths match Cloud's, but Data
      Center wraps the rows in `values` beside `startAt`/`maxResults`/
      `total`/`isLast`, so the adapter carries twins
      (`listCreateMetaIssueTypesDataCenter`, `getCreateMetaDataCenter`)
      instead of an `onV2` reuse; a page without a `values` array is
      `unexpected_shape`. Fields go through the Cloud mapper, which never
      reads `defaultValue` and keeps only `id`/`value`/`name` of an allowed
      value, so a user default or a user allowed value leaks no email, user
      key or avatar (a user allowed value keeps its username). A 404 with no
      Jira error message is re-aimed at `unsupported` naming Jira Data
      Center 8.4 as the floor; a 404 carrying Jira's messages stays
      `not_found` with the 8.4 hint in the remediation; everything else
      passes through. The fake gains the two paged routes (23 in
      `DATACENTER_ROUTES`), with a reporter default and a user-picker
      allowed value carrying `emailAddress`; its legacy
      `/issue/createmeta` answers 404 and records the violation
      `legacy_createmeta_removed_in_jira_9`. The rehearsal calls the type
      list and, as `also` with `checkAlso: true`, the create screen of type
      10001 — 30 calls with 13.7a — and checks a non-empty type list, a complete screen
      with `summary` required, and no `defaultValue`. The manifest and every
      Cloud request and result are unchanged. Pinned by CC-360…CC-367
      (`src/tools/datacenter.test.ts`, `src/testing/rehearse-datacenter.test.ts`).
      Deliberate mutations (change, build, run the tests, revert), each
      failing the named tests:
      - reading the DC issue type list from `issueTypes` fails CC-265,
        CC-360 and CC-364;
      - reading the DC create screen from `fields` fails CC-361 and CC-364;
      - dropping `root: 'v2'` from the create screen fails CC-361…CC-364;
      - passing every 404 through un-re-aimed fails CC-362 and CC-363;
      - treating a 404 with Jira messages as `unsupported` fails CC-363;
      - mapping `defaultValue` onto a field fails CC-361;
      - passing the raw allowed values through fails CC-361;
      - dropping `getCreateMeta` from the served map fails CC-361…CC-364;
      - not recording the fake's legacy-route violation fails CC-366;
      - keying the fake's type list `issueTypes` fails CC-366;
      - dropping a paged route from `DATACENTER_ROUTES` fails CC-366;
      - dropping `checkAlso` from the rehearsal plan fails CC-367;
      - dropping the rehearsal's partial, empty-type-list or `defaultValue`
        check fails CC-367 (each separately; the rehearsal still holds, so
        the checker test is what guards them).

      **UNVERIFIED:** that Data Center 8.4+ answers both routes with rows in
      `values` and `isLast` beside them (Atlassian's documented shape, never
      seen on a host); that a pre-8.4 host answers the unknown path with a
      404 carrying no Jira error message (a proxy or a release that sends
      one would read as `not_found`, still with the 8.4 hint; Jersey's own
      `null for uri: …` body is not counted as one — fifteenth defect hunt,
      CC-380); that a missing
      project or issue type is a 404 with Jira's messages; and that the
      field rows carry `fieldId`, `schema`, `operations` and
      `allowedValues` as Cloud's do.
- [x] 13.8 — DC attachment download (D117): `jira_download_attachment` is
      served on the Data Center preview — 27 reads and 20 writes, 47 tools in
      all; `jira_upload_attachment` stays unserved, because no tool in the
      catalog removes an attachment and D109 serves a write only when a
      served write can undo it. The download reads the metadata from
      `GET /rest/api/2/attachment/{id}` (Data Center author, URLs dropped,
      the size cap checked first) and the bytes from the attachment servlet
      `GET {contextPath}/secure/attachment/{id}/{filename}` through a new
      frozen `secure` request root (`JIRA_ROOT_PATHS.secure`), composed by
      `core/http.ts` like every root — host policy, context path and the
      dot-segment refusal unchanged. `core/http.ts` never follows a redirect
      from the `secure` root; it is refused as `config`. The filename goes on
      the wire as one `encodeURIComponent` segment (an empty, dot-only or
      ill-formed-Unicode name is `unexpected_shape`) and to disk through
      `safeMediaName`; the `content` URL is never fetched; bytes over the cap
      are refused even when the metadata under-reported the size; a missing
      `JIRA_MEDIA_DIR` is `config` before any request. The Cloud download is
      unchanged. The fake gains the metadata route and the servlet (27 in
      `DATACENTER_ROUTES`; the servlet 404s unless the filename matches
      exactly, seeded attachment 60001 `rehearsal-sample.txt`), and answers
      `/rest/api/[23]/attachment/content/{id}` 404 with the violation
      `cloud_attachment_content_on_datacenter`. The rehearsal gives the
      child its own `JIRA_MEDIA_DIR`, downloads the seeded attachment and
      checks the file is inside that directory and byte-identical — 31 calls.
      The manifest, the README and every Cloud request and result are
      unchanged. Pinned by CC-370…CC-379 and the amended CC-347
      (`src/tools/datacenter-download.test.ts`, `src/tools/datacenter.test.ts`,
      `src/core/http.test.ts`, `src/testing/rehearse-datacenter.test.ts`).
      Deliberate mutations (change, build, run the tests, revert), each
      failing the named tests:
      - mapping the `secure` root to `/rest/secure` fails CC-370…CC-375 and
        CC-378;
      - dropping the no-redirect rule for the `secure` root fails CC-378;
      - accepting a dot-only filename fails CC-371;
      - `encodeURI` in place of `encodeURIComponent` fails CC-371;
      - dropping the ill-formed-Unicode guard fails CC-371;
      - dropping the size check before the transfer fails CC-372;
      - dropping the bytes cap in the shared writer fails CC-372 and the
        Cloud "metadata lied" test;
      - checking the media dir after the metadata request fails CC-376;
      - dropping `root: 'v2'` from the metadata request fails CC-370…CC-375;
      - fetching the bytes on the v2 root fails CC-370…CC-375;
      - fetching the bytes from the `content` URL fails CC-371 and CC-374;
      - writing the raw filename to disk fails CC-371, CC-55 and the Cloud
        sanitizing test;
      - dropping Cloud's `redirect=false` fails CC-375 and the Cloud
        download test;
      - dropping the download from the served map fails CC-370…CC-374 and
        CC-376;
      - dropping it from `DATACENTER_TOOLS` fails CC-297, CC-347 and CC-377;
      - not recording the fake's content-route violation fails CC-379;
      - dropping the fake's exact-filename check fails CC-379;
      - dropping the rehearsal's byte comparison, its media-dir env or its
        file-location check fails CC-379 (each separately);
      - dropping the servlet root from the wire audit fails CC-296.

      **UNVERIFIED:** that the servlet serves the bytes to a PAT `Bearer`;
      that it needs the exact filename and accepts it percent-encoded as one
      segment; how Data Center answers a 403 or 404 there (an HTML page or a
      redirect to the login page — the redirect is refused as `config`, a
      page would arrive as an error status); that
      `/rest/api/2/attachment/{id}` has the Cloud-like shape with a name/key
      author; and whether newer releases redirect the servlet to object
      storage, which this server refuses rather than follows.

Exit (whole phase): a Data Center deployment serves the tools its adapter
declares, refuses the rest by exclusion, and is labelled UNVERIFIED in every
place the Cloud surface is called proven — until a real DC host runs the live
gate (D104's condition, carried by D106, not waived).

Exit (13.3): with the preview flag a Data Center deployment serves exactly the
tools `DATACENTER_TOOLS` names, each on `/rest/api/2` or `/rest/agile/1.0` only,
with users as `name`/`key` and no email on any result; every other tool is
excluded by name; without the flag it does not start; Cloud output, manifest
and README are unchanged; gate green.

Exit (13.2): a Data Center configuration can be written and checked by
doctor, every invalid pairing is a startup error naming the variable to fix,
Cloud settings, host resolution and requests are unchanged (the pre-existing
suite passes untouched apart from fixtures gaining the new required field),
and the server still refuses to start on Data Center.

Exit (13.1): `ctx.api` is the only path from a tool to an api-ring function
that talks to Jira or speaks a wire body format; the Cloud manifest snapshot is
byte-identical; gate green.

## Risks

| Risk | Mitigation |
|---|---|
| `search/jql` token instability (community-reported) | restart-with-guard strategy (CC-01); fixture for expired-token response |
| ADF fidelity complaints (formatting lost) | explicit v1 scope (plain text); the markdown subset (Phase 6) and mention resolution (Phase 9) have since shipped — anything outside the subset is still refused, not approximated |
| Scoped-token permission surprises | doctor probes per-endpoint; error remediation names the scope |
| Rate limits under agent load | semaphore + capped Retry-After honouring; hints teach the model to narrow fields/maxResults |
| Scratch-site drift in fixtures | fixtures redacted + stable placeholders; record script versioned |
| Scratch site absent when Phase 1 exit needs it | **Materialized, and it stayed the project's critical path until 2026-08-17.** The mitigation held only in the sense that the checklist exists and the work routed around the absence: seven phases were completed and the live driver was rehearsed offline instead. What it did not do is stop the gap from compounding — every phase since Phase 1 closed with a Gate-C clause outstanding, and when a tenant finally arrived the first two runs found four defects in a day (D88–D90 plus the gate's own sprint name). No longer compounding, but not yet closed either: 40 tools are proven live, and the four phases that landed after the run added six more that have never met Atlassian, so the unproven count went from 12 to 18 while the proven one stood still. What is left is a permission grant and one more run, not a site. |
| Multi-week pause (solo side project) | WORKLOG + plan checkboxes kept current every session; donor SHAs pinned; park only at phase exits |
| The OAuth redirect URI may not be registrable as designed (D99) | Documented as **UNVERIFIED** in AUTH.md rather than asserted, and named there as the first thing to confirm by hand in the developer console. The port is a setting and the callback path is fixed, so a console that rejects the literal costs a configuration value, not the flow. |
| The client secret is a second real secret on the operator's disk (oauth mode) | The server ships no client credentials of its own: the operator registers their own app and supplies both halves through the environment, so a leaked secret is scoped to one installation. It is redacted like every other credential and never reaches a log field or stdout. THREAT-MODEL.md §OAuth 2.0 (3LO) carries the full account. |
