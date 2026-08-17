# Testing

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. Corner-case ids CC-nn referenced by suites live in
> CORNER-CASES.md.

## Principles

- `node --test` over compiled output; no test framework dependency.
- Tests are **colocated** (`src/api/search.ts` + `src/api/search.test.ts`),
  facebook-mcp style; contract-level fakes live in `src/core/fakes/`; wire-level
  helpers in `src/testing/`.
- **Network fence**: `node --import ./build/testing/network-fence.js` replaces
  global `fetch` with a synchronously-throwing guard — any accidental real
  network call fails loudly. `withFetch()` swaps in a recording mock and restores
  the fence on exit.
- No ambient env leaks: the harness strips `JIRA_*` vars on import. Suite 9 is
  the one exception and it is the same exception in both directions: with
  `JIRA_LIVE_TEST=1` the harness neither strips the credentials nor installs the
  fence, because a live read suite needs real vars *and* real sockets. One flag
  opens both doors, so a run cannot end up half-fenced.
- All time via injected `Clock`; `mockClock` drives retries/backoff
  deterministically.

## Mocking tiers

| Tier | Seam | Used by |
|---|---|---|
| Wire | `withFetch` — `enqueue()` scripts responses in order, `on()` matches by method/URL, and every call is recorded with method, URL, headers and body | `core/http.ts`, retry policy, host allowlist, header rules |
| Contract | `fakeJiraRequest` (canned `JiraResponse<T>` per path) | `api/*`, `tools/*`, registry, envelope |

`fakeJiraRequest`'s canned bodies are **loaded from `test/fixtures/`**, not
hand-written inline [honor]. Hand-authored fakes drift into the shape we wish
Jira had — the guards in `api/*` then pass against fiction. A fixture the fake
cannot find is a test failure, not a fallback to an empty object. Fakes may
*narrow* a fixture (pick one issue out of a page) but never invent a field.
The loader is `createFixtureLoader()` (`core/fakes/fixtures.ts`), which resolves
the corpus from the compiled module's own location rather than `process.cwd()`
and hands back a fresh clone per call. It is passed in explicitly —
`createFakeJiraRequest({ loadFixture: repoFixtureLoader })` — rather than
defaulted, because the corpus is still only the two synthetic files below and a
fake that silently reached for it would make "loaded from fixtures" look true
across a suite where it is not. Defaulting it is a one-line change once the
minimum set is recorded.

## Fixtures

- `test/fixtures/*.json` — real Jira Cloud responses recorded via
  `scripts/record-fixture.mjs` against a scratch site. Redaction runs **inside**
  the record script (raw responses never touch disk): accountIds (both formats),
  emails, displayNames and the site name are replaced with stable placeholders —
  including inside `avatarUrls`/`self`/`next` URLs.
- Minimum fixture set: search/jql page (with and without nextPageToken), issue
  with ADF description (mentions, cards, lists), comments page, transitions,
  createmeta, field list with custom fields, user search, 400 field-validation
  error, 429 with Retry-After, 404 permission-masked error, agile board/sprint
  pages. ADF coverage must include `table`, `codeBlock`, `panel`, `media` and
  `taskList` nodes (the donor never saw them), and one issue carrying
  `issuelinks` + `fixVersions` + `expand=changelog` together — the read-shaping
  contract (TOOLS.md) is asserted against that single fixture. Responses that cannot be reliably triggered live (429 with Retry-After,
  expired `nextPageToken`) are hand-crafted from documented shapes and marked
  `"synthetic": true`. Today the corpus holds exactly those two —
  `errors/rate-limited-429.json` and `errors/search-page-token-expired-400.json`
  — and nothing else: the recorded majority needs the scratch site (Gate C /
  O-2), and generating them against `scripts/fake-jira.mjs` instead would
  launder the fake's own assumptions into files labelled as recorded from Jira,
  which is the fiction the honor rule exists to prevent.
