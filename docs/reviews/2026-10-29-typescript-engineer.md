# Senior TypeScript/Node Engineer review — 2026-10-29

Scope: the production TypeScript under `src/` (76 files, about 53.4k lines total and 37,297 non-comment lines, excluding `*.test.ts`, `src/testing/`, `src/fakes/`), plus `tsconfig*.json`, `eslint.config.js`, `package.json`, `bin/jira-mcp-ai.cjs` and the v3 table in `docs/ROADMAP.md` (lines 280–338). I looked at type safety, zod v4 usage, the error taxonomy, async correctness, performance, duplication (including the Data Center twins), function size, compiler and lint strictness, dependencies, the Node 22/24 runtime story and the proposed V3 refactors. Method: I read the code directly and measured with throwaway Node scripts that used the TypeScript compiler API, run outside the repo. They measured function lengths, `as` casts, duplicate top-level helper names, `new JiraError(` sites, switch statements, import CPU cost per layer, schema conversion cost and the serialized `tools/list` payload. I did not run the gate (`npm run check`, `tsc`), because a gate run was in progress. The startup numbers were taken on a machine with load average about 92, so I quote CPU time, which is stable, and treat wall-clock figures as indicative only.

## Verdict

| Question | Verdict | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | GO | No P0 correctness or safety defect found. Raising the SDK floor to `^1.32.1` (TSN-09) is cheap, and doing it before the tag is advised but does not block. |
| The v3 plan (ROADMAP V3-xx) | CONDITIONAL GO | V3-10 must be re-scoped: a 742-line closure cannot be split as a "pure move". V3-14 must measure before it optimizes, because its ceiling is about 30 ms CPU. Add the missing items TSN-R3 to TSN-R7. |

The codebase is much more disciplined than its file sizes suggest:
- zero `!` non-null assertions, zero `eslint-disable`, zero `@ts-ignore`;
- the layer contract is enforced twice in lint;
- time, randomness and network are behind injected seams.

The real debt is structural rather than unsafe. A handful of god functions (`jiraRequest` 742 lines, `loadSettings` 706, `createProjectScope` 612) and a ~3.3k-line `api/issues.ts` grew by work package rather than by concept. Twelve copies of `isRecord` and ten of `shapeError` show the api layer never got a shared guards module. Two safety properties the docs describe as structural are actually conventions:
- "every error goes through `createJiraError`" is bypassed at about 40 sites;
- "every call carries the tool's signal/deadline" relies on each module spreading `callBase(ctx)`.

None of this blocks 1.1.0. All of it should be settled before 2.0 widens the surface again.

## Strengths

