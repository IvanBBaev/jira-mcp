# Architecture

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. Read this document first; docs/README.md maps which document
> owns which class of fact.

`jira-mcp-ai` is a Model Context Protocol (MCP) server for Jira Cloud, written in
TypeScript. It follows the house template established by its sibling repos:

- **facebook-mcp** — the skeleton: dependency-injected `buildServer`, low-level SDK
  `Server`, colocated tests, network fence, contract fakes, tiered write gate.
- **tiktok-mcp** — the strictness: `defineTool` with import-time assertions,
  `ToolResult<T>` envelope, full `docs/` spec set.
- **servicenow-mcp** — the donor of a complete but dark Jira Cloud client
  (`src/core/jira/*`, `src/api/jira/shared.ts`) that this repo ports.

## Goals

1. Give Claude (and any MCP client) a reliable, token-efficient tool surface over
   Jira Cloud: JQL search, issue CRUD, transitions, comments, worklogs, project and
   field metadata, users, boards and sprints.
2. Work **headless**: API-token auth, no browser OAuth dance, usable from cron,
   CI, and remote sessions — the primary reason not to use Atlassian's official
   remote MCP server.
3. Be safe by default: read-only unless explicitly enabled, plan/apply gate for
   writes, and a second gate in front of the irreversible tier — the three
   deletes that shipped with D45. THREAT-MODEL.md owns both gate contracts.

## Non-goals (v1)

- Jira Data Center / Server support (architecture keeps the door open via the host
  allowlist; auth for DC is a v2 item).
- Confluence, JSM operations, Bitbucket, Compass.
- Full markdown ↔ ADF fidelity. A **subset** ships (headings, lists, code fences,
  inline code, bold/italic, links, mentions — D38); anything outside it degrades
  to plain text rather than round-tripping.

Two entries that used to sit here graduated into committed scope and are gone
from this list, not merely deferred: the markdown ↔ ADF subset above (D38, Wave
6) and attachment metadata/download/upload (D45, Wave 7).

## Layering

```
core  ←  api  ←  mcp  ←  tools
```

- **`src/core/`** — no Jira domain knowledge beyond the wire protocol. Config
  loading, host resolution, the HTTP client, errors, logging, redaction, clock,
  settings. The ONLY module allowed to touch the network is `core/http.ts`.
- **`src/api/`** — typed wrappers over Jira REST endpoints, one module per domain
  (`search.ts`, `issues.ts`, `collab.ts`, `attachments.ts`, `filters.ts`,
  `meta.ts`, `users.ts`, `agile.ts`, `adf.ts`, `shared.ts` for pagination
  helpers). No MCP concepts here.
- **`src/mcp/`** — MCP plumbing: `server.ts`, `define.ts`, `registry.ts`,
  `result.ts`, `taint.ts`, `transport.ts`, `write-mode.ts`, `recent-writes.ts`,
  `tool-helpers.ts`, `errors.ts`, `types.ts`. No Jira endpoint knowledge.
- **`src/tools/`** — one file per package, each exporting a `PackageSpec`
  (`searchPackage`, `issuesPackage`, …) that `index.ts` composes into
  `PACKAGES`; thin glue from validated input → api call → shaped result. One
  exception earns its size: `attachments.ts` also holds the media store, because
  the rules that keep tenant-authored filenames inside one directory belong next
  to the only tools that move bytes.

Layering is enforced twice in `eslint.config.js` (copied from facebook-mcp):
`import-x/no-restricted-paths` zones AND string-based `no-restricted-imports`
patterns, so enforcement never depends on module resolution.

## Typing strategy

Wire data enters as `unknown` and is narrowed by **hand-rolled minimal
interfaces plus runtime guards** at the `api/` boundary — we type only the
fields we actually read, and a guard failure becomes a `JiraError`
(`kind: "unexpected_shape"`), never a thrown `TypeError` deep in a tool.

OpenAPI codegen is **explicitly rejected**: Atlassian's spec is enormous and
churns, generated types are optimistic about optionality, and the fields that
matter most (`customfield_10xxx`) are instance-specific and absent from any
spec — so codegen would buy breadth we never use while still leaving the hard
part untyped. `any` is banned [eslint]; `unknown` + guard is the idiom.

## Dependency injection boundary

The entry concern splits into:

- `buildServer(deps: BuildServerDeps): ConnectableServer` (`src/mcp/server.ts`) —
  **pure**: no env, no process streams, no transport. Receives settings,
  `jiraRequest`, logger, redactor, clock, journal, write gate, and the package
  manifest. The manifest is *injected*, which is what lets `buildServer` live in
  the mcp ring without importing `tools/` — and it cannot live in `src/index.ts`,
  which is import-free at module scope (below) while `buildServer` is
  synchronous. Tests drive it with fixture tools and a fake request function.