- **Fixture PII lint** [test: src/testing/fixture-pii.test.ts] — a suite walks
  every `test/fixtures/**/*.json`
  and fails on any residue of a real tenant: an email-shaped string, an
  accountId not matching the placeholder pattern, the real site hostname, an
  `Authorization`/`Cookie`/`set-cookie` key, or a JWT-shaped token. It matches
  credential-bearing header **keys**, never substrings: the record script drops
  such headers outright and leaves a `headersDropped` list naming what it
  removed, so the removal is visible to a reviewer — that list is evidence, not
  a finding, and a lint that grepped for the substring would fail every fixture
  the recorder produces. The record
  script redacts, but redaction is a code path that can regress silently and a
  fixture is committed forever — the lint is the thing that actually fails the
  build. It runs inside `npm run check`, so a leaked fixture cannot be pushed.
  The placeholder vocabulary is part of the lint, so adding a new placeholder
  form means updating the allow-pattern deliberately. It is: 24-hex accountIds
  `5b10a2844c20165700ede2NN`, opaque-form accountIds
  `557058:00000000-0000-0000-0000-0000000000NN` (a `nnnnnn:uuid` id keeps its
  shape — collapsing it into the 24-hex form would destroy what the fixture
  exists to preserve), `user-N@example.invalid`, `User N`, and
  `example.atlassian.net`. Two token shapes are refused outright and have no
  placeholder form: a JWT (`eyJ…`) and an Atlassian API-token prefix
  (`ATATT`/`ATCTT`/`ATBB`). A real display name has no shape, so no detector
  will ever catch one — free-text prose carries that residual risk to the human
  reviewer. The suite also runs the same detector over a table of adversarial
  documents built inside the test, asserting each is caught and each legitimate
  placeholder is not, so the lint still proves something on a day the corpus is
  small: one exercised only against an empty directory is theatre.
- The recorder's own redaction is guarded by `npm run check`
  [test: src/testing/record-fixture.test.ts] — the suite drives the exported
  `record()` with an
  injected fake `fetch` whose responses carry every category of sensitive value
  — including one used as an object KEY, one inside a URL query and a display
  name 16 ADF levels deep — then reads the artefact back off disk and asserts
  none survived, that credential headers were dropped rather than masked, that
  the file is mode 0600, and that re-recording is byte-identical. It also pins
  the fail-loud paths: an unclassifiable high-entropy value names its JSON path
  and writes nothing at all, an over-cap body writes nothing, and an error
  scenario that unexpectedly succeeds is a failure rather than a fixture. The
  suite reaches the script through a repo-root-relative dynamic import (nothing
  under `src/` may import `scripts/` statically), and it needs a current
  `build/` because the recorder loads the compiled `core`/`api` it records
  through — `npm run check` builds before it tests, so the gate is honest.
- Fixture files are excluded from Prettier (`.prettierignore`). The recorder
  owns their bytes — `JSON.stringify(document, null, 2)` plus a newline — and
  asserts that re-recording produces an identical file; Prettier collapses short
  arrays, so formatting one would make it stop matching what the recorder emits
  and turn the next re-record into a whole-file diff.

## Suites

1. **Unit** — colocated, per module. ADF round-trips (port
   `test/jira-adf.test.js` from servicenow-mcp), pagination helpers (token loop
   guard, classic isLast), error extractor over all three Jira shapes, worklog
   date formatter (offset format, rejects `Z`), truncation (always-valid JSON),
   taint envelope (branding survives truncation, renderer throws on un-branded
   content — CC-35).
2. **HTTP policy** — wire tier: 429 retried for POST, 503 NOT retried for POST,
   idempotent retry with backoff sequence asserted via mockClock, semaphore
   limits, host allowlist rejections, redirect rejection.
3. **MCP smoke** — build the server with fixture tools; list tools; call each
   registered tool against `fakeJiraRequest`; assert envelope shape and
   `structuredContent` mirroring.
4. **Manifest snapshot** — the `PACKAGES` manifest serialized and locked;
   README tool table generated and diffed (readme-sync test).
5. **Property-based** (fast-check, small) — ADF flattener never throws on
   arbitrary node trees; truncation never produces invalid JSON.