- **Escape hatches are close to absent.** 0 non-null assertions, 0 `eslint-disable`, 0 `@ts-ignore`/`@ts-expect-error` across 76 production files. There are only 5 `as unknown as` double casts (listed in TSN-02/TSN-12), and `no-explicit-any` is an error (`eslint.config.js`).
- **Strict baseline.** `strict` plus `noUncheckedIndexedAccess` (`tsconfig.json`). The code was clearly written to the stricter `exactOptionalPropertyTypes` style already: 308 occurrences of the `...(x === undefined ? {} : { x })` idiom.
- **Layering is enforced twice in lint.** `core ← api ← mcp ← tools` uses both import-x zones and `no-restricted-imports` (`eslint.config.js`). Determinism bans cover `setTimeout`, `Date.now`, `Math.random` and `AbortSignal.timeout`, with an injected `Clock` (`src/core/clock.ts`).
- **Stream handling is careful.** `readTextCapped` (`src/core/http.ts:533-565`) cancels the reader on overflow or error and releases the lock in `finally`. `armAttempt` races `clock.sleep` against an `AbortController` and silences the losing promise (`src/core/http.ts:603`). HTTP transport teardown never rejects (`src/mcp/transport-http.ts:269-292`), so the `void teardown()` calls at `:402/:406` are sound. `void handleRequest().catch(...)` at `:457` is correct fire-and-forget.
- **Retry policy is honest.** Unsafe writes are not replayed on ambiguous failure. The `ambiguous_write` path in the retry loop (`src/core/http.ts:1127-1420`) matches the canonical policy in `docs/JIRA-API.md`.
- **Error taxonomy is first-class.** `JiraError` has a closed `kind` set with per-kind `REMEDIATION`, a first-class `reason`, and a redaction choke point in `createJiraError` (`src/core/errors.ts`).
- **Dependency footprint is minimal.** Runtime dependencies are only `@modelcontextprotocol/sdk` and `zod` (`package.json`). The tarball excludes maps, tests, `testing/` and `fakes/`. `prepublishOnly` chains `check:publish`, `build:publish` and `tarball:publish`. `npm audit --omit=dev` is clean.
- **The CLI guard is correct.** `bin/jira-mcp-ai.cjs` is ES5 CJS, so an old Node gets a readable "needs Node 22+" message instead of a syntax error. It sets `process.exitCode` instead of calling `exit()`, so stdio is not truncated.

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| TSN-01 | P1 | `jiraRequest` is a 742-line closure with about 20 nested closures. Retry decisions are interleaved with side effects, so it cannot be split as a "pure move". | `src/core/http.ts:632` (`createJiraRequest`, 806 lines), `:680` (`jiraRequest`, 742), retry loop `:1127-1420` | Extract a pure `decideNext(outcome, state) → {retry, wait, fail, done}` first, then move the stages to modules (re-scope V3-10) | 6 |
| TSN-02 | P1 | The Data Center adapter is assembled through `Partial<JiraApi>` plus `as unknown as JiraApi`, so the compiler never checks DC member signatures against Cloud's. | `src/api/datacenter.ts:331` (`stub`), `:372` (`served: Partial<JiraApi>`), `:511` | Build with `satisfies JiraApi` on an explicit object literal, and type the stub as `(name) => JiraApi[K]` | 2 |
| TSN-03 | P1 | The error choke point is bypassed. About 40 `new JiraError(` sites outside `createJiraError` skip `scrub()` and the reason and remediation composition, even though the header says "everything builds errors through this module". | `src/core/errors.ts:24-28`; sites e.g. `src/core/http-util.ts:221,234,295,302,321,329,337,374,470,481,490,821`, `src/mcp/result.ts:95,103,209,218,421`, `src/api/shared.ts:261,285,487`, `src/mcp/registry.ts:111,167,177` | Convert all of them, and ban `new JiraError` outside `core/errors.ts` with `no-restricted-syntax` | 3 |
| TSN-04 | P2 | Signal and deadline forwarding is by convention: each api module has its own `send`/`writeControls`/`sendOne` that spreads `callBase(ctx)`, and the registry does not bind them into the `jira` seam. | `src/mcp/registry.ts:541-555`; `src/mcp/tool-helpers.ts:102-109` (79 call sites); `src/api/issues.ts:2219`; only `src/tools/issues-write.ts:398` forwards `ctx.signal` directly | Bind `signal`/`deadlineAt` into a per-call `jira` wrapper in the registry, and add a test that every tool aborts on a cancelled signal | 3 |
| TSN-05 | P2 | Helper duplication across api/tools: `isRecord` ×12, `shapeError` ×10, `requireRecord` ×6, `readString` ×6, `requireText` ×5, `asRecord` ×5, `abortError` ×4, `sendOne` ×4, `runClassic` ×4 | e.g. `shapeError` at `src/api/issues.ts:2635`, `src/api/search.ts:740`, `src/api/collab.ts:1607`, `src/api/meta.ts:1141`, `src/api/users.ts:1014`, `src/api/bulk.ts:655`; `abortError` at `src/core/http.ts:256`, `src/core/http-util.ts:807`, `src/core/clock.ts:29` | Create `src/api/guards.ts` (records/strings/numbers) and `src/api/wire.ts` (`send`, `shapeError`) and dedupe. Note that `api/shared.ts` exports only pagination today. | 4 |
| TSN-06 | P2 | `loadSettings` is 706 lines with 12 independent sections | `src/core/settings.ts:332` | Agree with V3-11; one pure `readX(env) → Partial<Settings> \| JiraError` per section | 3 |
| TSN-07 | P2 | `createProjectScope` is 612 lines, and no V3 row splits it | `src/mcp/project-scope.ts:198` | Add a split item ordered before V3-19, which touches the same file | 3 |
| TSN-08 | P2 | Lint is `recommendedTypeChecked`, with no `switch-exhaustiveness-check` and no assertNever. 16 switches have no never-typed default; `index.ts:268` assigns via `break` and relies on definite assignment. | `eslint.config.js`; `src/index.ts:268`, `src/core/http.ts:282`, `src/api/adapters.ts:15`, `src/mcp/write-mode.ts:760`, `src/api/adf.ts:644` | Enable `switch-exhaustiveness-check` (with `considerDefaultExhaustiveForUnions: false`), `consistent-type-imports` and `no-unnecessary-condition`, then evaluate `strictTypeChecked` | 3 |
| TSN-09 | P2 | The SDK floor `^1.30.0` admits versions the audit fix moved off (lockfile 1.32.1). A fresh consumer install could resolve below the audited version. | `package.json` dependencies; `src/mcp/transport-http.ts:275` comment "verified in SDK 1.30.0 source" | Raise to `^1.32.1` and refresh the comment | 0.5 |
| TSN-10 | P2 | `api/issues.ts` (3350 lines, 51 exports) grew by appended work-package sections §13–§17 instead of by resource | `src/api/issues.ts:2643` (§13 deletes), `:2880` (§14 remote links), `:3065` (§15 worklog edit), `:3167`, `:3276` | Agree with V3-12, with the concrete resource split in TSN-10 below | 3 |
| TSN-11 | P2 | 24 `*DataCenter` exported twins spread over 9 api modules, near-duplicating their Cloud siblings | users 5, collab 4, meta 4, issues 3, attachments 2, filters 2, search 2, agile 1, wiki-writer 1; e.g. `src/api/collab.ts:936` `addWatcher` vs `addWatcherDataCenter` | Agree with V3-13, but do it after TSN-02 (typed assembly) and TSN-05 (shared wire helpers), or the move carries the duplication along | 3 |
| TSN-12 | P3 | Remaining cast hot spots, mostly index casts working around `noUncheckedIndexedAccess`, plus a generic `as unknown as T` | `src/tools/sprint-summary.ts:224`; `src/tools/portfolio-analysis.ts:560,587,588`; `src/core/http.ts:540,752`; `src/mcp/schema.ts:59,66`; 219 `as` in total, top `tools/issues-write.ts` 14, `tools/issues.ts` 13 | Replace index casts with `for…of`/`entries()`, and type `roundTotals` with a mapped type | 2 |
| TSN-13 | P3 | The zod quarantine is nominal, and its lint message is stale (refers to a "future zod-v4 migration (D9)", but D82 already moved to zod 4) | `src/mcp/define.ts:37` `export { z } from 'zod'`; `eslint.config.js` quarantine message (~line 66); `docs/DECISIONS.md:20` (D9 says v3) vs `:93` (D82), `:201` (O-14 resolved) | Re-export only the builders the tools use, fix the message, and annotate D9 as superseded | 1 |
| TSN-14 | P3 | Media store edge cases. (a) Upload reads the whole file after an `fstat` size check, which is a TOCTOU window if the file grows. (b) A partial `handle.write` is reported as "filesystem full" instead of looping. (c) Download collects chunks and then copies, so peak memory is about 2× (about 100 MB for a 50 MiB file). | `src/tools/attachments.ts:100-235`; `src/core/http.ts:724-779` (`readCapped`) | Cap the read by bytes, not by stat; loop on `bytesWritten`; preallocate when `content-length` is known, or stream to the file handle | 2 |
| TSN-15 | P3 | tsconfig strictness gaps: `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax` are off; `skipLibCheck` is on | `tsconfig.json` | Turn on `exactOptionalPropertyTypes` and `verbatimModuleSyntax` (the code style already fits) and measure the error count first | 2 |
| TSN-16 | P3 | Other long CLI and transport functions not covered by any V3 row | `src/cli/login.ts:716` `run` 359 lines; `src/mcp/transport-http.ts:236` 324; `src/cli/doctor.ts:1650` `run` 285; `src/core/http.ts:1570` `createAuthRequest` 272; `src/mcp/registry.ts:384` 259 | Opportunistic: split them when they are next touched, with no dedicated roadmap item except `login.run` | 2 |
| TSN-17 | P3 | V3-14's premise is mostly wrong: converting all 82 tool schemas costs 25–34 ms CPU. The SDK import (101–126 ms) and the module graph (mcp 76 ms, tools 66–75 ms) dominate startup. `tools/list` is about 127.5 KB, which matters more for agents than cold start does. | Scratch measurement: per-layer import CPU, `toJsonSchemaCompat` over all tools, serialized `tools/list` 127,490 B; largest entries `jira_update_issue` 3499 B, `jira_create_issue` 2985 B | Re-scope V3-14 to "measure, then lazy-convert only if the budget is breached". Feed the 127 KB baseline to V3-08. | 1 |

