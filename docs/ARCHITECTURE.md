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
2. Work **headless**: API-token auth by default, usable from cron, CI, and
   remote sessions — the primary reason not to use Atlassian's official remote
   MCP server. OAuth (Phase 8) is an opt-in alternative, never a requirement:
   the one interactive step it adds is the login, and once the grant is stored
   the server refreshes without a browser (AUTH.md).
3. Be safe by default: read-only unless explicitly enabled, plan/apply gate for
   writes, and a second gate in front of the irreversible tier — the six
   deletes (three shipped with D45, three more with D102) and the bulk
   delete/edit pair (D103). THREAT-MODEL.md owns both gate contracts.

## Non-goals (v1)

- Jira Data Center / Server support (architecture keeps the door open via the host
  allowlist, and OAuth incidentally widened it further — the credential union has
  a `bearer` arm and `HostRef` carries a path prefix). Parked by D104 and
  **un-parked in stages by D106** (IMPLEMENTATION-PLAN.md Phase 13). The
  domain-level seam D104 found missing now exists — `api/port.ts` (§Layering) —
  and a second adapter plugs into it: `api/datacenter.ts`, a read-only,
  unverified preview reachable only behind `JIRA_DATACENTER_PREVIEW=true`
  (D107). An adapter declares the tools it serves (`JiraApi.serves`), and the
  registry excludes the rest.
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
  settings, and — since Phase 8 — `oauth.ts`. The ONLY module allowed to touch
  the network is `core/http.ts`.
  - **`core/meta-cache.ts`** (D123) is a decorator on the request seam: a
    repeat bodiless `GET` on one of the metadata catalogue routes (fields,
    link types, statuses, create meta) is answered from memory for
    `JIRA_META_CACHE_TTL_S` — and `/user/search` too, capped at five
    minutes because people change faster than catalogues (D129). The registry applies it once to the plain seam,
    under the gate seams and under the per-call profile wrapper, so the key
    sees the profile and a plan-mode read warms it. It knows routes, not
    tools, and never touches the network itself.
  - **`core/oauth.ts`** holds the 3LO logic: the PKCE pair and `state` nonce,
    the authorize URL, parsing of token and accessible-resources responses, site
    selection, the `0600` token store, and the credential resolver the server
    installs in oauth mode. It performs no I/O of its own beyond that file: the
    token exchange, the refresh and the accessible-resources call all go out
    through the `AuthRequestFn` seam it is handed (D93).
  - **The import direction is one-way: `core/oauth.ts` may import
    `core/http.ts`; `core/http.ts` must never import `core/oauth.ts`.** They are
    the same ring, so no eslint zone separates them — the other direction is a
    cycle, and it would put the module that refreshes a token underneath the
    module that spends it. `http.ts` therefore exposes `AuthRequestFn` as a
    primitive and knows nothing about who calls it, while the credential
    resolver is *injected* into the request path exactly as `jiraRequest` is
    injected into `buildServer`.
  - `core/credentials.ts` stays the dependency-free leaf it was; its only
    Phase-8 change is returning the basic branch of the credential union.
- **`src/api/`** — typed wrappers over Jira REST endpoints, one module per domain
  (`search.ts`, `issues.ts`, `collab.ts`, `attachments.ts`, `filters.ts`,
  `meta.ts`, `users.ts`, `permissions.ts`, `agile.ts`, `adf.ts`, `shared.ts` for
  pagination helpers, `guards.ts` for the pure record readers and `wire.ts` for
  the shared send and failure helpers). No MCP concepts here.
  - **`api/issues.ts`** is a re-export barrel over `api/issues/` (D517): the
    issue surface split by concern (paths, read and write types, request
    builders, executors, worklog time, read shaping, the classic list reader,
    input normalization, errors) and then by sub-domain (reads, bulk,
    changelog, deletes, worklog edit, issue links, remote links). Importers
    use the barrel, never a module under `api/issues/`.
  - **`api/port.ts`** is the domain-level port (D106): `JiraApi` names every
    api-ring function a tool may call — each one that talks to Jira, and the
    converters that speak a wire body format — and `CLOUD_API` is the existing
    functions by identity. Tools reach them only as `ctx.api.<fn>`; the
    registry picks the adapter once per server. The port also re-exports the
    DTO types, schema constants and pure helpers the tools use, and carries
    the run-time page caps as `JiraApi.limits` (`ctx.api.limits`, D538), so
    `tools/**` imports `api/port.js` and no other api module.
    `tools/port-boundary.test.ts` refuses an import that would go around it.
