# Testing

> Status: target-state spec (pre-code) — the gate applies from Phase 0's exit
> onward. Corner-case ids CC-nn referenced by suites live in CORNER-CASES.md.

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
  `"synthetic": true`.
- **Fixture PII lint** [test] — a suite walks every `test/fixtures/**/*.json`
  and fails on any residue of a real tenant: an email-shaped string, an
  accountId not matching the placeholder pattern, the real site hostname, an
  `Authorization`/`Cookie`/`set-cookie` key, or a JWT-shaped token. The record
  script redacts, but redaction is a code path that can regress silently and a
  fixture is committed forever — the lint is the thing that actually fails the
  build. It runs inside `npm run check`, so a leaked fixture cannot be pushed.
  The placeholder vocabulary (`5b10a2844c20165700ede21g`-style ids,
  `user-1@example.invalid`, `example.atlassian.net`) is part of the lint, so
  adding a new placeholder form means updating the allow-pattern deliberately.

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
7. **stdout purity** [test] — ported from the donors. Spawns the built entry
   point as a real child process with a scripted `initialize` + `tools/list` on
   stdin, then asserts every line on stdout parses as a JSON-RPC frame and that
   startup diagnostics arrived on stderr. A second case injects a tool that
   calls `console.log` and asserts the console guard redirected it to stderr
   (the in-process assertion catches the regression; the child-process case
   catches banners printed by dependencies before our guard installs — the
   dotenv failure mode D10 avoids).
8. **env ↔ docs sync** [test] — ported. Collects every `JIRA_*` name read in
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
