# Contributing

Thanks for looking at `jira-mcp-ai`. This is a small, opinionated MCP server, and
most of its opinions are written down: the specification in [`docs/`](docs/README.md)
and the code ship together, and a disagreement between them is a bug in whichever
one is wrong. Reading [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first will
save you more time than reading the source.

Everything written in this repository is English — code, comments, docs, commit
messages, PR descriptions, test names.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
**Security problems are not issues**: see [`SECURITY.md`](SECURITY.md) and use
private reporting.

## Getting set up

- **Node.js ≥ 22.** That floor is real, not cautious: env files are read with
  `process.loadEnvFile()` rather than a dotenv dependency (D10). CI runs the gate
  on 22.x and 24.x, so a change that only works on one of them is a failure.
- `npm ci` — the lockfile is committed and is what CI installs from.
- No Jira credentials are needed to build, test or lint. The test suite runs
  behind a network fence and never talks to a real site.

## The gate: `npm run check`

One command decides whether a change is finishable. Run it before you open a PR
and **report the real result** — not "should be green".

```sh
npm run check
```

It runs, in order:

1. `typecheck` — `tsc --noEmit`.
2. `lint` — ESLint, including the layering zones and the seam rules below.
3. `format:check` — `prettier --check .` over everything not in
   [`.prettierignore`](.prettierignore). Note that `docs/`, `README.md` and the
   local-only AI-harness files are deliberately outside Prettier's reach; the
   root markdown files (this one included) are inside it.
4. `build` — `tsc` into `build/`, after wiping it.
5. `tarball` — `scripts/check-tarball.mjs` asserts what an `npm pack` would
   contain: no tests, no source maps, no test helpers, nothing unexpected.
6. `test:coverage` — the whole suite under c8, with the floors in
   [`.c8rc.json`](.c8rc.json) (lines 94 / branches 82 / functions 97 /
   statements 94) enforced. Those are floors that must not creep down.
7. `docs:lint` — `scripts/docs-lint.mjs` over the spec corpus (see below).
8. `audit:prod` — `npm audit --omit=dev --audit-level=high`.

Steps 1–7 are `check:publish`; `check` is `check:publish && audit:prod`. The
split exists because `prepublishOnly` runs `check:publish` only: the audit is the
one step whose verdict depends on a remote database at the moment it runs, and a
publish must not fail because an advisory landed (or a registry blinked) between
the green CI run and the tag. For a contributor there is no difference — run
`npm run check`.

## Tests

- **Colocated.** `src/api/search.ts` is tested by `src/api/search.test.ts`. There
  is no separate test tree and no test framework — `node --test` over the
  compiled output.
- **`npm test` runs `build/`, not `src/`.** Build first (`npm run build`), or run
  `npm run coverage`, which builds for you. A stale `build/` is the most common
  way to "fix" a test without fixing anything.
- **The network fence is always on.** `node --import ./build/testing/network-fence.js`
  replaces global `fetch` with a guard that throws synchronously, so an
  accidental real request fails loudly instead of passing quietly. The harness
  also strips ambient `JIRA_*` variables, so your local credentials cannot
  change a test's verdict. The single exception is the live read suite, gated on
  `JIRA_LIVE_TEST=1`, which opens both doors at once — real env and real sockets
  — so a run can never end up half-fenced.
- **Two mocking tiers.** Wire level: `withFetch()` from `src/testing/` records
  every call and scripts responses. Contract level: `fakeJiraRequest` and the
  other fakes in `src/core/fakes/` hand an api or tool module canned
  `JiraResponse` values. Reach for the highest tier that can still prove the
  thing you changed.
- **Time is injected.** Tests drive retries and backoff through the fake clock;
  a test that sleeps in real time is a test that will be flaky on someone else's
  laptop.
- The taxonomy — what each of the nine suites is for, the determinism knobs
  (`TZ=UTC`, `LANG`/`LC_ALL`), the coverage policy — is
  [`docs/TESTING.md`](docs/TESTING.md).
- **Never commit real tenant data.** Test data must use placeholder account ids,
  `@example.invalid` addresses and `example.atlassian.net`. Anything recorded
  from a real site is committed forever.

## Rules that are not up for negotiation

These are enforced by lint or by tests, so a PR that breaks one cannot land. They
exist for reasons written down in [`docs/DECISIONS.md`](docs/DECISIONS.md) — if
you think one is wrong, argue with the decision row, do not route around the
rule.

- **Layering `core ← api ← mcp ← tools`.** `core` imports nothing above itself,
  `api` nothing from `mcp`/`tools`/`cli`, `mcp` nothing from `tools`/`cli`.
  ESLint enforces this as import zones. Never weaken a zone to land a change.
- **Only `core/http.ts` touches the network.** It reads `fetch` off `globalThis`
  at call time (which is what makes the fence and the wire-tier mocks possible).
  No other module may import a network primitive.
- **Time only through the injected `Clock`.** `Date.now()`, `setTimeout` and
  friends are lint errors outside the clock seam.
- **stdout is the MCP protocol.** Every diagnostic goes to stderr; a console
  guard redirects stray `console.log`, and a test spawns the real binary to
  prove stdout stayed pure JSON-RPC.
- **Writes stay behind the gate.** `JIRA_WRITE_MODE` defaults to `plan`;
  executing takes `apply` mode, an explicit `apply: true` and a matching
  single-use `plan_id`. The three deletes need `JIRA_ALLOW_IRREVERSIBLE` on top.
  Unsafe writes are never replayed after an ambiguous failure — the retry policy
  in [`docs/JIRA-API.md`](docs/JIRA-API.md) is canonical.
- **Jira v3 API only**, ADF bodies, users identified by `accountId`, and search
  goes through `/rest/api/3/search/jql` with `nextPageToken`. The legacy
  `/search` endpoint was removed server-side in 2025 — do not reintroduce it.
- **Jira content is untrusted input** and is labelled as data (`_untrusted`),
  never merged into instructions.

## The spec corpus is normative

[`docs/`](docs/README.md) is not documentation-after-the-fact. Every normative
fact has exactly **one** owning document — env names and defaults live in
`CONFIGURATION.md`, wire constants in `JIRA-API.md`, the tool catalog in
`TOOLS.md`, the write-gate contract in `THREAT-MODEL.md`, and so on (the
ownership table is in [`docs/README.md`](docs/README.md)). Every other mention
must be a pointer, not a copy.

The practical consequence for a contributor:

- **A code change that contradicts a doc changes the doc in the same PR.** Drift
  is a bug, and a reviewer will treat it as one.
- Add a `JIRA_*` variable and you must add its row to `CONFIGURATION.md` — a test
  compares the set of names read in `src/**` against that table and fails on an
  undocumented variable _and_ on a documented-but-dead one.
- Change the tool surface and `TOOLS.md` is the place it is defined; the README's
  tool table is generated (`npm run readme`) and asserted, so hand-editing it
  will fail.
- `scripts/docs-lint.mjs` enforces the mechanical subset, including the status
  banner each document is allowed to claim.

## The two ledgers

**[`docs/DECISIONS.md`](docs/DECISIONS.md)** is append-only. Add a row when your
change makes a choice that a future reader could reasonably reverse by accident —
a rejected alternative, a deliberate asymmetry, a scope boundary. A reversed
decision gets a _new_ row that supersedes the old one; rows are never edited in
place and never renumbered. The format is one line:

```text
| D<n> | YYYY-MM-DD | decision | rationale |
```

Literal pipes inside a cell are escaped `\|`. The rationale column is the point
of the file — "because it is better" is not one.

**[`docs/CORNER-CASES.md`](docs/CORNER-CASES.md)** catalogs behaviours the
implementation must get right, with stable ids `CC-nn`. Add a row when you find
something Jira (or the protocol) forces on us that is not obvious from the happy
path: an error shape, an eventually-consistent read, a permission-masked 404, a
200 that means "withheld" rather than "empty". Ids are never renumbered — new
cases append, dead cases are struck through with a note, gaps stay gaps — and at
least one test should name the id it covers.

A behavioural change that arrives with neither a decision row nor a corner case
is usually an incomplete change, not a small one.

## Commits and pull requests

- One concern per PR. A refactor plus a behaviour change is two PRs.
- Commit subjects in the imperative mood ("Add the withheld-watchers note"), and
  a body that explains _why_. Reference `D`/`CC` ids where they apply.
- Include the real `npm run check` output, and say what you could not run.
- If you touched `core/http.ts`, the redactor, the write gate, the host
  allowlist or the attachment paths, say in the PR what the security consequence
  is. Those are the load-bearing walls of
  [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
- Never include credentials, `.env` files, real issue keys, real account ids or
  real customer text — in the diff, in the description, or in a screenshot.
- Large or speculative changes: open an issue first. The tool surface is
  deliberately bounded, and "one more tool" has a context-window cost for every
  user of the server.

## Running against a real Jira site

You do not need a site to contribute. If you want one:

- **Use a scratch site, not your employer's tenant.** A free Atlassian Cloud site
  costs nothing and cannot leak anyone's data into a model context. Pointing this
  server at a production tenant makes you responsible for having the right to
  export what it reads (see `docs/THREAT-MODEL.md` §Data handling).
- Create an API token at _id.atlassian.com → Security → API tokens_, and put it
  in an env file rather than your shell history. [`.env.example`](.env.example)
  shows the shape; `docs/CONFIGURATION.md` owns the names and the resolution
  order (`JIRA_ENV_FILE`, then `$XDG_CONFIG_HOME/jira-mcp-ai/.env`, then a
  project-local `.env`). Files the CLI writes are created `0600`.
- **Leave `JIRA_WRITE_MODE` on `plan`.** That is the default and it is the whole
  safety story: write tools describe the request they would send instead of
  sending it. Set `apply` only for a deliberate experiment, and leave
  `JIRA_ALLOW_IRREVERSIBLE` unset — blanket apply mode never covers the deletes.
- **Check the setup with `doctor`** before wiring anything into a client. From a
  source checkout:

  ```sh
  npm run build
  node bin/jira-mcp-ai.cjs doctor            # local + network probes
  node bin/jira-mcp-ai.cjs doctor --offline  # local probes only, no requests
  node bin/jira-mcp-ai.cjs doctor --json     # machine-readable report
  ```

  Exit codes: `0` all probes passed, `1` a probe failed, `2` usage or config
  error. The report is redacted, but it does name your site and account — treat a
  pasted report the way you would treat any other work artifact.

- **The live suite is read-only.** `JIRA_LIVE_TEST=1 npm test` runs the probes
  that ask the one question fixtures cannot ("has Atlassian changed the wire?").
  No write tool is ever exercised live, so there is nothing to clean up.
- `scripts/verify-live.mjs` is the fuller end-to-end runbook against a scratch
  project. It reads by default; the write phase needs `--write` and the delete
  phase needs `--irreversible`, neither implies the other, and every mutation is
  confined to a throwaway issue it created itself. Read its header before running
  it with a write flag.

## Reporting bugs and asking for features

Use the issue forms — they ask for the things that actually make a Jira MCP bug
diagnosable (version, Node, client, write mode, tool name, redacted error). Jira
issue text and Jira error bodies routinely contain confidential data, so redact
before pasting, and never paste a token: a token in a public issue is a token you
must rotate immediately.