## Detailed findings

### TSN-01 — `jiraRequest` is a monolithic closure

**What.** `createJiraRequest` (`src/core/http.ts:632`, 806 lines) returns `jiraRequest` (`:680`, 742 lines). Inside it, about 20 nested closures share mutable state:
- `tooLarge`, `readCapped`, `buildMultipart`
- `remaining`, `budgetExceeded`, `waitFor`
- `noteFailure`, `noteSuccess`, `acquireSlot`
- `sendOnce`, `mediaHop`, `sendAttempt`, `runAttempt`, `ambiguousWrite`

The retry loop (`:1127-1420`) decides what to do with aborts, ambiguous writes, timeouts, transport failures, redirects (never followed), 429 with quota, 5xx, binary bodies, 204/205 and JSON parsing. It also emits logger and telemetry events and waits on the clock inline.

**Why it matters.** This function is where the canonical retry policy (unsafe writes never replayed) lives. Because decision and effect are fused, the policy can only be tested end-to-end through fakes, and any change risks a silent replay. V3-10 plans a "pure move", but the closures capture `attempt`, `budget` and `slot` state, so moving them out unchanged means threading that state through parameters. That is a refactor, not a move.

**Recommendation.** Do it in two commits:
1. Extract a pure, table-testable `classifyOutcome(response | error, request) → Outcome` and `decideNext(outcome, attemptState, policy) → {kind:'retry', waitMs} | {kind:'fail', error} | {kind:'done', value}`. Keep the effectful loop in `http.ts`.
2. Move the stages into `core/http/` modules (`body.ts` for multipart and capped reads, `budget.ts`, `slots.ts`, `media.ts`, `loop.ts`).