- `main()` (`src/index.ts`) — the real bootstrap: `loadSettings()` → `collectSecrets` →
  `createRedactor` → `createLogger` → `createJiraRequest` → registry → transport.
  Guarded by `process.argv[1] === fileURLToPath(import.meta.url)` so importing the
  module never boots the server. CLI subcommands (`doctor`, later `login`) are
  dispatched before the server starts, lazily imported.

`main` is a **frozen export name**: under `npx`/`bin` the process argv[1] is the
CJS launcher shim, so the self-run guard is false by construction and the shim
has to call the entry explicitly. Renaming the export turns every installed
binary into a no-op that exits 0 — the failure mode with no error message.

`src/index.ts` is import-free at module scope, with one exception: a Node
version guard runs first, then everything is a dynamic `import()`. The
exception is `core/credentials.ts` (WP-51) — a deliberately dependency-free
leaf (type-only imports, host resolver injected) holding the one credential
rule, which the entry point re-exports (`buildCredentialResolver`) and doctor
and `loadSettings` consume; a second static import stays banned. Before the
server path loads anything else, `serve()` rebinds the whole `console` to
stderr so a dependency's stray `console.log` cannot reach the protocol stream
(CLI paths keep their stdout). Set `process.exitCode`, never call
`process.exit()` (piped stdout must not be truncated).

## MCP server style

- **Low-level `Server`** from the SDK with
  `setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)` — NOT
  `McpServer.registerTool`, whose private zod validation throws `McpError` and
  loses the `structuredContent` envelope.
- JSON Schema derived from zod via the SDK's own `toJsonSchemaCompat`
  (`@modelcontextprotocol/sdk/server/zod-json-schema-compat.js`).
- Capabilities: `{ tools: { listChanged: true }, logging: {} }`.
- Zod runtime usage quarantined to `src/mcp/define.ts`.

## Tool definition contract

`defineTool<Schema>(def)` is an identity function with **import-time assertions**:

- name matches `^jira_[a-z0-9]+(_[a-z0-9]+)*$`;
- non-empty title and description; known package tag;
- input schema is forced `.strict()` and probed behaviourally
  (`rejectsUnknownKeys`);
- the full annotation quadruple (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) is mandatory;
- `readOnlyHint && destructiveHint` is rejected; `writeTier ⇔ !readOnlyHint`;
- the spec is `Object.freeze`d.

The ordered `PACKAGES: PackageSpec[]` manifest in `src/tools/index.ts` is the
**single source of truth** consumed by exactly three readers: server registration
(`src/index.ts` → `mcp/registry.ts`), the manifest snapshot test
(`src/tools/index.test.ts`), and README generation
(`scripts/generate-readme.mjs`). It does **not** generate the distribution
manifests: `server.json` is hand-maintained and *checked* against
docs/CONFIGURATION.md by `src/manifest-sync.test.ts` (D78). Empty packages are
listed deliberately as visible roadmap holes.

## Result envelope

`ToolResult<T> = { ok: boolean, data?: T, error?: ErrorRecord, hints?: Hint[] }`
with a closed hint vocabulary. Results are mirrored as text + `structuredContent`.
Truncation (budget `JIRA_MAX_RESULT_CHARS`, default in CONFIGURATION.md) drops **whole items**
so output is always valid JSON (exception: a single item alone over budget is
field-truncated with an ellipsis marker — CC-26); `ok`/`error`/`hints`
and a `_truncation` marker always survive.

## Error model

One error type: `JiraError { kind, httpStatus?, jiraMessages?: string[],
retryable: boolean, remediation?: string }`. Messages state cause, then recovery
action; machine-stable `kind` codes live in a documented catalog and are
substring-asserted in tests. Error text is redacted at construction time.
HTTP-level detail extraction reads Jira's `errorMessages[]` / `errors{}` /
`message` shapes (see JIRA-API.md).

## Cross-cutting seams

- **Clock**: `Date.now()` and bare timers are banned outside `core/clock.ts`
  [eslint]; all time flows through an injected `Clock` with `sleep`.
- **RNG**: retry jitter (and correlation ids) come from an injected `rng: () =>
  number`, never `Math.random()` [eslint] — backoff sequences are asserted
  exactly in tests (CC-11…CC-14).
- **Timeout**: `clock.sleep(timeoutMs)` raced against the fetch promise, with an
  explicit `AbortController` aborted by whichever side loses. `AbortSignal.timeout`
  is banned — it owns a real timer the fake clock cannot drive, which would make
  timeout tests wall-clock-bound.
