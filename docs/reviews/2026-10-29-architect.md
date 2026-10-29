# Software Architect review — 2026-10-29

Scope: the unreleased `main` of `jira-mcp-ai` (82 tools in 11 packages, 53,464
production lines under `src/` excluding tests, 96 test files, 13,411 lines of
`scripts/`) and the v3 plan in `docs/ROADMAP.md` (V3-01..V3-28). Focus:
layering in practice, module cohesion, the `JiraApi` port and the Cloud/DC
split, the write gate (write-mode, registry, project-scope, journaling), hot
spots, extensibility toward 2.0/3.0, the complexity budget and the decision
log. Method: read-only. I read the code and the normative docs and measured
with `wc`, `grep` and `git log`. I did not run the gate, because a gate run
was in progress. Every claim cites `path:line` or a measured number. Line
numbers refer to `main` at `6cd07bd`.

## Verdict

| Item | Verdict | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | CONDITIONAL GO | Cloud sprint/backlog reads need a fallback to `/rest/agile/1.0` while it still answers, or a green V3-21 live run under all three auth modes (ARC-01). Also fix the three ARCHITECTURE.md drifts (ARC-12). |
| The v3 plan (ROADMAP V3-xx) | CONDITIONAL GO | V3-09 must mint plan ids from a CSPRNG and bind them to the credential (ARC-02). V3-19 must own `server.ts` (ARC-07). Take the DC decision (V3-27) before V3-13 rather than after it (ARC-03/04). V3-12 splits by concern, not only by sub-domain (ARC-11). |

The architecture is sound and better enforced than most projects this size.
The layering is checked twice in eslint, only one module touches the network,
the port is a frozen identity map, and a regex test guards the port boundary.
1.1.0 is a reasonable release: most of its delta is additive, and V3-01 is
time-critical because the agile issue routes are reported removed on
2026-11-01. The one real release risk is that V3-01 switched Cloud to
`/rest/software/1.0` unconditionally, while the roadmap itself records a
reported 403 on that root and asks for a fallback (`docs/ROADMAP.md:331`).

The v3 plan picks the right hot spots (`http.ts`, `settings.ts`, `issues.ts`,
`fake-jira`, the gate). Its main ordering error is V3-13 → V3-27: it spends a
refactor on isolating Data Center code before deciding whether DC stays. A
pure file move would not isolate it anyway, because the DC logic is interwoven
into the Cloud shapers. The plan also under-specifies V3-09: a server-wide
plan store turns plan ids into bearer handles. And it carries no complexity
budget, at a scale (about 80k lines of code, scripts and docs) that 52
downloads a week does not yet justify.

## Strengths

- **Layering is enforced twice.** `eslint.config.js:193–210` (import-x zones)
  and `:223–264` (`no-restricted-imports` patterns) both encode
  `core ← api ← mcp ← tools`. Composition roots are named explicitly
  (`:166–168`) rather than left unrestricted by accident.
- **The port boundary is tested, not just documented.**
  `src/tools/port-boundary.test.ts` refuses value imports of api functions
  from tools. The only exception is a four-entry `PURE_HELPERS` allowlist
  (`filterFields`, `filterLabels`, `resolveTransitionId`, `startedInstant`).
  `CLOUD_API` is a frozen identity map, so adding an adapter costs no
  indirection on the Cloud path.
- **The DC adapter is honest about itself.** The header of
  `src/api/datacenter.ts` lists every DC difference. `onV2` and `onV2Wiki`
  (`src/api/datacenter.ts:251–273`) rewrite at the request seam instead of
  forking call sites.
- **The plan/apply gate is well bounded.** `MAX_OUTSTANDING_PLANS = 64`, and
  tombstones are capped at 256 (`src/mcp/write-mode.ts:202`).
  `planFingerprint` hashes canonicalized args with null-prototype objects
  (CC-145). The store is already injectable (`WriteGateDeps.store?`), which
  makes V3-09 cheaper than it looks.
- **Time, randomness and network are behind seams.** There is one network
  module (`src/core/http.ts`) reading `fetch` off `globalThis` at call time.
  `Clock` and `Rng` are injected (`src/index.ts:212–218`, `src/mcp/server.ts:121`).