**Acceptance.**
- No function in `core/http*` is over 150 lines.
- `decideNext` has a table test covering every `JiraErrorKind` × method-safety × attempt combination, including "POST + ambiguous → never retry".
- Existing http tests pass unchanged.

### TSN-02 — DC adapter assembly erases type checking

**What.** `buildDataCenterApi` iterates `Object.keys(CLOUD_API)`. It fills `served: Partial<JiraApi>` (`src/api/datacenter.ts:372`), with `stub(name)` (`:331`) for unsupported members, and returns `{ ...(members as unknown as JiraApi) }` (`:511`).

**Why it matters.** A DC twin with the wrong arity or return shape compiles cleanly. The Data Center adapter is parked (D104), so nothing exercises it live, and the type system is the only guard it has.

**Recommendation.** Write the adapter as an explicit object literal with `satisfies JiraApi`. Type stubs as `<K extends keyof JiraApi>(name: K) => JiraApi[K]`. If the explicit literal is too long, use a mapped type `{ [K in keyof JiraApi]: JiraApi[K] }` built from two typed records (`dcOverrides`, `cloudPassthrough`).

**Acceptance.**
- No `as unknown as` remains in `api/datacenter.ts`.
- Deliberately breaking one twin's signature fails `tsc`, demonstrated once in the PR description.

### TSN-03 — The `createJiraError` choke point is bypassed

**What.** The header of `src/core/errors.ts:24-28` says redaction happens at construction and that "Everything in the server builds errors through this module". The `JiraError` constructor (`src/core/types.ts:635-658`) only copies fields, with `reason` falling back to `message`. There are about 40 direct `new JiraError(` sites, for example:
- `src/core/http-util.ts:221,234,295,302,321,329,337,374,470,481,490,821`
- `src/core/host.ts:537,546`, `src/core/settings.ts:1228`, `src/core/env-lock.ts:436`, `src/core/http.ts:474`
- `src/mcp/result.ts:95,103,209,218,421`, `src/mcp/registry.ts:111,167,177`, `src/mcp/transport-http.ts:246,476`, `src/mcp/define.ts:192`, `src/mcp/errors.ts:115`, `src/mcp/prompts.ts:62`
- `src/api/adf.ts:1665,1675`, `src/api/wiki-writer.ts:120,218,235`, `src/api/shared.ts:261,285,487`
- `src/tools/index.ts:175`

Raw `Error`/`TypeError` throws also remain in `src/mcp/taint.ts:82,85,109`, `src/mcp/resources.ts:280,285` and `src/api/exports.ts:123`. These are startup or programmer errors, which is acceptable.

**Why it matters.** These sites skip `scrub()` and the reason and remediation composition. Most of their messages are static today, but `host.ts` and `http-util.ts` interpolate URL and host values. The invariant is documented but not enforced, so the next site added may interpolate a header or a token-bearing URL.

**Recommendation.** Route every site through `createJiraError`. Add a `no-restricted-syntax` rule for `NewExpression[callee.name='JiraError']` that is off only in `core/errors.ts` and test files.

**Acceptance.**
- `grep -rn "new JiraError(" src --exclude='*.test.ts'` returns only `core/errors.ts`.
- The lint rule exists, and a fixture shows it firing.

### TSN-04 — Cancellation is a convention, not a structure

**What.** The path is `server.ts:642` (`extra.signal`) → registry → `ToolCtx.signal` → `callBase(ctx)` (`src/mcp/tool-helpers.ts:102-109`, used at 79 sites). From there each api module spreads `signal`/`deadlineAt` through its own helper (`src/api/issues.ts:2219` `send`, 3× `writeControls`, 4× `sendOne`). The `jira` seam handed to tools (`src/mcp/registry.ts:541-555`) is not bound to the call's signal.

