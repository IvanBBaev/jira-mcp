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
- No ambient env leaks: the harness strips `JIRA_*` vars on import. The fence
  still honours one escape hatch — with `JIRA_LIVE_TEST=1` it neither strips the
  credentials nor installs the fence, one flag for both doors so a run cannot end
  up half-fenced — but **no unit test uses it**: there is no live test under
  `src/`, and nothing in CI sets it. Suite 9 does not run through `npm test` at
  all (below). Setting `JIRA_LIVE_TEST=1` on a unit run only switches the fence
  off; it proves nothing about Jira.
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
4. **Manifest snapshot** — the `PACKAGES` manifest serialized and locked,
   including the whole JSON Schema each tool emits with descriptions stripped at
   every depth, so a converter swap under `toJsonSchemaCompat` shows up as a
   reviewable diff rather than a silent contract change (CC-82); README tool
   table generated and diffed (readme-sync test).
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
9. **Live read suite** (credential-gated, off by default) — not a unit test:
   the read-only default of `scripts/verify-live.mjs` (the automatable half of
   Gate C, RELEASING.md §6) against the scratch site. It spawns the BUILT
   server (`build/index.js`, so `npm run build` first) over real stdio and
   runs the doctor preflight, the read claims and the residue inventory; every
   child is pinned to `JIRA_WRITE_MODE=plan`, and the write, delete and purge
   phases need `--write` / `--irreversible` / `--purge` plus `--confirm-site`,
   none of which this suite passes — so it cannot mutate a site and needs no
   cleanup path. Credentials come only from `JIRA_SITE` / `JIRA_EMAIL` /
   `JIRA_API_TOKEN`; with any of them missing the script exits 0 having done
   nothing. It answers the one question fixtures cannot: has Atlassian changed
   the wire? Each claim is a named PASS/FAIL/SKIP; exit `1` on any FAIL, `2` on
   a usage or setup error (no build, bad flags). Scheduled **weekly** in CI
   (`ci.yml` job `live`; not per-PR: it needs a secret, it is slow, and a red
   build from someone else's outage teaches the team to ignore red), with the
   scratch projects named by the optional repository variables
   `JIRA_LIVE_PROJECT` / `JIRA_LIVE_PROJECT2`. A failure is a red scheduled run
   on the default branch, never a blocked merge: the job runs on the schedule
   or by hand, not on a pull request.
10. **Distribution manifests** [test: src/manifest-sync.test.ts] — the three files
    that describe this server to somebody else's installer: `server.json`,
    `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. None is
    generated and none is imported by the code, so the test reads them: the
    registry manifest must declare exactly the user-facing `JIRA_*` set
    CONFIGURATION.md documents — same defaults, same requiredness, tokens marked
    secret — with two exemptions that name their reasons in the test; the four
    manifest version fields must equal `package.json`'s, which is the half of
    RELEASING.md §2 a file can enforce; and the plugin manifest must inject only
    documented variables, wire every field it prompts for, and never offer the
    irreversible-delete gate as a tick-box (D45, D78). Suite 8 gates code against
    the table, this one gates the shipped manifests against it.
11. **OAuth (offline, entirely)** — no test in this repo ever contacts
    Atlassian's auth host, and the network fence guarantees it rather than
    trusting it.
    - *Pure logic, no seam needed*: the PKCE pair (verifier charset and length,
      `challenge = base64url(sha256(verifier))`, method always `S256`),
      `state`-nonce shape, authorize-URL construction (every required parameter
      present, including the easily forgotten `audience`, scopes space-joined),
      token-response parsing (`expires_in` honoured, `refresh_token` optional,
      `token_type` never required), accessible-resources parsing and site
      selection — including the two documented traps: duplicate `id` values, and
      several sites with no pin producing an ambiguity error that lists them
      (CC-103).
    - *Wire tier* (`withFetch`): the token exchange and the refresh, asserted on
      method, URL, JSON body shape and the **absence** of retries — a token POST
      is never replayed on 429, 5xx or a transport error (D94). The terminal
      error set is driven from a table of the real statuses and codes
      (CC-100), and the negative case matters as much: a 500 with no `error`
      field is not terminal.
    - *Clock, not sleep*: expiry and the refresh-skew window are asserted with
      the injected `Clock`, so "refreshes two minutes early" is a deterministic
      assertion rather than a wall-clock race. The single-flight property
      (CC-98) is tested by resolving N calls against one scripted response and
      counting requests, which is a counting assertion, not a timing one.
    - *Filesystem*: the token store is exercised against a temp directory —
      round-trip, profile keying, `0600` mode, atomic replacement, and the
      rule that a failed write fails the refresh (CC-99) rather than leaving a
      rotated token in memory only.
    - *CSPRNG as a seam*: `CryptoRandom` is injected, so PKCE and `state` values
      are fixed in tests without seeding anything security-relevant in
      production and without reaching for the jitter `rng` (D96).
    - *The login CLI*: driven with the loopback listener on an ephemeral port
      and a scripted callback request. The cases that matter are the refusals —
      a mismatched `state` aborting **before** any exchange (CC-97), a callback
      with no `code`, and a non-TTY run refusing instead of hanging — plus the
      assertion that no token appears on stdout in any mode, `--json` included.
    - *Config-shaped failures*: oauth mode with an empty token store is a
      `config` error naming `login` rather than a 401 from Jira (CC-102), and a
      malformed cloudId is refused before a URL exists (CC-101).
12. **Mention resolution (D100, offline)** — one suite per ring. The `@[name]`
    grammar — extraction and conversion sharing one scanner, code spans,
    fences and escapes staying inert, the no-map output byte-identical to the
    pre-feature converter — in `src/api/adf.test.ts` (CC-108, CC-109, CC-110);
    `resolveMentionNames` against a faked `JiraRequestFn` — zero-match,
    ambiguity with the candidate list, the exact-displayName tiebreak, the
    active/non-app filter and the distinct-name cap — in
    `src/api/users.test.ts` (CC-106, CC-107, CC-112, CC-113); the tool-ring
    gating — `resolveMentions` × `format` refusal, the `mentions_skipped`
    hint, plan-time resolution — in `src/tools/issues-write.test.ts` (CC-105,
    CC-111). No network anywhere: every accountId in a fixture is synthetic.
13. **HTTP transport (D101, offline)** — one suite,
    `src/mcp/transport-http.test.ts`: a real loopback listener on an
    ephemeral port, driven with raw `http.request` the way the login-CLI
    suite drives its callback listener;
    the network fence stays untouched because it guards `fetch`, and this
    suite makes no outbound call at all. The guard pipeline is asserted per
    branch — bearer (CC-114: missing, wrong, wrong-length, and the 401 body
    never echoing the token), bind (CC-115: loopback accepts, other local
    addresses refuse, the closed port accepts nothing), Host/Origin (CC-116) —
    and the session lifecycle end to end: initialize hands back an
    `Mcp-Session-Id`, `tools/list` serves the full surface over it, DELETE and
    the idle sweep destroy it, and a plan armed in a deleted session is an
    unknown plan_id in the next one (CC-117). Idling is driven by the fake
    clock — real sockets, fake time. Shutdown resolves, closes the port and
    emits `shutdown` exactly once (CC-118). CC-119 — stdout byte-empty under
    http — is the child-process half and lives in suite 7
    (`src/index.test.ts`).
14. **The project-entity deletes (D102, offline)** — spans three extended
    files rather than owning one, because the tools extend existing rings. The
    api specs live with their families: the component and version delete
    builders — `removeAndSwap` as the only version wire, the deprecated bare
    `DELETE /version/{id}` never constructed, an empty swap body sent as
    "clear", the `relatedIssueCounts` reads — in `src/api/collab.test.ts`
    (CC-122); the sprint delete builder and the single-sprint read in
    `src/api/agile.test.ts` (CC-124's wire half). The tool ring — tier gating
    shared with the D45 deletes, before-state assembly including the thin-entity
    drop rule and the three version counts, reassignment targets riding in
    `before`, the state-guard absence with Jira's refusal re-aimed — in
    `src/tools/issues-delete.test.ts` (CC-120, CC-121, CC-123, CC-124,
    CC-125). Everything runs against fakes behind the fence, which is worth
    saying plainly: none of the three has ever been run against a real Jira
    site — they are part of the 17 unproven writes the live gate still owes.
15. **Bulk operations (D103, offline)** — the same extended-files pattern as
    suite 14. The submit tools — tier gating shared with the deletes, the
    package placement and title generalization, the 1000-issue schema cap, the
    edit-action pairing refusals, the blast-radius before-state, the ENQUEUED
    result hint, the `notifyUsers` absence rule and the `/bulk/issues/fields`
    wire path with derived `selectedActions` — in
    `src/tools/issues-delete.test.ts` (CC-126, CC-127, CC-128, CC-129, CC-130,
    CC-131, CC-133); the queue read's placement outside the irreversible
    surface and its pass-through result in `src/tools/issues.test.ts`
    (CC-132). Offline like suite 14, and the same honesty applies: none of the
    three bulk tools has ever run against a real Jira site — they join the
    unproven writes above, and both submits additionally need the global Bulk
    Change permission no fake can prove a tenant grants.

**What the OAuth suite cannot prove.** The same honesty the live gate gets
below. Every OAuth test asserts *this* code against a fake modelled on
Atlassian's documentation, so it inherits that documentation's gaps: the access
token lifetime is not documented and the fixtures simply pick one; the
error/status pairs come from probing the live endpoint once, not from a contract;
and above all, **nothing offline can prove that a loopback callback URL can be
registered in the developer console at all** (AUTH.md). A green suite means the
flow is correct if Atlassian behaves as documented. It is not a substitute for
the first real login.

**Rehearsing the live gate.** The Gate C driver is itself driven offline:
`scripts/rehearse-live.mjs` runs the real `verify-live.mjs` against the stateful
`scripts/fake-jira.mjs` over eleven passes, A–K: a full run (reads, writes and
the delete phase), a forced media redirect, an injected 429/503, an unsafe write
that must not be replayed, a withheld watcher roster (CC-47), a site without
Jira Software (CC-34), a board that already has an active sprint (CC-36), a
read-only residue inventory of what a half-finished run left behind, the
documented cleanup command clearing it, and two refusals — a destructive run
with no `--confirm-site`, and one confirming the wrong host — each of which must
end before a single request reaches the fake. F and G are the agile
degradations, and both run **with** `--write` — C27–C30 live in the write phase,
so a read-only pass would never reach the surface those passes exist to degrade.
H and I run a `--write --keep` set-up pass first, so the run under test starts on
a site that is already dirty, which is the state the inventory exists for.
It needs `openssl` and a current build, runs the eleven passes in under a
minute, and touches no network, so it is **not** part of `npm run check`; it is
nonetheless the only whole-system test
`verify-live.mjs` has, and re-running it after any edit to that file is the rule
(D72). Its three pure safety helpers — the `--confirm-site` guard, the patterns
that decide what the gate may delete, and the residue table — are additionally
pinned by `src/testing/verify-live.test.ts`, which does run in `npm run check`
and reaches the driver by the same repo-root dynamic `import()` the fixture
recorder's suite uses (D75). A green rehearsal is a statement about this code,
never about Jira's.

The single command the rehearsal rehearses is the single command Gate C runs;
on the day the only differences are the base URL and the credential. That is
also the limit of what a rehearsal is worth, and the limit is worth writing
down, because a green run against the fake is easy to mistake for a green run
against Jira. Five claims stay unproven until Atlassian answers them, and no
amount of rehearsal moves an item off this list:

- **Auth.** The fake accepts any `Authorization` header it is given. Whether an
  Atlassian API token is accepted at all, and what a wrong one looks like on the
  wire, is untested until a real 401 arrives.
- **ADF round-tripping.** The fake stores the document this server sends and
  hands the same object back. Jira normalises ADF — it rewrites marks, drops
  attributes it does not know and reorders nothing predictably — so "the
  description survived" is a claim only the real API can make.
- **Rate limiting.** Passes C and D inject a 429 and a 503 at a chosen request,
  which proves the retry code runs and that an unsafe write is never replayed.
  It proves nothing about Atlassian's real budgets, its `Retry-After` values, or
  whether this server's backoff is polite enough to survive a burst.
- **Permissions.** The fake's 403s are the ones the rehearsal asks for. A real
  tenant refuses for reasons nobody scripted — a project role, a missing
  Software licence, an admin-only field — and the hint text that turns those
  into something an operator can act on is only exercised live.
- **Pagination.** The search endpoint ([JIRA-API.md](JIRA-API.md)) is used with
  `nextPageToken` only, and the fake pages the way this repo believes Atlassian
  pages. Where the belief and the contract differ is exactly where the fake is
  silent.

Everything else the gate asserts — the claim wiring, the write/plan/apply gate,
the residue inventory, the cleanup command and both scratch-site refusals — is
settled offline and does not need a live site to stay settled.

**Determinism knobs.** The runner pins `TZ=UTC` so a machine-local timezone can
never make a date assertion pass locally and fail in CI. Because of that, the
worklog offset source (D16) must be **injected** in tests — a suite pins e.g.
`Asia/Kolkata` and asserts a `+05:30` offset while the process runs UTC, which
is exactly the split D16 describes (Jira-user timezone ≠ host timezone).
`LANG`/`LC_ALL` are pinned to `C.UTF-8` for the same reason.

## Coverage

`.c8rc.json`, `all: true`, measured over the compiled output the test runner
actually executes (`src: ["build"]`) with `excludeAfterRemap: true`, which is why
the excludes — `src/index.ts`, `src/**/*.test.ts`, `src/testing/**`,
`src/core/fakes/**`, `**/*.d.ts` — are written in `src/` terms. Remapping means
coverage **depends on source maps**, which is why the everyday build keeps them
(see §Gate).

Development scripts live outside `src`, so c8 reports one only when a test
loads it. That is the right signal for `scripts/record-fixture.mjs` and
`scripts/generate-readme.mjs`, which have suites meant to exercise them. The one
exception is excluded by name: `scripts/verify-live.mjs` is exercised by the
offline rehearsal, which is deliberately outside `npm run check`, while
`src/testing/verify-live.test.ts` imports it to pin three pure safety helpers and
nothing more — so the rest is unreachable from this suite by design, and letting
a 2000-line Gate C driver set the floor for the shipped server would make the
floor mean nothing.

Thresholds are **lines 97 / branches 94 / functions 98**, plus a statements
floor of 97, and `check-coverage: true` makes any c8 run fail when one is
missed. They started at the Phase-5 levels — the servicenow-mcp donor levels of
94 / 82 / 97 — and were ratcheted there in D105, after the branch-coverage
sweeps left the measured tree fifteen points above its own floor: a floor that
far below the tree stops catching the regression it exists to catch. They still
sit a few points under the measured tree on purpose (a floor is something that
must not creep down, not a target to chase), and that gap is also what absorbs
the small coverage differences between the two Node versions CI runs.
`npm run check` runs the suite under c8 (`test:coverage`); plain `npm run test`
stays uninstrumented for quick loops.

## Gate

`npm run check` = `check:publish && audit:prod`, where `check:publish` =
`typecheck && lint && format:check && build && tarball && test:coverage &&
docs:lint` and `audit:prod` is `npm audit --omit=dev --audit-level=high`.
`tarball` is `scripts/check-tarball.mjs` over `npm pack --dry-run --json` — the
tarball-content assertion — and `docs:lint` is the docs-regime checks from
docs/README.md. CI runs `check` on Node 22 and 24. Run before finishing any
change; report the real result.

Two release-only steps sit outside `check` and run from `prepublishOnly`
(`check:publish && build:publish && tarball:publish`): `build:publish` compiles
with `tsconfig.publish.json`, which turns `sourceMap` and `declarationMap` off,
and `tarball:publish` re-runs the checker in `--publish` mode, where a shipped
file still carrying a `sourceMappingURL` footer is a failure. The everyday build
keeps its maps on purpose — `.c8rc.json` remaps coverage through them — so the
two modes are not interchangeable and `.github/workflows/publish.yml` calls the
checker in its default mode (D80, RELEASING.md §3.1). The checker asserts
`tsconfig.publish.json`'s shape in **both** modes, so losing that file fails the
everyday gate rather than release day.

**Beware:** `build` starts with `clean`, so `npm run build`, `npm run check` and
`npm publish --dry-run` (which triggers `prepublishOnly`) all delete `build/`.
`npx tsc` and `npm pack --dry-run --json` are the read-only forms.