- **The dependency surface is minimal.** Runtime dependencies are the MCP SDK
  `^1.30.0` and zod `^4.6.5` only (`package.json`). zod runtime is confined to
  `src/mcp/define.ts`, with a type-only import in `src/mcp/types.ts:23`.
- **`buildServer` is pure DI.** `src/mcp/server.ts:460` takes every
  collaborator as a dep, which is what lets HTTP build one server per
  session at all.

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| ARC-01 | P0 | Cloud sprint/backlog reads hit `/rest/software/1.0` unconditionally, with no fallback, although a 403 on that root is reported and the roadmap asks for a fallback | `src/api/agile.ts:605–614`; `docs/ROADMAP.md:331` (V3-21 blocked-external); D500 | Fall back to `/agile` on a 403/404 from `software` until the old route is gone, or hold 1.1.0 for a green V3-21 | 2 |
| ARC-02 | P1 | Plan ids come from `Math.random`, and the "not a capability token" rationale stops holding once V3-09 makes the store server-wide | `src/core/rng.ts:16–20`; `src/index.ts:212–218`; `src/mcp/write-mode.ts:205–209` | V3-09: mint ids with `node:crypto` (already used in `transport-http.ts:38`) and bind plans to a credential and session digest | +1 on V3-09 |
| ARC-03 | P1 | The port is Cloud-shaped and DC is interwoven into Cloud shapers, so V3-13's "move the twins" does not isolate DC | `src/api/issues.ts:351, 613–629, 1872–1935, 2067–2094`; `AssignIssueResult` union `issues.ts:1147–1155`; `users.ts` imports `wiki-writer`; DC-related lines in 10 api modules | Re-scope V3-13 to "DC behind the adapter" (shaper strategy injected by the adapter), or drop it if V3-27 removes DC | 6 |
| ARC-04 | P1 | Data Center carries a large, unverified cost: about 1,640 production lines, about 6,500 test lines, a 902-line rehearsal script and 12 D-rows, with no live host and no known user | `wiki.ts` 358 + `wiki-writer.ts` 765 + `datacenter.ts` 518; tests `datacenter*.test.ts` 3,905 lines, plus wiki and rehearse tests; D106–D117 | Bring V3-27 forward: freeze DC now (no new DC work), and decide grow-or-remove at 2.0, not 2027-06-30 | 0.5 (decision) |
| ARC-05 | P2 | A DC-only `username` argument is listed on 3 Cloud tool schemas and refused at call time | `src/tools/collab.ts:168–180`; `src/tools/manifest.snapshot.json:1079, 1998, 2038` | Register the argument only when `api.deployment === 'datacenter'` | 1.5 |
| ARC-06 | P1 | Tools bypass the port for DTO types and limit constants, so an adapter (or 2.0) cannot vary them | `src/tools/issues.ts:46–63`; `src/tools/sprint-summary.ts:32–33`; `src/tools/portfolio.ts:35` (`MAX_PAGE_SIZE`, `MAX_BULK_*`, `MAX_SEARCH_RESULTS`) | `port.ts` re-exports the types the tools use and exposes `api.limits`. Extend `port-boundary.test.ts` to refuse the direct imports | 3 |
| ARC-07 | P2 | The seam stack is spread over three files and the gate is built in two places. V3-19's ownership omits `server.ts`, where two of the layers live | `src/mcp/registry.ts:391–400` (fallback gate, no confirmer); `src/mcp/server.ts:492–497`; `journalingGate` `server.ts:285`, `recordingGate` `:384`; `docs/ROADMAP.md:329` | V3-19 owns `server.ts` and produces one ordered list with one constructor. A test pins the order | +1 on V3-19 |
| ARC-08 | P2 | Each HTTP session rebuilds the full registry, the gate and 82 listed schemas | `src/index.ts:385–393` (`buildServer({...serverDeps, recentWrites: createRecentWrites()})`) | Hoist the manifest-derived immutable parts (selection, listed schemas) to process scope. Keep only session state per session. Do it with V3-14/V3-09 | 3 |
| ARC-09 | P2 | The mcp ring holds Jira route and JQL knowledge, contrary to its own rule | `src/mcp/project-scope.ts` (810 lines): `splitJql :86`, `scopeJql :131`, `admitAgile/admitSoftware/admitPlatform :774–776`; `docs/ARCHITECTURE.md:102` ("No Jira endpoint knowledge"); module list `:96–102` omits project-scope.ts | Move the route/JQL classifiers to `api/` as pure functions, and keep the policy in mcp. Or amend the rule explicitly. Pair this with V3-19 | 3 |
| ARC-10 | P2 | The MCP SDK is imported directly by 9 mcp modules, so V3-28 (the 2027-03-30 spec) has no single seam to change | SDK imports in completions, output-schema, exports, resources, schema, transport-http, prompts, server, transport (`src/mcp/*`) | Add an `mcp/sdk.ts` anti-corruption module that re-exports the used SDK surface. Lint-ban direct SDK imports elsewhere | 2 |
| ARC-11 | P2 | `api/issues.ts` has low cohesion: reads, writes, links, worklogs, timezone utilities and the Cloud user shaper, grown by appending | 3,350 lines; append comment `src/api/issues.ts:2645`; tz utils `:1680, :1718, :1805`; `shapeUser :1974` while `shapeDataCenterUser` is in `users.ts:183`; 16 commits touching it since 2026-09-01 | V3-12 splits by concern: `time.ts` (core-pure), user shapers to `users.ts`, field shapers, then sub-domains. The barrel stays | (V3-12) +1 |
| ARC-12 | P2 | ARCHITECTURE.md drifts from the code in three places | `docs/ARCHITECTURE.md:177` capabilities omit `completions` (`src/mcp/server.ts:558`). `:199` says "exactly five readers" of PACKAGES, but completions and `cli/doctor.ts:91` also read it. `:324–328` says `sessionRecentWrites` is a module singleton, while `src/index.ts:385–393` gives each session its own | Fix all three before 1.1.0. Add a docs-lint probe for the capabilities line | 1 |
| ARC-13 | P3 | The decision log is hard to use: 168 rows in 201 lines, rows up to 3,311 characters, reserved number blocks (D300–303, D400, D500–507) and one gap (D27). O-2 is overdue against its own decide-by | `docs/DECISIONS.md` (measured); Open table | Split DECISIONS.md out of V3-20 and do it early, since it is a mechanical move. Cap new rows at about 600 characters plus a link | 2 |
| ARC-14 | P2 | No complexity budget: about 53k production lines, 13k script lines and 12.5k doc lines (CORNER-CASES alone is 3,856 lines with 743 CC ids) for 52 downloads a week, and the plan still adds surface (V3-26 JSM, V3-16/17 packaging) | `wc` measurements; `docs/ROADMAP.md:326–336` | Add a written budget rule (a new package needs a removal or a usage signal) and land V3-25 (standard profile) before any new package | 1 |