**Why it matters.** A new api function that forgets the spread produces a request that cannot be cancelled and has no deadline. Nothing fails until a client cancels a long bulk operation and it keeps running. That is a correctness problem for write tools under plan/apply.

**Recommendation.** In the registry, wrap `jira` per call so `signal` and `deadlineAt` default from the `ToolCtx`; explicit options still win. Then add a contract test that iterates every registered tool against a fake transport, using an already-aborted signal, and asserts an `aborted` kind with zero requests sent.

**Acceptance.**
- The test covers all 82 tools.
- Removing a spread from one api helper no longer loses cancellation.

### TSN-05 — Helper duplication in api/tools

**What.** Top-level helpers with the same name and near-identical bodies: `isRecord` ×12, `shapeError` ×10 (`src/core/oauth.ts:405`, `src/api/meta.ts:1141`, `src/api/collab.ts:1607`, `src/api/search.ts:740`, `src/api/attachments.ts:831`, `src/api/users.ts:1014`, `src/api/permissions.ts:289`, `src/api/filters.ts:575`, `src/api/bulk.ts:655`, `src/api/issues.ts:2635`), `requireRecord` ×6, `readString` ×6, `requireText` ×5, `asRecord` ×5, `abortError` ×4, `sendOne` ×4, `runClassic` ×4, `requireField` ×4, `readNumber` ×4, `compact` ×4, `writeControls` ×3.

**Why it matters.** The copies have already drifted: some `shapeError` variants map 404 differently. Every DC twin then multiplies the copies again, and V3-13 would move them, not merge them.

**Recommendation.** Add `src/api/guards.ts` (pure, no imports) for the record/string/number readers, and `src/api/wire.ts` for `send`, `sendOne`, `writeControls` and `shapeError`. Keep the differing `shapeError` behaviour as explicit options, not as copies. Have `abortError` live once in `core/clock.ts`.

**Acceptance.**
- Each of the listed names is defined exactly once in production code (scripted check).
- No behaviour diffs in the existing tests.

### TSN-06 — `loadSettings` is 706 lines

**What.** `src/core/settings.ts:332` covers 12 sections in sequence: credentials, auth mode and OAuth (D91/D97/D301), profiles, deployment (D106), host, token expiry horizon, tool surface gating, project scope guard (D400), HTTP behaviour, transport, diagnostics and the redaction blast radius.

**Why it matters.** The sections are independent except for profile resolution, which happens first. A single function makes each env var's precedence hard to test in isolation.

**Recommendation.** Use one `readX(env, profile): Result<Partial<Settings>>` per section, and have `loadSettings` resolve the profile first, then fold the sections. This is a pure move, as V3-11 says.

**Acceptance.** `loadSettings` is at most 80 lines, each reader is at most 120 lines, and the existing settings tests are unchanged.

### TSN-07 — `createProjectScope` is 612 lines and unplanned

**What.** `src/mcp/project-scope.ts:198`. The only V3 row that touches this file is V3-19 (write-gate middleware).

**Why it matters.** V3-19 will add middleware into a 612-line closure. Splitting first gives V3-19 a clean seam.

**Recommendation.** Split it into JQL scope rewriting, key-level checks and result filtering, as a pure move, ordered before V3-19.

**Acceptance.** No function in the file is over 150 lines, and the project-scope tests are unchanged.

### TSN-08 — Lint does not prove exhaustiveness

**What.** `eslint.config.js` extends `recommendedTypeChecked`. It lacks `@typescript-eslint/switch-exhaustiveness-check`, `consistent-type-imports` and `no-unnecessary-condition`. Of the 16 switches, none has an `assertNever` default. `src/index.ts:268` switches on `authMode` with `break` and assigns `credentials`, so a new auth mode would surface only as a definite-assignment error, if at all.

**Why it matters.** The `JiraErrorKind`, auth-mode and write-mode unions are the backbone of the safety story. A new member should fail lint at every switch.

**Recommendation.**
- Enable `switch-exhaustiveness-check` with `considerDefaultExhaustiveForUnions: false`, and add `assertNever` to the 16 switches.
- Enable `consistent-type-imports`.
- Trial `strictTypeChecked` in a scratch branch, record the error count, and adopt the rules with a low count.

**Acceptance.** Lint passes with the rule on, and adding a fake member to `AuthMode` makes lint fail at `src/index.ts:268`.

### TSN-09 — SDK floor below the audited version

**What.** `package.json` declares `@modelcontextprotocol/sdk: ^1.30.0`, while the lockfile is at 1.32.1 after `npm audit fix`. The comment at `src/mcp/transport-http.ts:275` still cites 1.30.0.

**Why it matters.** Consumers install from the range, not from our lockfile, so a cached 1.30.x or 1.31.x satisfies the range and brings back the patched transitive issues. The SDK also pulls in express, hono, jose, ajv, cors and eventsource, so it is the biggest supply-chain surface we have.

