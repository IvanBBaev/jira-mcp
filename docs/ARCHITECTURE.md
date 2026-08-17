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
   writes, no destructive operations in v1.

## Non-goals (v1)

- Jira Data Center / Server support (architecture keeps the door open via the host
  allowlist; auth for DC is a v2 item).
- Attachment upload/download.
- Confluence, JSM operations, Bitbucket, Compass.
- Full markdown ↔ ADF fidelity (v1 ships plain-text conversion; a markdown subset
  is v1.5 — see ROADMAP.md).

## Layering

```
core  ←  api  ←  mcp  ←  tools
```

- **`src/core/`** — no Jira domain knowledge beyond the wire protocol. Config
  loading, host resolution, the HTTP client, errors, logging, redaction, clock,
  settings. The ONLY module allowed to touch the network is `core/http.ts`.
- **`src/api/`** — typed wrappers over Jira REST endpoints, one module per domain
  (`search.ts`, `issues.ts`, `meta.ts`, `users.ts`, `agile.ts`, `adf.ts`,
  `shared.ts` for pagination helpers). No MCP concepts here.
- **`src/mcp/`** — MCP plumbing: `define.ts`, `registry.ts`, `result.ts`,
  `taint.ts`, `transport.ts`, `write-mode.ts`, `errors.ts`. No Jira endpoint
  knowledge.
- **`src/tools/`** — one file per package exporting `specs: ToolSpec[]`; thin glue
  from validated input → api call → shaped result.

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
**single source of truth** consumed by: server registration, the manifest snapshot
test, README generation, and `server.json` generation. Empty packages are listed
deliberately as visible roadmap holes.

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
- **Redaction**: `core/redact.ts` registers secret values once; a single choke
  point strips them from logs, errors, and results. Additionally strips
  `Authorization` header echoes and any `os_authType`/token query substrings.
- **stdout is the protocol**: all diagnostics go to stderr via the injected
  structured logger; `no-console` eslint rule allows only `warn`/`error`; a
  console guard redirects stray `console.log` to stderr under stdio transport.

## Transport

- **stdio** (default). Shuts down cleanly on stdin EOF, SIGINT, SIGTERM.
- **Streamable HTTP** (`JIRA_TRANSPORT=http`): binds **loopback only**, fails
  closed without `JIRA_HTTP_TOKEN`, requires bearer + same-origin `Origin` check
  (DNS-rebinding defense). Lifecycle: one MCP session per `Mcp-Session-Id`,
  created on `initialize` and destroyed on `DELETE` or idle timeout (15 min);
  session teardown aborts that session's in-flight requests via its
  `AbortController` and clears its plan_id table, so a dropped client can never
  leave an armed apply behind. SIGTERM stops accepting new sessions, drains
  in-flight calls under the call budget, then exits. No `/healthz` — a
  loopback-only, single-user server has no load balancer to answer to; doctor
  is the health check.

  **Status: O-11 open.** The default is demotion to v1.5 unless a concrete use
  case appears; the spec above exists so the decision is a scheduling call, not
  a design one.

## Package gating and write safety

- `JIRA_TOOL_PACKAGES` (profiles `core` / `reader` / `all` or explicit list),
  `JIRA_PACKAGES_DENY` (deny wins; `core` is force-re-added),
  `JIRA_PACKAGES_READONLY` (drops write-tier tools).
- `JIRA_WRITE_MODE=plan|apply` (default `plan`): in `plan` mode write tools
  return a description of what they would do; `apply` requires per-call
  `apply: true`. Normative gate contract + tiers: THREAT-MODEL.md (single owner).

## Decisions

The decision ledger (accepted D1–D16, open owner decisions O-1…O-13 minus the
resolved O-7, gates A–C) lives in **DECISIONS.md** — the single source of
truth for decision status. Highlights shaping this architecture: custom server
over Atlassian Rovo (D1), Cloud-only Basic auth v1 (D2), port of
servicenow-mcp's dark Jira client (D3), low-level `Server` (D5), `/search/jql`
only (D6), `plan_id`-bound apply (D14).