## Detailed findings

### ARC-01 — The software-root switch has no fallback

**What.** `listSprintIssues` (`src/api/agile.ts:605–614`) and the backlog read
always call `/rest/software/1.0` on Cloud (D500). The roadmap records a
reported 403 on that root under some auth modes. V3-21 (`docs/ROADMAP.md:331`)
says "keep a fallback to `/agile` while it still answers", but no fallback
exists. The only 403 handling in `agile.ts` is the CC-34 error remap
(`:1880`), which rewrites the error but does not retry.

**Why it matters.** If the 403 is real for scoped tokens or OAuth 3LO,
upgrading to 1.1.0 breaks `jira_get_sprint_issues` and the backlog read for
those users before the old route is gone. That is a regression the release
introduces.

**Recommendation.** On Cloud, on a 403/404 from the `software` root, retry the
same read once on the `agile` root, a safe GET. Surface a `route_fallback`
hint. When the agile route answers 404/410, report the original error. Remove
the fallback in 1.2 or after V3-21 is green.

**Acceptance.** fake-jira tests for: software 403 → agile 200; software 403 →
agile 410 → original error surfaced; DC path unchanged. Project-scope admits
both roots for these two reads only.

### ARC-02 — Plan ids are not unguessable, and V3-09 makes that matter