**Recommendation.** Raise the floor to `^1.32.1` and re-verify the comment against 1.32.1.

**Acceptance.** `npm ls @modelcontextprotocol/sdk` resolves at 1.32.1 or higher, and the comment cites the verified version.

### TSN-10 — `api/issues.ts` split lines

**What.** The file is 3350 lines with 51 exports. §1–§12 are organized by concern (constants, shapes, options, reads, write inputs, builders, writes, worklog time, shaping, transport, paths, errors). §13–§17 were appended per work package (deletes `:2643`, remote links `:2880`, worklog edit `:3065`, issue-link delete `:3167`, remote-link delete `:3276`).

**Recommendation.** Split by resource under `src/api/issues/`, with `src/api/issues.ts` kept as a barrel:
- `core.ts`: get, bulk get, create, update, delete (§4 `getIssue :511`, `getIssuesBulk :544`, §7 and §13)
- `comments.ts`: `listComments :669` plus the comment writes
- `worklogs.ts`: `listWorklogs :687`, worklog writes, §8 time helpers (`formatJiraTimestamp`, `utcOffsetMinutesForZone`, `startedInstant` from `:1668`), §15
- `changelog.ts`: `listChangelog :706`, `getChangelogsBulk :725`, `listChangelogDataCenter :828`
- `transitions.ts`: `listTransitions :915`, `resolveTransitionId :949` and the transition write
- `links.ts`: issue links, remote links, §14, §16, §17
- `shape.ts`: §9 (`shapeIssueFields :1868`, `shapeUser :1974`)
- `internal.ts`: §10–§12 (`send`, paths, errors), which should eventually be replaced by `api/wire.ts` (TSN-05)

**Acceptance.**
- No file is over 800 lines.
- The barrel keeps all 51 exports with identical names.
- No tool import changes.

### TSN-11 — DC twins

**What.** There are 24 exported `*DataCenter` functions plus `src/api/datacenter.ts` (518 lines). Example: `addWatcher` (`src/api/collab.ts:936`) vs `addWatcherDataCenter`, which differ only in path and accountId-vs-username. Several twins carry `UNVERIFIED` markers.

**Recommendation.** Agree with V3-13 (`api/datacenter/` plus a lint zone). Order it after TSN-02 and TSN-05, and express each twin as a delta (path builder plus identity mapper) over the shared wire helper, not as a full copy.

**Acceptance.** Every twin is either no more than 15 lines or justified in a comment, and the `api/datacenter/` zone forbids imports from `tools/`.

### TSN-12 — Cast hot spots

**What.** There are 219 `as` casts in production code. The notable ones:
- `src/tools/sprint-summary.ts:224` (`return out as unknown as T`)
- `src/tools/portfolio-analysis.ts:560,587,588` (`issues[i] as PortfolioIssue`, index casts)
- `src/core/http.ts:540,752` (`body as ReadableStream<Uint8Array>`)
- `src/mcp/schema.ts:59,66` (`as AnyObjectSchema`, `as ToolInputSchema`)

The other double casts (`src/mcp/result.ts:196`, `src/core/errors.ts:378`, `src/api/wiki-writer.ts:130`) are at legitimate brand or guard boundaries.

**Recommendation.** Replace the index casts with iteration, type `roundTotals` with a mapped numeric-key type, and narrow `body` via a guard. Leave the schema casts as they are, because they sit at the SDK boundary.

**Acceptance.** The `as` count drops by at least 20, and there are no `as unknown as` outside the three boundary sites plus `schema.ts`.

### TSN-13 — zod quarantine is nominal

**What.** `src/mcp/define.ts:37` re-exports the whole `z` namespace, so the quarantine limits only the import path, not the API surface. The lint message (~line 66 of `eslint.config.js`) says the quarantine keeps "a future zod-v4 migration (D9)" bounded. But D82 (`docs/DECISIONS.md:93`) already moved to zod 4, O-14 is resolved (`:201`), and D9 (`:20`) still says v3.

**Recommendation.** Re-export a curated object (`object`, `string`, `number`, `boolean`, `enum`, `array`, `union`, `literal`, `optional` and the like), fix the message, and mark D9 as superseded by D82.

**Acceptance.** The `z` re-export is replaced, tools compile, and the message no longer mentions a future migration.

### TSN-14 — Media store edge cases

**What.** In `src/tools/attachments.ts:100-235`, upload does `fstat` and then `handle.readFile()`, so a file that grows between the two calls is read past the 50 MiB cap. The `handle.write(bytes)` path treats `bytesWritten < length` as "filesystem full". Download (`src/core/http.ts:724-779`) accumulates chunks and then copies them into one `Uint8Array`, so peak memory is about 2× the size.