- **Host**: resolved once into `{ origin, pathPrefix }`, not a bare string.
  v1 pathPrefix is empty; the v2 OAuth gateway
  (`api.atlassian.com/ex/jira/{cloudId}`) is exactly a different origin plus a
  prefix, so the shape keeps that door open without touching call sites.
- **Plan mode**: the gate is a seam, not a branch inside every tool —
  `buildServer` receives a `jiraRequest` that, in `plan` mode, **captures** the
  method/path/body a write would have sent and returns it instead of calling
  the network. Tools stay identical in both modes; the "nothing hit the
  network" property is testable at the seam (CC-20).
- **Fetch**: read off `globalThis` at call time — the test seam for `withFetch`.
- **Filesystem**: the only bytes this server reads or writes on behalf of a tool
  live under one directory (`JIRA_MEDIA_DIR`, CONFIGURATION.md), and the media
  store in `tools/attachments.ts` is the single place that resolves a path
  against it — sanitizing tenant-authored filenames, refusing symlinks that
  escape, and never overwriting. Unset, the two byte-moving tools refuse before
  any request is made. The write journal (`core/journal.ts`) is the other
  filesystem writer and is append-only.
- **Taint**: any result field that can carry text authored inside Jira is marked
  by `mcp/taint.ts` as data rather than instructions, at one choke point rather
  than per tool — so a new tool inherits the marking instead of remembering it.
- **Redaction**: `core/redact.ts` registers secret values once; a single choke
  point strips them from logs, errors, and results. Additionally strips
  `Authorization` header echoes and any `os_authType`/token query substrings.
- **stdout is the protocol**: all diagnostics go to stderr via the injected
  structured logger; `no-console` eslint rule allows only `warn`/`error`; a
  console guard redirects stray `console.log` to stderr under stdio transport.

## Transport

- **stdio** — the default, and the only transport v1 accepts. Shuts down cleanly
  on stdin EOF, SIGINT, SIGTERM.
- **Streamable HTTP** (`JIRA_TRANSPORT=http`) — **refused at startup**, with an
  error naming v1.5. O-11 was resolved by its own default at the Phase-2a start
  (D19): no concrete use case appeared, and the http path drags in a token gate,
  loopback binding and session handling for zero current users. Two layers hold
  the line: `core/settings.ts` still rejects `http` without `JIRA_HTTP_TOKEN`
  (CC-30) and still parses `JIRA_HTTP_PORT`, so the configuration surface
  survives the gap unchanged; `mcp/transport.ts` then refuses any transport
  other than stdio outright, token or no token.

  The v1.5 design is kept below so reinstating it stays a scheduling call rather
  than a design one — **none of it exists in `src/` today**: bind loopback only,
  fail closed without a bearer token, check `Origin` for same origin
  (DNS-rebinding defense); one MCP session per `Mcp-Session-Id`, created on
  `initialize` and destroyed on `DELETE` or idle timeout; session teardown
  aborts that session's in-flight requests via its `AbortController` and clears
  its plan_id table, so a dropped client can never leave an armed apply behind;
  SIGTERM stops accepting new sessions, drains in-flight calls under the call
  budget, then exits. No `/healthz` — a loopback-only, single-user server has no
  load balancer to answer to; doctor is the health check.

## Package gating and write safety

- `JIRA_TOOL_PACKAGES` (profiles `core` / `reader` / `all` or explicit list),
  `JIRA_PACKAGES_DENY` (deny wins; `core` is force-re-added),
  `JIRA_PACKAGES_READONLY` (drops write-tier tools).
- `JIRA_WRITE_MODE=plan|apply` (default `plan`): in `plan` mode write tools
  return a description of what they would do; `apply` requires per-call
  `apply: true`. The irreversible tier (the three deletes) sits above that gate
  and needs `JIRA_ALLOW_IRREVERSIBLE` as well, because a blanket write mode set
  for ordinary edits must never be read as consent to destroy. Normative gate
  contract + tiers: THREAT-MODEL.md (single owner); the variables and their
  defaults: CONFIGURATION.md.

## Decisions

The decision ledger — accepted decisions (`D-nn`), owner decisions (`O-nn`) and
gates A–C — lives in **DECISIONS.md**, the single source of truth for decision
status. Which decisions exist, and which O-rows are still open, is stated there
and deliberately not restated here, where it would rot.
Highlights shaping this architecture: custom server
over Atlassian Rovo (D1), Cloud-only Basic auth v1 (D2), port of
servicenow-mcp's dark Jira client (D3), low-level `Server` (D5), `/search/jql`
only (D6), `plan_id`-bound apply (D14).