6. **Doctor** — probes against scripted fetch; exit codes.
7. **stdout purity** [test: src/index.test.ts] — ported from the donors. Spawns
   the built entry
   point as a real child process with a scripted `initialize` + `tools/list` on
   stdin, then asserts every line on stdout parses as a JSON-RPC frame and that
   startup diagnostics arrived on stderr. A second case injects a tool that
   calls `console.log` and asserts the console guard redirected it to stderr
   (the in-process assertion catches the regression; the child-process case
   catches banners printed by dependencies before our guard installs — the
   dotenv failure mode D10 avoids).
8. **env ↔ docs sync** [test: src/env-docs-sync.test.ts] — ported. Collects
   every `JIRA_*` name read in
   `src/**` and every row of CONFIGURATION.md's table and asserts the two sets
   are equal, with the documented default matching the code's fallback literal.
   An undocumented env var and a documented-but-dead one both fail. This is the
   mechanical half of the single-writer rule for env facts (docs/README.md);
   `scripts/docs-lint.mjs` covers the prose half.
9. **Live read suite** (env-gated, off by default) — runs only with
   `JIRA_LIVE_TEST=1` plus real credentials against the scratch site (Gate C /
   O-2). **Read tools only** — no write tool is ever exercised live, so the
   suite cannot mutate a site and needs no cleanup path. It answers the one
   question fixtures cannot: has Atlassian changed the wire? Asserts the shapes
   the guards depend on (search page + `nextPageToken`/`isLast` presence, issue
   with ADF description, transitions, createmeta, field list, `/myself`), not
   values. Scheduled **weekly** in CI (not per-PR: it needs a secret, it is slow,
   and a red build from someone else's outage teaches the team to ignore red).
   A failure opens an issue rather than blocking a merge.

**Rehearsing the live gate.** The Gate C driver is itself driven offline:
`scripts/rehearse-live.mjs` runs the real `verify-live.mjs` against the stateful
`scripts/fake-jira.mjs` over seven passes, A–G: a full run (reads, writes and
the delete phase), a forced media redirect, an injected 429/503, an unsafe write
that must not be replayed, a withheld watcher roster (CC-47), a site without
Jira Software (CC-34), and a board that already has an active sprint (CC-36).
The last two are the agile degradations, and both run **with** `--write` —
C27–C30 live in the write phase, so a read-only pass would never reach the
surface those passes exist to degrade. It needs `openssl`
and a current build, runs the seven passes in a few seconds, and touches no
network, so it is **not** part
of `npm run check`; it is nonetheless the only test `verify-live.mjs` has, and
re-running it after any edit to that file is the rule (D72). A green rehearsal
is a statement about this code, never about Jira's.

**Determinism knobs.** The runner pins `TZ=UTC` so a machine-local timezone can
never make a date assertion pass locally and fail in CI. Because of that, the
worklog offset source (D16) must be **injected** in tests — a suite pins e.g.
`Asia/Kolkata` and asserts a `+05:30` offset while the process runs UTC, which
is exactly the split D16 describes (Jira-user timezone ≠ host timezone).
`LANG`/`LC_ALL` are pinned to `C.UTF-8` for the same reason.

## Coverage

`.c8rc.json`, source-mapped over `src`, `all: true`. Initial thresholds
(facebook-mcp levels): lines 70 / branches 60 / functions 75 / statements 70,
excluding `src/index.ts`, `src/testing/**`, `src/core/fakes/**`. Raise toward
servicenow-mcp levels (lines 94 / branches 82 / functions 97; the donor sets no
statements threshold — decide then) once the surface stabilizes (Phase 5).

## Gate

`npm run check` = `typecheck && lint && format:check && build && test` (+
`npm audit --omit=dev --audit-level=high` + `node scripts/docs-lint.mjs` —
the docs-regime checks from docs/README.md + the `npm pack --dry-run`
tarball-content assertion). CI runs `check` on Node 22 and 24.
Run before finishing any change; report the real result.