- **`src/mcp/`** — MCP plumbing: `server.ts`, `define.ts`, `registry.ts`,
  `result.ts`, `taint.ts`, `transport.ts`, `transport-http.ts`, `write-mode.ts`,
  `write-pipeline.ts` (the one constructor of the write gate and its ordered
  layers, D523–D524), `recent-writes.ts`, `tool-helpers.ts`, `errors.ts`, `types.ts`, `schema.ts`
  (the listed-schema trim), `output-schema.ts` (the envelope `outputSchema`,
  D131), `client-hints.ts` (Claude Code `_meta` keys, D130), `resources.ts` (the reference catalogue and the
  server instructions, D124) and `prompts.ts` (`definePrompt` and the prompt
  catalogue, D125) and `sdk.ts` (the one module that imports the MCP SDK,
  D539 — everything else takes the SDK surface from it; lint-enforced). No Jira endpoint knowledge: the one document the
  mcp ring serves is the write-mode contract it owns.
- **`src/tools/`** — one file per package, each exporting a `PackageSpec`
  (`searchPackage`, `issuesPackage`, …) that `index.ts` composes into
  `PACKAGES`; thin glue from validated input → `ctx.api` call → shaped result. One
  exception earns its size: `attachments.ts` also holds the media store, because
  the rules that keep tenant-authored filenames inside one directory belong next
  to the only tools that move bytes. `references.ts` holds the package reference
  documents (JQL idioms, the markdown subset) that `search.ts` and
  `issues-write.ts` attach through `PackageSpec.references`. The portfolio
  package (D126) splits its pure analysis and rendering into
  `portfolio-analysis.ts` and `portfolio-render.ts`, so `portfolio.ts` holds
  only the sweep, the tools and its report store. `plan-context.ts` holds the
  plan-time field diff the issue writes declare as `planContext` (D132).

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
  It is the one-shot form of `createServerFactory(deps)` (D540), which computes
  the process-scoped surface (selection, catalogues, completer, listed tools,
  instructions) once and whose `build({ recentWrites })` adds only the session
  half (recent writes, the gate bound to that session's `Server`, the registry).
- `main()` (`src/index.ts`) — the real bootstrap: `loadSettings()` → `collectSecrets` →
  `createRedactor` → `createLogger` → `createJiraRequest` → registry → transport.
  Guarded by `process.argv[1] === fileURLToPath(import.meta.url)` so importing the
  module never boots the server. CLI subcommands (`doctor`, `login`, `logout`)
  are dispatched before the server starts, lazily imported — `login` in
  particular pulls in a loopback HTTP listener that a server run must never
  load.

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
  (`@modelcontextprotocol/sdk/server/zod-json-schema-compat.js`, re-exported by
  `mcp/sdk.ts`).
- SDK seam (D539): only `src/mcp/sdk.ts` imports `@modelcontextprotocol/sdk`;
  the Streamable HTTP transport class is loaded lazily through it, so stdio
  never loads the HTTP stack. Tests may use the SDK client side directly.
- Capabilities: `{ tools: { listChanged: true }, resources: {}, prompts: {}, completions: {}, logging: {} }`
  (docs-lint check 10 compares this line with `src/mcp/server.ts`); completions are
  pure, drawn from the manifest (D154, `mcp/completions.ts`);
  `instructions` come from `serverInstructions` (TOOLS.md §Reference resources);
  prompts are listed only when every tool they name is registered (TOOLS.md
  §Prompts).
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
- the optional `example` (a one-line summary plus the tool's own arguments)
  must parse against the schema and carry no control field (CC-1417);
- the spec is `Object.freeze`d.

The ordered `PACKAGES: PackageSpec[]` manifest in `src/tools/index.ts` is the
**single source of truth**. Its readers include server registration
(`src/index.ts` → `mcp/registry.ts`), the reference catalogue
(`mcp/resources.ts`, which also reads `PackageSpec.references`), the prompt
catalogue (`mcp/prompts.ts`, which reads `PackageSpec.prompts`), completions
(`mcp/server.ts` hands every manifest tool name from `deps.packages` to
`mcp/completions.ts`), the manifest snapshot test (`src/tools/index.test.ts`),
and the surface facts (`scripts/surface-facts.mjs`, which feeds README
generation and docs-lint's count check) plus the startup benchmark
(`scripts/bench-startup.mjs`). `cli/doctor.ts` validates the package env vars
with `mcp/registry.ts`'s `expandSelection`, which reads the package ids
(`mcp/types.ts`), not the manifest. The list is not closed: a new consumer reads
`PACKAGES` (or `createPackages`) rather than restating tool names. It does
**not** generate the distribution manifests: `server.json` is hand-maintained and *checked* against
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
retryable: boolean, remediation?: string, reason?: string }`. Messages state
cause, then recovery action; `reason` carries the cause sentence alone
(always set by the factory, so composers append hints without re-parsing the
message); machine-stable `kind` codes live in a documented catalog and are
substring-asserted in tests. Error text is redacted at construction time:
`createJiraError` (`core/errors.ts`) is the only constructor, and a direct
`new JiraError(...)` elsewhere is an eslint error (D536).
HTTP-level detail extraction reads Jira's `errorMessages[]` / `errors{}` /
`message` shapes (see JIRA-API.md).

## Cross-cutting seams

- **Clock**: `Date.now()` and bare timers are banned outside `core/clock.ts`
  [eslint]; all time flows through an injected `Clock` with `sleep`.
- **RNG**: retry jitter (and correlation ids) come from an injected `rng: () =>
  number`, never `Math.random()` [eslint] — backoff sequences are asserted
  exactly in tests (CC-11…CC-14).
  Plan ids, which a caller must not guess, draw bytes from the separate
  `SecureRandom` seam (`core/rng.ts`, `randomBytes`), injected the same way
  (D511).
- **Timeout**: `clock.sleep(timeoutMs)` raced against the fetch promise, with an
  explicit `AbortController` aborted by whichever side loses. `AbortSignal.timeout`
  is banned — it owns a real timer the fake clock cannot drive, which would make
  timeout tests wall-clock-bound.
- **Host**: resolved once into `{ origin, pathPrefix }`, not a bare string. In
  basic mode the prefix is empty; the OAuth gateway is exactly a different
  origin plus a prefix (JIRA-API.md §OAuth 2.0 (3LO)). The door the v1 shape
  kept open is now walked through: Phase 8 added a gateway host builder and
  changed no call site, which is the whole return on having chosen a record over
  a string.
- **Credentials**: `CredentialResolver` is per-call and **may be async** (D92),
  because an OAuth resolver refreshes. It returns a discriminated union — basic
  or bearer, `kind` required — and one function turns that union into an
  `Authorization` header. A resolver, not a field, is what lets a token rotate
  underneath a running server without anything above `core/` noticing.
- **`AuthRequestFn`**: the narrow primitive inside `core/http.ts` for the two
  Atlassian OAuth endpoints. It exists because "only `core/http.ts` touches the
  network" is a rule, and a rule with one exception has as many exceptions as
  anyone wants (D93). It is deliberately smaller than `jiraRequest`: two
  methods, an absolute URL checked against exactly two permitted origins, a JSON
  body, no redirect following, no body logging, and no replay of a POST.
- **CSPRNG**: PKCE verifiers and `state` nonces come from `node:crypto`,
  injected as a `CryptoRandom` seam — **never** from the `rng` above, which is a
  jitter source and is explicitly not a security primitive (D96). Two random
  seams look redundant until you notice that one of them is seeded to make
  backoff sequences reproducible.
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
  any request is made. The second tool-side directory is `JIRA_REPORT_DIR`
  (D126): the report store in `tools/portfolio.ts` writes generated file
  names only — never a name from Jira or the caller — exclusively and `0600`,
  and reads nothing back. The write journal (`core/journal.ts`) is the other
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

- **stdio** — the default (`mcp/transport.ts`). Shuts down cleanly on stdin
  EOF, SIGINT, SIGTERM.
- **Streamable HTTP** (`JIRA_TRANSPORT=http`) — a loopback-only Streamable
  HTTP listener, `mcp/transport-http.ts`. O-11 was resolved by its own default
  at the Phase-2a start (D19): no concrete use case had appeared, so v1
  shipped stdio-only and this section kept the design. D101 reinstated it as
  designed — what follows is no longer a kept plan; it is what
  `src/mcp/transport-http.ts` does.

  Every request passes one pipeline, in one order: only `/mcp` is served (no
  `/healthz` — a loopback-only, single-user server has no load balancer to
  answer to; doctor is the health check); the `Host` header must be the bound
  loopback authority and an `Origin` header, when present, must be a loopback
  origin (DNS-rebinding defense, CC-116); a constant-time bearer check against
  `JIRA_HTTP_TOKEN` (CC-114) — settings refuse `http` without the token
  (CC-30), and the transport refuses again if handed such settings, so the
  gate fails closed twice; only then is the request routed by method and
  `Mcp-Session-Id`.

  Sessions: one MCP session per `Mcp-Session-Id`, created on `initialize` and
  destroyed on `DELETE` or idle timeout. One SDK `Server` binds one transport,
  so each session gets its own server from one `createServerFactory` (D540),
  sharing the process-scoped surface; tearing a session down aborts its in-flight calls. The plan_id
  table is one store for the whole process (D513), so a wire that answers a
  session from another `Server` still finds its plans; each plan is bound to
  the session and credential fingerprint that planned it (D512), and the
  transport's `onSessionClosed` drops a session's plans as it ends, with a
  TTL and a per-session quota on top (D514, CC-117). The idle sweeper is an async sleep-loop on the
  injected `Clock` (no raw timers, same rule as everywhere else);
  SIGINT/SIGTERM close the listener, tear down every live session and resolve
  (CC-118). Under http the protocol rides the socket and stdout carries
  nothing at all (CC-119); diagnostics stay on stderr. Like the login CLI's
  callback listener, the module performs inbound loopback I/O only — "only
  `core/http.ts` touches the network" is a rule about outbound egress, and
  neither listener makes an outbound call.

  The recent-write registry (CC-02, `mcp/recent-writes.ts`) is per session
  too: `src/index.ts` builds each session's server with its own
  `createRecentWrites()`, and `buildServer` runs every tool call inside
  `withRecentWrites`, so one client's writes never widen another client's
  searches (CC-244). The module-level `sessionRecentWrites` remains only as the
  fallback for stdio (one process, one session) and for handlers called outside
  a server, as unit tests do.

## Package gating and write safety

- `JIRA_TOOL_PACKAGES` (profiles `core` / `reader` / `all` or explicit list),
  `JIRA_PACKAGES_DENY` (deny wins; `core` is force-re-added),
  `JIRA_PACKAGES_READONLY` (drops write-tier tools).
- `JIRA_WRITE_MODE=plan|apply` (default `plan`): in `plan` mode write tools
  return a description of what they would do; `apply` requires per-call
  `apply: true`. The irreversible tier (the six deletes and the two bulk
  writes) sits above that gate
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