**What.** Production wires `systemRng` (`src/index.ts:212–218`), which is
`Math.random` (`src/core/rng.ts:16–20`). `newPlanId` draws four 24-bit values
(`src/mcp/write-mode.ts:209`). The docstring (`:205–207`) justifies this:
"a handle, not a capability token (the store is in-process and unreachable
from the wire)". V3-09 (`docs/ROADMAP.md:319`) makes the store server-wide
across HTTP sessions, which removes that premise. The plan binding
fingerprints `(tool, args, profile)` and carries no credential.

**Why it matters.** With a server-wide store, a plan id from one session is a
handle another session can try to apply. `Math.random` is a predictable PRNG,
not a secret.

**Recommendation.** As part of V3-09: mint ids from `node:crypto` (already
used for session ids, `src/mcp/transport-http.ts:38, 394`) through a separate
`SecureRandom` seam, so tests keep deterministic `Rng`. Add a credential
digest and the session id to the binding. Apply refuses on a mismatch with a
distinct error reason. Update the docstring and the THREAT-MODEL row.

**Acceptance.** A test proves a plan created under credential A cannot be
applied under credential B or from another session. Plan ids are 128 bits
from the CSPRNG. Stdio behaviour is unchanged.

### ARC-03 — The Cloud/DC split lives inside the Cloud modules

**What.** `JiraApi` is defined as `typeof` the Cloud functions
(`src/api/port.ts`). DC is supposed to be an adapter, but DC behaviour sits
inside the Cloud shapers:

- `deployment?` parameters and DC branches in `src/api/issues.ts:351`,
  `:613–629`, `:1872–1935` (`userProjection(deployment)`, `wikiToText`) and
  `:2067–2094`
- DC unions in the Cloud result types (`AssignIssueResult`,
  `issues.ts:1147–1155`)
- `api/users.ts` importing `isWikiMentionUsername` from `wiki-writer`

DC-related lines appear in 10 api modules: datacenter 85, issues 51,
collab 30, users 23, meta 23, wiki-writer 20, filters 12, attachments 11,
search 10, agile 4.

