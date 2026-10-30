# Mutation-testing baseline — safety core (2026-10-30)

V3-78, from QA-R7 (QA-11, QA-02) in `2026-10-29-qa.md`. This is the first
baseline of the safety core under Stryker. It records the scores, the mutants
this item killed, and why the remaining survivors are accepted for now. The
per-mutant list lives in the job's HTML/JSON report (`reports/mutation/`, the
`mutation-report` artifact of `.github/workflows/mutation.yml`).

## Scope and setup

| File | Why it is in scope |
|---|---|
| `src/mcp/write-mode.ts` | plan/apply gate, plan store, stale check, payload guard |
| `src/mcp/project-scope.ts` | `JIRA_PROJECTS` confinement |
| `src/mcp/taint.ts` | untrusted-content envelope and warning |
| `src/core/http-util.ts` | header, URL and error-shape helpers under the transport |
| `src/core/http/decide.ts` | the never-replay decision (QA-11 named `http.ts`; D515 split it out) |

- Stryker 10.1.1 with `@stryker-mutator/tap-runner`; `coverageAnalysis:
  perTest`, so each mutant reruns only the compiled test files that cover it.
- `buildCommand: npx tsc` compiles the instrumented tree once per sandbox; the
  tests run as in `npm test`, behind `build/testing/network-fence.js`.
- Two test files are excluded. They inspect the checkout, not behaviour, and
  fail on the unmutated sandbox:
  - `build/manifest-sync.test.js` asserts the executable bit on `bin/`, which
    the sandbox copy drops;
  - `build/api/safe-allowlist.test.js` scans source text, which instrumentation
    rewrites.
- Run locally with `npm run mutation` (about 6–8 minutes on a 10-core laptop).

## Scores

Mutation score = (killed + timeout) / all valid mutants; "covered" leaves out
the mutants no test reaches.

| File | Baseline | After this item | Survived | No coverage |
|---|---|---|---|---|
| **All files** | 80.69 % | **80.82 %** (82.0 % covered) | 517 | 42 |
| `decide.ts` | 97.14 % | 98.86 % | 2 | 0 |
| `taint.ts` | 84.31 % | 95.10 % | 5 | 0 |
| `write-mode.ts` | 82.91 % | 82.77 % | 116 | 6 |
| `http-util.ts` | 77.64 % | 77.42 % | 202 | 10 |
| `project-scope.ts` | 78.71 % | 78.00 % | 192 | 26 |

2915 mutants. The small drops in the last three rows are not regressions: 15
mutants that **timed out** in the baseline (a timeout counts as detected)
finished and survived in the rerun. Timeout counts move with machine load,
which is why the floor below keeps a margin.

## Killed by this item

| File | Mutants | Test |
|---|---|---|
| `decide.ts` | `isSuccessStatus` band edges (L34) | `[D515] isSuccessStatus is exactly the 2xx band` |
| `decide.ts` | `landed` only for an answered 2xx unsafe write (L94, L98) | `[D515] a lost reply is "landed" only for an unsafe write that Jira answered 2xx` |
| `taint.ts` | brand field type checks in `isTainted` (L62, L66, L67) | `isTainted() requires every brand field to have its own type` |
| `taint.ts` | non-string source guard and the error messages (L81–87, L110–111) | `taint() refuses a non-string source with its own message` |
| `taint.ts` | `String()` of null/undefined content (L114) | `renderTainted() stringifies null and undefined …` |
| `taint.ts` | each clause of `TAINT_WARNING` blanked (L43–46) | `TAINT_WARNING keeps every clause of the injection warning` |
| `write-mode.ts` | stale check firing without a plan-time stamp (L1215) | `[V3-78] a versionless plan applies even when the apply-time read finds a version` |

## Accepted survivors

### Equivalent mutants (no test can kill them)

- `decide.ts` L26: the fallback `''` for a non-`Error` name only feeds a
  comparison against fixed error names, so any other string behaves the same.
- `decide.ts` L94: `answered !== undefined` → `true`; `isSuccessStatus(undefined)`
  is already false.
- `taint.ts` L114: `typeof content === 'string'` → `false` and `'string'` → `''`;
  `String()` of a string is the string.
- `taint.ts` L125: `end === -1` → `false`, `-1` → `+1`, `end < start` →
  `end <= start`. With `start` found, the earlier `start === -1` check and the
  marker lengths make each variant return the same `undefined`.
- `write-mode.ts` L1215: both `OptionalChaining` mutants; past the left operand
  `issued` is defined, and `live` is always an object at that point.

### Accepted for now, by category

Apart from the seven equivalent mutants above, the remaining 552 (survived
plus no coverage) sit in `write-mode.ts`, `http-util.ts` and
`project-scope.ts`. By mutator:

| Mutator | write-mode | http-util | project-scope |
|---|---|---|---|
| StringLiteral | 51 | 48 | 69 |
| ConditionalExpression | 35 | 73 | 67 |
| OptionalChaining | 5 | 0 | 34 |
| LogicalOperator | 2 | 20 | 13 |
| EqualityOperator | 6 | 18 | 9 |
| Regex | 2 | 24 | 8 |
| other | 21 | 29 | 18 |

- **StringLiteral (168).** Error, hint and refusal wording. Tests assert the
  error `kind` and the hint code (the contract, TOOLS.md), not the prose, on
  purpose: pinning the prose would make every wording change a test change. Not
  a safety gap.
- **OptionalChaining (39, mostly `project-scope.ts`).** Defensive `?.` on
  values the types already guarantee; removing it only changes behaviour on an
  input the schema layer rejects first.
- **ConditionalExpression / LogicalOperator / EqualityOperator / Regex (277).**
  The real backlog. Known clusters:
  - `write-mode.ts` L1148: the `ignoredApply` argument of `planHintMessage`
    (hint wording only); L420–479 plan-store quota, tombstone and TTL
    bookkeeping; L1075 the `CONFIRM_BEFORE_MAX_CHARS` boundary; L186 the
    `apply` control-field parse; L1244 the payload-guard shortcut for plans
    without a payload.
  - `http-util.ts`: header and URL normalisation, `Retry-After` parsing and
    the error-body extraction regexes.
  - `project-scope.ts`: the JQL scope rewriting and project-key extraction
    paths.
  None of them is a known bug — each mutant is a missing assertion, not
  wrong code. Working them down is follow-up test work, file by file, using
  the HTML report.
- **No coverage (42 of the 552).** Branches no test reaches (26 in
  `project-scope.ts`). c8's floor admits them; they are the first candidates
  for new tests.
- **other (68).** Method, block, call and literal mutants spread over the
  same functions; triage them with the clusters above.

## Threshold

`thresholds.break` is **78**, about 2.8 points under the measured 80.82 %. The
job fails if the score drops under it. The margin absorbs timeout drift between
machines (15 mutants moved between "timeout" and "survived" across two local
runs) and still catches a real loss of about 80 killed mutants. `high` / `low`
(90 / 80) only colour the report. Ratchet `break` up as the backlog above is
killed, the same way the c8 floor was ratcheted in D105.