**Recommendation.**
- Read with an explicit byte limit (`handle.read` into a preallocated buffer of `cap+1`).
- Loop on partial writes.
- On download, preallocate when `content-length` is present and within the cap.

**Acceptance.** Unit tests cover a growing file, a short write (with a fake handle) and a download with peak allocation of 1× plus a chunk.

### TSN-15 — tsconfig strictness gaps

**What.** `tsconfig.json` leaves `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax` off, and sets `skipLibCheck: true`. `tsconfig.publish.json` only disables source and declaration maps, which is fine.

**Recommendation.** Turn on `exactOptionalPropertyTypes` (308 conditional spreads suggest it is mostly satisfied already) and `verbatimModuleSyntax` (pairs with `consistent-type-imports`). Leave `skipLibCheck` on, because the SDK's types are the risk there.

**Acceptance.** Both flags are on and the gate is green.

### TSN-16 — Other long functions

**What.**
- `src/cli/login.ts:716` `run` (359 lines)
- `src/mcp/transport-http.ts:236` `connectHttpTransport` (324)
- `src/cli/doctor.ts:1650` `run` (285)
- `src/core/http.ts:1570` `createAuthRequest` (272)
- `src/mcp/registry.ts:384` `createRegistry` (259)
- `src/index.ts:197` `serve` (224)
- `src/core/host.ts:248` `resolveHost` (213)
- `src/api/adf.ts:1398` `parseMarkdown` (205)
- 43 production functions are 80 lines or longer.

**Recommendation.** Only `login.run` justifies its own item: it is an interactive OAuth state machine and is hard to test as one function. Split it into explicit steps. Fold `createAuthRequest` into TSN-R1, and split the rest when they are next touched.

**Acceptance.** `login.run` is at most 100 lines, with each step unit-tested.

### TSN-17 — Startup and payload numbers for V3-14 and V3-08

**What.** CPU-time measurements:
- SDK server import: 101–126 ms
- per layer: core 7–9 ms, api 11–16 ms, mcp 76 ms, tools 66–75 ms
- converting all 82 tool input schemas to JSON Schema: 25–34 ms
- RSS: about 77–79 MB

The serialized `tools/list` is 127,490 bytes, of which 30,792 characters are descriptions. The largest entries are `jira_update_issue` 3499 B, `jira_create_issue` 2985 B, `jira_update_comment` 2735 B, `jira_bulk_edit_issues` 2696 B, `jira_update_worklog` 2613 B and `jira_get_issue` 2520 B.

**Why it matters.** V3-14's "lazy schemas, startup under 300 ms" target can recover at most about 30 ms of conversion plus some `defineTool` probing. Most of the cost is the SDK and module evaluation, which lazy schemas do not touch. The 127 KB payload is the real cost agents pay on every session.

**Recommendation.**
- Re-scope V3-14: add a startup benchmark script (CPU time, median of N, unaffected by load) with a committed baseline, and move the probes into a test, which is the valuable half. Make the schemas lazy only if the budget is breached.
- Give V3-08 the 127,490 B total and the per-tool top list as its initial baseline.

**Acceptance.** The benchmark script exists, its baseline is recorded in the docs, and V3-08's budget test cites these numbers.

## Assessment of the existing roadmap

- **V3-05 (maxResults clamp): agree.** Small and independent.
- **V3-07 (alwaysLoad): agree.** Payload-driven (TSN-17).
- **V3-08 (surface byte budget): agree, with an extension.** Seed it with the measured 127,490 B and the per-tool top list. Budget per tool too (for example 3.5 KB), not only the total.
- **V3-09 (PlanStore): agree.** No TS concerns.
- **V3-10 (split core/http.ts): re-scope.** "Pure moves stay pure" (ROADMAP rules, about :280-306) cannot hold for a 742-line closure with shared mutable state. Make it two steps (TSN-R1): pure decision extraction with table tests, then the module move. That is 6 h, not 4.
- **V3-11 (split loadSettings): agree.** It is genuinely a pure move along the 12 sections (TSN-06).
- **V3-12 (split api/issues.ts with a barrel): agree,** with the resource split from TSN-10. Do TSN-R4 (shared guards and wire) first or at the same time, so `internal.ts` is short-lived.
- **V3-13 (DC twins to api/datacenter/): reorder.** It depends on TSN-R2 (typed assembly) and TSN-R4 (shared wire helpers) as well as V3-01 and V3-12. Without them the move carries the casts and copies with it.
- **V3-14 (lazy schemas, under 300 ms): re-scope.** Measure first (TSN-17). Keep "move probes into a test" and drop lazy conversion unless the benchmark shows it is needed.
- **V3-15 (de-flake), V3-18 (typed fake-jira): agree.** V3-18 is the natural place to make the abort contract test from TSN-04 cheap.
- **V3-19 (write-gate middleware): reorder** after a `createProjectScope` split (TSN-R5).
- **V3-24 (2.0 cleanup), V3-25 (default profile): agree.** V3-24 is the right home for the tsconfig flags if they produce breaking type changes in exported types.