**Why it matters.** V3-13 ("move the DC twins into `src/api/datacenter/` and
add an eslint zone") would move the `*DataCenter` functions, but the Cloud
shapers would still branch on `deployment`. A lint zone cannot forbid that,
because the Cloud files are the ones importing DC helpers. The refactor costs
time and does not produce the isolation it promises.

**Recommendation.** If DC stays (V3-27 "grow"), re-scope V3-13: the adapter
injects a `Shapers` strategy (user projection, body-to-text). Cloud modules
then lose every `deployment` parameter, and the union types move to `port.ts`.
If DC goes, drop V3-13 entirely.

**Acceptance.** `grep -n "deployment" src/api/{issues,collab,users,meta,filters,attachments,search,agile}.ts`
returns nothing. An eslint zone forbids `api/*` (except `datacenter/**` and
`port.ts`) from importing `wiki*`.

### ARC-04 — Data Center costs more than it returns today

**What.** Measured DC footprint:

- **production:** `wiki.ts` 358, `wiki-writer.ts` 765 and `datacenter.ts` 518
  lines, plus about 200 interwoven lines (ARC-03)
- **tests:** `datacenter.test.ts` 2,147, `datacenter-write.test.ts` 1,294,
  `datacenter-download.test.ts` 464, `rehearse-datacenter.test.ts` 1,308 and
  about 1,300 lines of wiki tests
- **other:** `scripts/rehearse-datacenter.mjs` (902 lines) and decision rows
  D106–D117

It serves 48 DC tools behind `JIRA_DATACENTER_PREVIEW=true`, has never run
against a live host and has no known user. V3-27 defers the grow-or-remove
call to 2027-06-30 and depends on V3-13 (`docs/ROADMAP.md:337`).

**Why it matters.** Every Cloud change to a shaper, a type or the gate pays
the DC tax (ARC-03, ARC-05), and V3-13 adds to that cost before the decision
is taken.

**Recommendation.** Freeze DC now: no new DC features, keep it green, and
remove the V3-13 dependency from V3-27. Decide at the 2.0 cut. Removal in 2.0
is a breaking change, which 2.0 permits.

**Acceptance.** A D-row records the freeze. ROADMAP V3-27 no longer depends
on V3-13 and has a 2.0-aligned decide-by date.

### ARC-05 — A DC-only argument is visible on Cloud

**What.** `usernameArg` (`src/tools/collab.ts:168–180`) is documented as
"Jira Data Center only… Refused on Jira Cloud". It is listed on every
deployment, on assign and add/remove watcher (`manifest.snapshot.json:1079,
1998, 2038`).

**Why it matters.** It spends `tools/list` bytes (V3-08 budget) and gives the
model an argument that always fails on Cloud.

**Recommendation.** Build these schemas from `api.deployment`. A tool's spec
receives the deployment at registration, as `selectPackages` already receives
`api` (`src/mcp/registry.ts:390`).

**Acceptance.** The Cloud manifest snapshot has no `username` property. A DC
snapshot test still has it.

### ARC-06 — The port does not own its types or limits

**What.** Tools import Cloud DTO types and limit constants straight from api
modules, for example `src/tools/issues.ts:46–63`,
`src/tools/sprint-summary.ts:32–33` and `src/tools/portfolio.ts:35`.
`port-boundary.test.ts` only refuses value imports of functions.

**Why it matters.** The port is the extensibility seam for DC, for 2.0
contract changes (V3-24) and for any future adapter. Limits such as page
sizes do differ per deployment, and pinning them to Cloud constants makes the
adapter unable to vary them.

**Recommendation.** `port.ts` re-exports the DTO types the tools use and
exposes `readonly limits: ApiLimits` on `JiraApi`, with `CLOUD_API.limits`
holding today's constants. Tools read `ctx.api.limits`.

**Acceptance.** The port-boundary test refuses any `tools/** → api/<module>`
import except `api/port.js` and the `PURE_HELPERS` list. The manifest
snapshot is unchanged.

### ARC-07 — The write-path middleware order is implicit and split

**What.** The layers run in this order:

1. registry: meta-cache → profile → project-scope guard → `countRequests`
   (`src/mcp/registry.ts`)
2. gate: plan capture → payload guard → `readOnlySeam` → `observeMutations`
   (`src/mcp/write-mode.ts`)
3. server: `recordingGate(journalingGate(baseGate))` (`src/mcp/server.ts:285,
   :384`)

The gate is constructed twice: a fallback without a confirmer
(`registry.ts:391–400`, fails closed under `elicit` per D303) and the real one
(`server.ts:492–497`). V3-19's ownership (`docs/ROADMAP.md:329`) lists
write-mode, registry and project-scope, but not `server.ts`.

**Why it matters.** A middleware refactor that leaves two of the layers
outside its scope ends with the order still implicit. Two constructors can
drift apart, for example on a new gate option.

**Recommendation.** Extend V3-19 to own `server.ts`. The result is one
`buildWritePipeline(deps)` that returns the ordered list. Both callers use it,
and the registry fallback becomes `buildWritePipeline` without a confirmer.

**Acceptance.** One `createWriteGate` call site in production. A test asserts
the layer order by name. The journal and recent-writes behaviour tests pass
unchanged.

### ARC-08 — Per-session rebuild on HTTP

**What.** `src/index.ts:385–393` calls `buildServer` per HTTP session, which
re-runs registry selection, gate construction and `toMcpTool` for all 82
listed tools. Only `recentWrites` really needs to be per session. I did not
measure the cost per session, because the gate run blocked execution.

**Why it matters.** V3-09 (stateless wire) and V3-14 (lazy schemas, startup
under 300 ms) both assume cheap session creation. Per-session schema work
works against both.

**Recommendation.** Split `buildServer` into a process-scoped part (manifest
selection, listed tools, schemas, store) and a session-scoped part (recent
writes, the SDK `Server` and its transport). Do it inside V3-14 or just
before V3-09.

**Acceptance.** A test shows two sessions share the same listed-tool array
identity. A micro-benchmark records session creation time before and after.

### ARC-09 — project-scope.ts is Jira knowledge in the mcp ring

**What.** `src/mcp/project-scope.ts` (810 lines) parses JQL (`splitJql :86`,
`scopeJql :131`) and classifies Jira routes per root (`:774–776`, including
the new `software` root from D500). `docs/ARCHITECTURE.md:102` says the mcp
ring has "No Jira endpoint knowledge", and its module list (`:96–102`) omits
project-scope.ts.

**Why it matters.** Every new API root or route (D500 is the latest) edits a
safety module in the mcp ring. The JQL parser is a pure Jira-syntax concern
with nothing MCP-specific in it.

**Recommendation.** Move `splitJql`, `scopeJql` and the per-root route
classifiers to `api/scope-rules.ts` (pure, no I/O). `mcp/project-scope.ts`
keeps the policy and the deny wording. Alternatively, amend the documented
rule. Either is acceptable, but the doc and the code must agree.

**Acceptance.** `mcp/project-scope.ts` stays under about 300 lines. The
moved tests are unchanged except for import paths, and ARCHITECTURE lists
the module.

### ARC-10 — No SDK seam for the 3.0 wire

**What.** `@modelcontextprotocol/sdk` is imported directly by 9 mcp modules
(completions, output-schema, exports, resources, schema, transport-http,
prompts, server, transport).

**Why it matters.** V3-28 adopts the 2027-03-30 spec and retires 2025-11-25.
SDK majors move request schemas and the transport classes, and every one of
the 9 files is a migration site.

**Recommendation.** Add `src/mcp/sdk.ts`, which re-exports the SDK symbols in
use. An eslint rule bans the SDK specifier outside that file. This is a
mechanical change and safe to do any time before V3-28.

**Acceptance.** `grep -rl "@modelcontextprotocol/sdk" src --exclude=*.test.ts`
returns only `src/mcp/sdk.ts`.

### ARC-11 — Split issues.ts by concern first

**What.** `src/api/issues.ts` is 3,350 lines. It mixes reads, writes, request
builders, deletes, remote links, worklog updates, issue links, timezone
utilities (`formatJiraTimestamp :1680`, `utcOffsetMinutesForZone :1718`,
`startedInstant :1805`), `shapeIssueFields :1868` and the Cloud `shapeUser
:1974`. The DC twin `shapeDataCenterUser` lives in `users.ts:183`. The comment
at `:2645` records the growth mode: "Appended rather than filed beside the
other writes so this work package moves no existing line of the file." The
file has 16 commits since 2026-09-01; `port.ts` has 22.

**Why it matters.** A split purely by sub-domain (V3-12) would copy the
misplaced utilities into whichever sub-file uses them first.

**Recommendation.** Do V3-12 in two passes. First move by concern:
time/tz utilities to a pure module, `shapeUser` next to `shapeDataCenterUser`
in `users.ts`, and the field shapers to `issues/shape.ts`. Then split the rest
by sub-domain, keeping the barrel.

**Acceptance.** No file under `api/issues/` exceeds about 800 lines. The tz
helpers have no api imports. `PURE_HELPERS` is updated if `startedInstant`
moves.

### ARC-12 — ARCHITECTURE.md drift

**What.** There are three mismatches:

- `docs/ARCHITECTURE.md:177` lists capabilities without `completions`, which
  `src/mcp/server.ts:558` declares.
- `:199` says PACKAGES has "exactly five readers", but `server.ts`
  completions read `deps.packages` and `cli/doctor.ts:91` imports
  `expandSelection`.
- `:324–328` says `sessionRecentWrites` is a module singleton shared by HTTP
  sessions, but `src/index.ts:385–393` creates one per session.

**Why it matters.** ARCHITECTURE.md is the normative document agents read
first (CLAUDE.md). A wrong isolation claim is the kind that misleads a
security review.

**Recommendation.** Correct all three before 1.1.0. Add a docs-lint check
that compares the capabilities line with `server.ts`.

**Acceptance.** docs-lint passes with the new probe. All three statements
match the code.

### ARC-13 — Decision-log health

**What.** `docs/DECISIONS.md` has 168 D-rows in 201 lines, with single rows
up to 3,311 characters. Numbering has reserved blocks (D300–D303, D400,
D500–D507) and a gap at D27. O-2 is marked overdue in its own text. V3-20
(the split) is planned last and solo.

**Why it matters.** Agents and reviewers cite D-rows constantly. A
3,000-character table cell cannot be diffed or reviewed, and the reserved
blocks make the ordering ambiguous.

**Recommendation.** Pull the DECISIONS split out of V3-20 and do it early:
`docs/decisions/Dnnn.md` plus an index table with one short line each. Leave
the IMPLEMENTATION-PLAN archive and the CORNER-CASES split in V3-20. Record
the numbering scheme (blocks per release line) in the index header.

**Acceptance.** Index rows stay under 200 characters, and docs-lint resolves
every `Dnnn` reference to a file.

### ARC-14 — No complexity budget

**What.** The measured sizes are:

- production: 53,464 lines
- scripts: 13,411 lines (`fake-jira.mjs` 4,836, `verify-live` 3,503)
- tracked docs: about 12.5k lines (CORNER-CASES 3,856 with 743 CC ids,
  IMPLEMENTATION-PLAN 1,518)

Adoption is 52 downloads a week. The roadmap still adds surface: V3-26 (JSM
package), V3-16/V3-17 (Docker, MCPB) and the V3-07 hints.

**Why it matters.** Maintenance cost grows with the size of the surface, not
with usage. Each new package also adds `tools/list` bytes, gate rows and CC
rows.

**Recommendation.** Record a D-row with a budget rule: a new package or
deployment needs either a removal of similar size or a usage signal (issues,
downloads past a threshold). Land V3-25 (the `standard` profile of about 50
tools) before V3-26. Treat V3-08's byte budget as the enforcement mechanism.

**Acceptance.** The D-row exists, ROADMAP deps reflect V3-25 → V3-26, and the
V3-08 budget file holds the current number as a ceiling.

## Assessment of the existing roadmap

| Row | Position | Note |
|---|---|---|
| V3-01 (done) | Agree | Correct and time-critical. Needs the ARC-01 fallback before 1.1.0 |
| V3-02/03/04/06 (done) | Agree | Additive and low risk |
| V3-05 | Agree | One shared clamp helper is right. Keep it behind V3-18 to avoid double fake-jira edits |
| V3-07 | Agree | Small. Measure against V3-08 first |
| V3-08 | Agree, reorder earlier | It is the enforcement mechanism for ARC-14. Land it before any surface growth |
| V3-09 | Re-scope | Add the CSPRNG ids and the credential/session binding (ARC-02), and do ARC-08 first or within it. Est 4 → 6 h |
| V3-10 | Agree | "Freeze by tests first, extract, never rewrite" is the right discipline for `core/http.ts` (1,842 lines) |
| V3-11 | Agree | Low risk. `core/settings.ts` has 18 commits since 2026-09-01 |
| V3-12 | Re-scope | Split by concern first, then sub-domain (ARC-11). Est 3 → 4 h |
| V3-13 | Reorder and re-scope | Run after the V3-27 decision, not before. If DC stays, scope it as the shaper-strategy work in ARC-03 (about 6 h). If DC goes, drop it |
| V3-14 | Agree, widen | Include the process/session split of `buildServer` (ARC-08) |
| V3-15/16/17 | Agree | Independent. V3-16/17 add distribution surface, so weigh them against ARC-14 |
| V3-18 | Agree | The typed split of a 4,836-line fake is worth it. Keep it out of the published tarball (`check-tarball`) |
| V3-19 | Re-scope | Own `server.ts`, one constructor, a pinned order (ARC-07). Optionally absorb the ARC-09 move. Est 4 → 6 h |
| V3-20 | Re-scope | Pull the DECISIONS split out as an early item (ARC-13). The rest stays solo-last |
| V3-21 | Agree | It is the real release gate for V3-01. Until it is green, ARC-01's fallback covers the gap |
| V3-22 | Agree, conditional | Ship 1.1.0 after ARC-01 and ARC-12 |
| V3-24 | Agree | Include ARC-05 (deployment-dependent schemas) and the ARC-06 type ownership, which are contract-visible |
| V3-25 | Agree, reorder | Before V3-26 (ARC-14) |
| V3-26 | Defer | New surface without a usage signal. Gate it on the ARC-14 budget rule |
| V3-27 | Reorder | Decide at the 2.0 cut, and drop the dependency on V3-13 (ARC-04) |
| V3-28 | Agree | Needs ARC-10 (SDK seam) as a dependency |
| Missing | — | The SDK seam (ARC-10), port-owned types and limits (ARC-06), a complexity budget (ARC-14) and an ARCHITECTURE drift probe (ARC-12) |

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| ARC-R1 | Software-root fallback to `/agile` on 403/404 for Cloud sprint/backlog reads | ARC-01 | `src/api/agile.ts`, `src/mcp/project-scope.ts`, `scripts/fake-jira.mjs` | V3-01 | No | 2 |
| ARC-R2 | ARCHITECTURE.md drift fix plus a capabilities docs-lint probe | ARC-12 | `docs/ARCHITECTURE.md`, `scripts/docs-lint.mjs` | — | No | 1 |
| ARC-R3 | V3-09 hardening: CSPRNG plan ids and credential/session binding | ARC-02 | `src/core/rng.ts`, `src/mcp/write-mode.ts`, `docs/THREAT-MODEL.md` | V3-09 (merge into it) | No | +1 |
| ARC-R4 | Process-scoped vs session-scoped `buildServer` | ARC-08 | `src/mcp/server.ts`, `src/index.ts` | V3-14 | No | 3 |
| ARC-R5 | Single write pipeline constructor (extends V3-19 to `server.ts`) | ARC-07, ARC-09 | `src/mcp/write-mode.ts`, `src/mcp/registry.ts`, `src/mcp/server.ts`, `src/mcp/project-scope.ts`, `src/api/scope-rules.ts` (new) | V3-19 | No | +2 (+3 with ARC-09) |
| ARC-R6 | Port owns DTO types and `api.limits`, enforced by the port-boundary test | ARC-06 | `src/api/port.ts`, `src/tools/*`, `src/tools/port-boundary.test.ts` | V3-12 | No | 3 |
| ARC-R7 | `mcp/sdk.ts` anti-corruption module plus an eslint ban | ARC-10 | `src/mcp/sdk.ts` (new), 9 `src/mcp/*` modules, `eslint.config.js` | — | No | 2 |
| ARC-R8 | DC freeze D-row; V3-27 decoupled from V3-13 and decided at 2.0 | ARC-03, ARC-04 | `docs/DECISIONS.md`, `docs/ROADMAP.md` | — | Owner decision | 0.5 |
| ARC-R9 | Deployment-dependent tool schemas (no `username` on Cloud) | ARC-05 | `src/tools/collab.ts`, `src/mcp/registry.ts`, `src/tools/manifest.snapshot.json` | ARC-R8 (if DC stays) | No | 1.5 |
| ARC-R10 | DECISIONS split, pulled forward from V3-20 | ARC-13 | `docs/DECISIONS.md` → `docs/decisions/*`, `scripts/docs-lint.mjs` | — | No (solo, docs-only) | 2 |
| ARC-R11 | Complexity-budget D-row; V3-25 before V3-26; V3-08 as the ceiling | ARC-14 | `docs/DECISIONS.md`, `docs/ROADMAP.md` | V3-08 | Owner decision | 1 |

## Open questions for the owner

1. Ship 1.1.0 with the ARC-R1 fallback now, or hold the release for a live
   V3-21 run under Basic, a scoped token and OAuth 3LO? The agile removal is
   reported for 2026-11-01.
2. Data Center: freeze now and decide grow-or-remove at the 2.0 cut
   (ARC-R8), or keep the 2027-06-30 date and fund V3-13? Is there any real
   DC user or a live host in prospect?
3. Under V3-09, should an applied plan be bound to the credential only, or to
   the credential and the session? The second is stricter, but it breaks
   plan/apply across a client reconnect.
4. Project-scope's Jira knowledge: move it to `api/` (ARC-09), or amend the
   ARCHITECTURE rule to permit it in the mcp ring?
5. Adopt an explicit complexity budget (ARC-R11) that gates V3-26 (JSM) and
   new distribution channels on a usage signal?
