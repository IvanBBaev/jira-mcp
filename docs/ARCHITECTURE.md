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
   writes, and a second gate in front of the irreversible tier — the six
   deletes: three shipped with D45, three more with D102. THREAT-MODEL.md owns
   both gate contracts.

## Non-goals (v1)

- Jira Data Center / Server support (architecture keeps the door open via the host
  allowlist, and OAuth incidentally widened it further — the credential union has
  a `bearer` arm and `HostRef` carries a path prefix). **Parked by D104**, not
  scheduled: the unblocking event is a real DC host plus a closed Gate C on
  Cloud, and ROADMAP.md carries the measured cost. The seam that is still
  missing is a domain-level one — `JiraRequestFn` is transport-level, so a route
  *shape* difference has nowhere to plug in today.
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
  `meta.ts`, `users.ts`, `agile.ts`, `adf.ts`, `shared.ts` for pagination
  helpers). No MCP concepts here.
- **`src/mcp/`** — MCP plumbing: `server.ts`, `define.ts`, `registry.ts`,
  `result.ts`, `taint.ts`, `transport.ts`, `transport-http.ts`, `write-mode.ts`,
  `recent-writes.ts`, `tool-helpers.ts`, `errors.ts`, `types.ts`. No Jira
  endpoint knowledge.
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
retryable: boolean, remediation?: string, reason?: string }`. Messages state
cause, then recovery action; `reason` carries the cause sentence alone
(always set by the factory, so composers append hints without re-parsing the
message); machine-stable `kind` codes live in a documented catalog and are
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
  so each session gets its own `buildServer` product from an injected
  factory — which is what makes plan death structural rather than a cleanup
  chore: the write gate's plan_id table lives inside each session's `Server`,
  so tearing the session down aborts its in-flight calls and takes its armed
  plans with it (CC-117). The idle sweeper is an async sleep-loop on the
  injected `Clock` (no raw timers, same rule as everywhere else);
  SIGINT/SIGTERM close the listener, tear down every live session and resolve
  (CC-118). Under http the protocol rides the socket and stdout carries
  nothing at all (CC-119); diagnostics stay on stderr. Like the login CLI's
  callback listener, the module performs inbound loopback I/O only — "only
  `core/http.ts` touches the network" is a rule about outbound egress, and
  neither listener makes an outbound call.

  One honest exception to per-session isolation: `sessionRecentWrites`
  (`mcp/recent-writes.ts`) is a module singleton, so the recent-write registry
  (CC-02) is shared by every session in the process. For a loopback
  single-user server that is accepted, not overlooked — the sessions belong to
  the same human.

## Package gating and write safety

- `JIRA_TOOL_PACKAGES` (profiles `core` / `reader` / `all` or explicit list),
  `JIRA_PACKAGES_DENY` (deny wins; `core` is force-re-added),
  `JIRA_PACKAGES_READONLY` (drops write-tier tools).
- `JIRA_WRITE_MODE=plan|apply` (default `plan`): in `plan` mode write tools
  return a description of what they would do; `apply` requires per-call
  `apply: true`. The irreversible tier (the six deletes) sits above that gate
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