**Missing from the plan:**
- enforcing the error choke point (TSN-03)
- structural cancellation (TSN-04)
- shared api guards and wire helpers (TSN-05)
- lint exhaustiveness and strictness (TSN-08)
- the SDK floor (TSN-09)
- splitting `createProjectScope` (TSN-07)
- typed DC assembly (TSN-02)

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| TSN-R1 | Re-scoped V3-10: extract pure `classifyOutcome`/`decideNext` with table tests, then move http stages into `core/http/` | TSN-01, TSN-16 | `src/core/http.ts`, `src/core/http/*`, `src/core/http-util.ts` | V3-02 | No | 6 |
| TSN-R2 | Typed DC assembly via `satisfies JiraApi`, removing `as unknown as` | TSN-02 | `src/api/datacenter.ts` | none | No | 2 |
| TSN-R3 | Enforce the `createJiraError` choke point: convert about 40 sites and add a `no-restricted-syntax` rule | TSN-03 | `src/core/errors.ts`, `eslint.config.js`, sites in `core/`, `mcp/`, `api/`, `tools/index.ts` | none | No | 3 |
| TSN-R4 | Shared `api/guards.ts` and `api/wire.ts`, deduping `isRecord`, `shapeError`, `send*` and `abortError` | TSN-05 | `src/api/guards.ts`, `src/api/wire.ts`, all `src/api/*.ts`, `src/core/clock.ts` | none (before V3-12 and V3-13) | No | 4 |
| TSN-R5 | Split `createProjectScope` | TSN-07 | `src/mcp/project-scope.ts` | none (before V3-19) | No | 3 |
| TSN-R6 | Structural signal/deadline binding in the registry, plus an all-tools abort contract test | TSN-04 | `src/mcp/registry.ts`, `src/mcp/tool-helpers.ts`, new test | V3-18 helps but is not required | No | 3 |
| TSN-R7 | Lint strictness: `switch-exhaustiveness-check`, `assertNever`, `consistent-type-imports`, and a `strictTypeChecked` trial | TSN-08 | `eslint.config.js`, the 16 switch sites | none | No | 3 |
| TSN-R8 | Raise the SDK floor to `^1.32.1` and refresh the version comment | TSN-09 | `package.json`, `package-lock.json`, `src/mcp/transport-http.ts` | none | No | 0.5 |
| TSN-R9 | Re-scoped V3-14: startup benchmark with a committed baseline, probes to a test, lazy schemas only if over budget; seed V3-08 | TSN-17 | `scripts/bench-startup.mjs`, `src/mcp/define.ts`, `src/mcp/schema.ts`, docs | V3-07 | No | 1.5 |
| TSN-R10 | Narrow the zod re-export, fix the stale quarantine message, annotate D9 | TSN-13 | `src/mcp/define.ts`, `eslint.config.js`, `docs/DECISIONS.md` | none | No | 1 |
| TSN-R11 | tsconfig: `exactOptionalPropertyTypes` and `verbatimModuleSyntax` | TSN-15 | `tsconfig.json`, any affected files | TSN-R7 (type imports) | No | 2 |
| TSN-R12 | Media store hardening (bounded read, partial writes, 1× download) | TSN-14 | `src/tools/attachments.ts`, `src/core/http.ts` | after TSN-R1 if done together | No | 2 |

## Open questions for the owner

1. Is `strictTypeChecked` (as opposed to a hand-picked set of strict rules) an acceptable lint baseline for 2.0, given it may need a few hours of churn across `tools/`?
2. Should V3-14's "under 300 ms startup" target be redefined as CPU time measured by a committed benchmark? Wall-clock is not reproducible on this machine, and the SDK import alone takes about 100–125 ms CPU.
3. For TSN-R4, should the `shapeError` variants that differ today (404 mapping per module) be unified, which changes behaviour, or kept as explicit options, which preserves behaviour?
4. Does the Data Center adapter stay parked under D104? If so, should TSN-R2 and V3-13 be deprioritized below the Cloud-side refactors, or is typed assembly worth doing now as cheap insurance?
5. Should `exactOptionalPropertyTypes` land before 2.0 even if it changes exported option types (a semver-major concern for anyone importing the API types), or be held for V3-24?
