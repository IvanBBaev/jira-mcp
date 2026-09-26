# Threat model

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document is the **owner of the write-gate contract** and
> the security posture; TOOLS.md, ARCHITECTURE.md and
> CONFIGURATION.md point here. (The root `SECURITY.md`, created in Phase 0, is
> the vulnerability-reporting policy — a different document.)

## Threat model (what we defend against)

1. **Credential leakage** — the API token appearing in logs, error messages, tool
   results, or the write journal.
2. **SSRF / host confusion** — a prompt-injected or buggy model steering requests
   to an attacker host via `JIRA_SITE`-like inputs or server-provided URLs.
3. **Unintended writes** — the model creating/mutating Jira data the user did not
   ask for, or retry logic duplicating writes.
4. **Transport exposure** — the HTTP transport reachable beyond localhost or
   without auth; DNS rebinding.
5. **Prompt injection via Jira content** — issue descriptions/comments are
   untrusted input that flows into the model's context.
6. **Local filesystem abuse** — attachments are the only local-disk surface: a
   tenant-authored filename escaping `JIRA_MEDIA_DIR` or clobbering a file
   already there, and an upload argument turning the server into a
   read-anything-on-disk exfiltration primitive.
7. **Irreversible data loss** — a delete the tenant cannot undo, reached either
   by a blanket `apply` mode or by a replay of an ambiguous failure.
8. **Supply chain** — compromised dependencies.
9. **OAuth credential theft and flow hijack** (oauth mode only) — the stored
   refresh token read off disk, an authorization code intercepted on the
   callback leg, or a forged callback binding the server to an account the
   operator does not own.

## Defenses

### Credentials
- Single redaction choke point (`core/redact.ts`): secret values registered at
  startup; all logs, `JiraError` messages (redacted where they are built —
  `createJiraError`, `core/http.ts`'s `makeFail` — and again in the result
  envelope), and shaped results pass through it. Structural stripping of
  `Authorization` and `Cookie` echoes, URL-userinfo passwords and token-bearing
  query strings runs after value redaction, as a shape-based backstop for a
  credential nobody registered. Because that backstop also sees issue text, a
  word after `Basic`/`Bearer`/`Authorization:`/`Cookie:` is masked only when it
  looks like a credential (a digit, a token symbol or an internal case change),
  so ordinary prose is not corrupted (CC-155). Error texts are scrubbed before
  they are cut to length, never after (CC-158).
- Registered values are matched as **literal text**, so protection never depends
  on a secret looking like a credential — but a placeholder token that is very
  short, or that spells a word this server prints itself (`t`, `settings`), also
  matches ordinary output and buries the transcript under placeholders. The
  redactor registers it anyway: declining to protect a value the operator
  believes is protected trades a usability problem for a disclosure one. Startup
  validation raises a `warning`-severity finding naming the variable instead —
  visible in doctor (the server's stderr shows only the finding count and worst
  severity), and never blocking the run [test: src/core/settings.test.ts].
- **Scope note: redaction targets secrets, not PII.** Emails, display names and
  account ids in tool results are legitimate payload — minimizing them is a
  shaping-level concern (see Data handling below and the user-shaping contract
  in TOOLS.md), not the redactor's job. Conflating the two would either break
  results or give false privacy assurance.
- Basic-auth header built in `core/http.ts` only; the request spec exposes no
  header override at all, so `authorization`/`accept`/`content-type` are set
  in exactly one place and nothing upstream can replace them. The bearer
  header of oauth mode is built by the same function, switching on the
  credential's `kind` — one Authorization producer, not two. A Data Center PAT
  (`JIRA_AUTH_MODE=pat`, D106) rides the same `bearer` arm; it is registered
  with the redactor whenever it is set, and the deployment/mode pairing is
  enforced at startup so a Cloud credential is never sent to a Data Center host
  or the reverse (CC-255, CC-258). The Data Center adapter is an unverified
  preview and does not start without `JIRA_DATACENTER_PREVIEW=true` (CC-254,
  CC-269); its user projection is an allowlist like Cloud's, so a DC user's
  `emailAddress` never reaches a result (CC-264).
- Env files 0600, atomic writes, cross-process lock.

### OAuth 2.0 (3LO) — oauth mode only

Nothing here applies to a basic-mode deployment; the mechanics are AUTH.md's,
the exposure is this document's.

- **The refresh token is the durable credential, and it lives in a file.**
  `<config dir>/oauth.json` (or `JIRA_OAUTH_TOKEN_FILE`) is written `0600`,
  atomically, under the same cross-process locking scheme as the env file (its
  own `oauth.json.lock`), and every token
  read out of it is registered with the redactor before use. Treat it exactly
  like the env file: anyone who can read it can act as the operator against the
  granted scopes until the rolling 90-day inactivity window elapses. Backups,
  synced home directories and container images copy it as readily as anything
  else on disk.
- **Local deletion is not containment.** `logout` removes the file's entry and
  nothing more — this server never calls the revocation endpoint, which
  Atlassian's OpenID metadata advertises but its 3LO documentation does not
  mention (AUTH.md). A copy taken before logout keeps working. If you believe
  the file was exposed, the real responses are removing the app's authorisation
  from the Atlassian account and rotating the client secret in the developer
  console; deleting the local file is housekeeping.
- **The client secret is a second real secret.** It sits in the env file with
  the same 0600 protection and is registered with the redactor at load. It is
  required (D98) — there is no configuration of this server that authenticates
  to Atlassian without it — so "we use PKCE" is never a reason to store it less
  carefully.
- **The callback leg.** The authorization code arrives over plain HTTP on a
  loopback listener bound to `127.0.0.1` only, never `0.0.0.0`, and torn down in
  a `finally` so a crashed login does not leave a port open (CC-104). Loopback
  traffic does not cross a network, so the exposure is local: another process
  running as the same user, which — being the same user — could equally read the
  token file. The listener answers exactly one path, rejects a request with no
  `code`, and exists only for the duration of the flow.
- **`state`, and the attack it exists for.** Atlassian's 3LO page carries a full
  session-fixation walkthrough, and it is worth stating in its own shape rather
  than as "CSRF": the attacker begins a login of their own, obtains an
  authorization code for **their** Atlassian account, and then induces the
  victim's client to complete the flow with that code. Nothing is stolen at
  that moment — instead the victim's server ends up holding a valid token for
  the *attacker's* tenant, and every subsequent tool call reads and writes there.
  A tenant the operator believes is theirs, that is not, is a data-exfiltration
  channel the operator feeds by hand. The defence is a `state` nonce from
  `node:crypto`, compared in **constant time**, with a mismatch aborting before
  any token exchange happens (CC-97). It is generated per flow and never reused.
- **What PKCE does and does not buy us.** It buys the binding of an
  authorization code to the `code_verifier` that requested it, so a code
  observed on the callback leg cannot be redeemed by whoever observed it. That
  is genuine, and it costs nothing. What it does **not** buy: it is not a
  substitute for the client secret and does not make this a public client
  (D98) — the exchange already fails without the secret, which is why PKCE's
  marginal value here is smaller than in the mobile-app case it was designed
  for; it protects the code only, never the refresh token or the token file;
  and it does nothing about a forged callback, which is `state`'s job. Any
  wording that presents PKCE as the security story of this feature is wrong.
- **Egress does not widen for basic-mode users.** `auth.atlassian.com` and
  `api.atlassian.com` are appended to the effective allowlist only in oauth mode
  (D97), and the auth primitive refuses any URL outside those two origins and
  follows no redirects. A basic-mode deployment's reachable-host set is
  byte-for-byte what it was before this feature existed.
- **A cloudId is a path segment**, validated against an anchored
  letters-digits-hyphens pattern before any URL is built (CC-101). It arrives
  from an Atlassian response or from operator config, but the gateway URL is
  concatenated, and an unvalidated segment containing `/` or `..` is a
  path-injection primitive against `api.atlassian.com`, not a formatting bug.
- **Refresh failures do not become retry storms.** A token POST is never
  replayed (D94, JIRA-API.md), and the terminal error set ends the session with
  a remediation instead of hammering the auth host with a dead token (CC-100).

### SSRF / egress
- Default-deny host allowlist: the canonical Cloud suffix (JIRA-API.md §Hosts)
  plus explicit `JIRA_ALLOWED_HOSTS` (exact host or anchored regex; `endsWith`
  matching is banned by construction).
- Server-provided absolute URLs (`self`, `paging.next`) are never followed;
  requests are always rebuilt from path + params against the resolved host.
- Redirects off-host or to absolute paths are rejected.
- **The one hop we do take: attachment media (D46).** Attachment content is
  requested with `?redirect=false`, but Jira may still answer 303 pointing at a
  signed, short-lived URL on an Atlassian media host that is neither the site
  host nor knowable in advance. `JIRA_ALLOWED_HOSTS` deliberately does **not**
  grow to cover it — the only way to allowlist an unknowable host is a
  wildcard, which is strictly worse than a tightly bounded anonymous hop, and
  the allowlist keeps its meaning: it says which *Jira site* this server talks
  to. What bounds the hop instead: `redirect: 'manual'` on every fetch, so
  nothing is ever followed implicitly; `https` only; the private/link-local
  blocklist still applies (IPv6 literals are parsed numerically, so mapped,
  NAT64 and 6to4 spellings of a blocked IPv4 are refused too, CC-157); exactly ONE hop, and only from a binary GET; and no
  credentials on it — no `Authorization`, no XSRF header, no cookies, because
  the signature in the URL is the only credential the media host needs (and is
  therefore itself a secret, never logged). A second redirect, a missing or
  unparseable `Location`, a non-https target or a blocked host is `kind=config`
  and not retryable; a JSON GET is never redirected at all (CC-53).

### Write safety (normative gate contract — single owner: this document)
- `JIRA_WRITE_MODE=plan` is the default: write tools return a plan (what would be
  sent where) instead of executing. `apply` mode still requires per-call
  `apply: true`.
- Write tiers: `standard` — writes a later call can put back, or that touch one
  field of one record (issue writes, the sprint lifecycle, watchers, votes,
  components, versions, attachment upload) — and `irreversible`: the six
  deletes — issue, comment and worklog graduated by D45; component, version
  and sprint by D102, each of which makes Jira rewrite or strip every issue
  that referenced the deleted entity — plus the two bulk writes (D103), which
  multiply the blast radius to as many as 1000 issues in a single call; the
  tier's ceremony is exactly the mitigation that number demands. D7's blanket
  v1 exclusion of deletes matured into this tier: what was missing was never
  the endpoint, it was the ceremony. Which tool sits in which tier is
  TOOLS.md's catalog.
- **The irreversible tier's second gate is an environment variable —
  `JIRA_ALLOW_IRREVERSIBLE` (CONFIGURATION.md) — not a per-call confirm token
  (D56).** A blanket `JIRA_WRITE_MODE=apply` never covers the tier. The donor's
  confirm-token design was considered and rejected: a token that travels in a
  tool argument is filled in by the *model*, a ceremony it performs on itself
  that proves nothing about operator intent; it would duplicate `plan_id`
  (D14); and to be usable it would have to be printed where the model can read
  it, turning a secret into a constant. The variable is set by the human who
  starts the process and is invisible to the model — a different authority,
  which is the whole point of a second gate.
- The tier check sits **after the plan branch and before `plan_id`
  consumption**. Planning a delete therefore always works, including on a server
  that will never permit the apply (CC-61) — refusing to plan would push a model
  towards guessing what a delete would cost — and a refusal is local: nothing
  reaches the network and the caller's single-use id is not burned (CC-60). The
  operator flips the variable and restarts, and the plan the model was shown is
  still the plan.
- **A delete plan carries a before-state snapshot** of what the apply would
  destroy (D57): the entity as it exists right now, read by the handler through
  the same seam, allowlisted field by field rather than echoed off the wire,
  free text and subtask lists excerpted with explicit truncation flags, and put
  through the redactor like any other plan payload. A successful apply echoes
  the same snapshot — Jira answers 204 with no body and the journal line carries
  only an `argsHash`, so a receipt saying `{deleted: true}` would be
  unauditable (CC-62…CC-66, CC-120…CC-125). The bulk writes keep the ceremony
  with a different snapshot: the request's own blast radius — a count and a
  capped id echo — because pre-fetching up to 1000 issues would be its own
  incident, and the server's verdict arrives on the queue read
  (CC-126…CC-133).
- Non-idempotent writes are NEVER auto-retried after an ambiguous failure
  (timeout/5xx after send); the error instructs the model to verify state first.
  Deletes are the literal case: a second call answers 404, not 204, so they are
  annotated `idempotentHint: false` and a replay could only report something
  untrue (D58). An attachment upload that fails mid-flight is the same shape —
  `ambiguous_write`, never replayed, remediation naming the attachment listing,
  because a blind resend leaves the issue with two copies (CC-59).
- Optional write journal (`JIRA_JOURNAL_PATH`): JSONL audit of every executed
  write call, metadata only — a hash of the arguments, never their values (O-8;
  line shape in OBSERVABILITY.md §Write journal).

### Local filesystem
Attachments are the only feature that touches local disk, and both directions
are bounded by one directory: `JIRA_MEDIA_DIR` (CONFIGURATION.md). Unset, the
two byte-moving tools refuse with `kind=config` having made zero Jira calls,
while attachment *metadata* keeps working — it needs no directory (CC-58).

- **A Jira filename is untrusted tenant text (D15) and never reaches a path
  unsanitized** (D49): separators of both families, `..`, control characters,
  `NUL`, Windows-forbidden characters and trailing dots/spaces are stripped,
  Windows device names get a prefix, the name is truncated keeping a short
  extension, and an empty result falls back to a fixed name. `../../etc/passwd`
  therefore lands inside the media directory as `passwd`, and the untouched
  original is still reported to the model as `filename` inside the taint
  envelope (CC-55). The directory stays flat — no subdirectory is created or
  traversed.
- **A download never overwrites.** The file is opened `wx`, a collision
  uniquifies (up to a bounded number of attempts, then `validation`), and the
  mode is `0600` like the env files above. Two downloads of one attachment leave
  two files, which is why the tool is annotated `idempotentHint: false` (D47,
  CC-56) rather than quietly clobbering the first.
- **An upload reads a plain basename inside the media directory and refuses
  anything else instead of rewriting it** (D48): `../secret`, `/etc/passwd`,
  `sub/dir/f` and the backslash variants are `kind=validation` with no file
  opened and no request sent, and the store re-resolves and re-checks the prefix
  as an independent second lock (a non-regular file is refused too). Silently
  sanitizing the name would upload a *different* file than the one asked for;
  accepting a path would turn a Jira tool into a general file-exfiltration
  primitive — the one place where a helpful rewrite is the vulnerability
  (CC-57).
- Size caps apply in both directions and are enforced during the transfer, not
  after it (CC-54), so an oversized body is never buffered whole.

### Transport
- stdio: console guard; protocol on stdout, diagnostics on stderr.
- HTTP (D101): loopback bind only (CC-115); fails closed without
  `JIRA_HTTP_TOKEN` — twice, in settings (CC-30) and again in the transport;
  constant-time `timingSafeEqual` bearer comparison on every request (CC-114);
  `Host` checked against the bound loopback authority and `Origin`, when
  present, against loopback origins before any JSON-RPC is processed (CC-116);
  one session per `Mcp-Session-Id`, whose teardown takes its armed plans with
  it (CC-117); a POST body read under a 4 MiB cap, after the bearer check, so
  an authenticated client still cannot make the process buffer an unbounded
  body (CC-139); and at most 32 sessions at once, so an initialize loop that
  never sends DELETE cannot grow the server set either (CC-209).

### Untrusted content
- ADF flattening produces plain text — no markdown link smuggling from rendered
  HTML; inlineCard URLs are printed verbatim, not fetched.
- **Taint envelope (D15).** Reads that can carry Jira-authored free text
  (issue, search, comments, changelog, worklogs) are branded `_untrusted: true`
  + hint `untrusted_content`, and their text rendering leads with the injection
  warning inside stable delimiters. The threat is concrete: JSM portals and
  mail handlers let people **outside** the tenant write into descriptions and
  comments, so "internal tool" does not mean "trusted input".
- This is a visibility control, not a boundary — the server cannot sanitize
  intent, only bound size (truncation budget) and make provenance obvious. The
  hard control against a text-driven write is the plan/apply gate above:
  an injected instruction still needs `JIRA_WRITE_MODE=apply`, `apply: true`
  and a `plan_id` the human's plan produced.
- **A delete's before-state is the sharpest instance of the same problem**: it
  is tenant-authored prose (summary, comment body, display names) put in front
  of a model that is deciding whether to destroy it. Every delete result is
  branded `_untrusted` even though it is a write, precisely because a write
  normally only echoes what the caller sent and this one does not (CC-64).
- **Attachment bytes never enter the model's context.** A download writes the
  file and returns a path, a size and a mime type; the server neither parses nor
  renders attachment content, so an attachment cannot inject anything into the
  conversation. What it *can* influence is its own filename, handled under
  §Local filesystem.
- Normative contract (which tools, what the envelope looks like): TOOLS.md
  §Untrusted content.
- Markdown rendering does not widen the injection surface: `format: "markdown"`
  renders the same Jira-authored text inside the same taint fence, and the
  renderer emits link markup only for `http(s):` and `mailto:` hrefs — any
  other scheme (`javascript:`, `data:`, `file:`) loses its href and renders as
  text, so a description written by a third party cannot smuggle an executable
  URL into a client that renders the markdown. Strings the renderer takes
  from node attributes (mention and status text, card URLs, media names) are
  markdown-escaped too, so an attribute cannot forge a link or a fake
  placeholder (CC-147). The write side mirrors the scheme rule:
  `adfFromMarkdown` never plants a `javascript:`, `vbscript:` or `data:` link
  mark — the link is written as plain text (CC-153) — and its inline scans run
  on a linear budget, so a crafted input at the size cap cannot stall the
  server (CC-149). Mention synthesis stays closed
  under D100's opt-in resolution: `adfFromMarkdown` still emits no `mention`
  node on its own — only the tool ring can hand it one, keyed to a
  `@[Display Name]` token, and only when the caller set `resolveMentions:
  true` on a markdown write. The mitigations are layered: the flag defaults
  off; the bracketed syntax is disjoint from the `@Display Name` the read side
  emits, so round-tripped untrusted text never re-resolves (CC-110); every
  emitted accountId comes from a live user-search response in the same call,
  never from input text (CC-108); and an unknown or ambiguous name refuses
  with candidates instead of guessing a target (CC-106, CC-107).

### Supply chain
- **Direct** runtime deps limited to `@modelcontextprotocol/sdk` and `zod`
  (dotenv dropped — D10 in DECISIONS.md: env files load via
  `process.loadEnvFile`). Say *direct*: the installed production tree is ~94
  packages, because the SDK depends unconditionally on a full HTTP/OAuth server
  stack (express, hono, cors, ajv, jose, pkce-challenge, eventsource). Under
  the default stdio transport `src/mcp/transport.ts` constructs
  `StdioServerTransport` and that half of the tree installs on every user's
  machine without executing; `JIRA_TRANSPORT=http` (D101) constructs
  `StreamableHTTPServerTransport`, which runs on bare `node:http` — selecting
  it executes more of the SDK, not more of the dependency tree, and the
  install is identical either way. Unreachable code is still attack
  surface at install time (lifecycle scripts, typosquats on a transitive), and
  it is not fixable from this repo; it is a property of the SDK's dependency
  layout. The honest claim is "two direct runtime dependencies", never "a
  two-package install".
- `npm audit --omit=dev --audit-level=high` inside `npm run check`; lockfile
  committed; dependabot with 7-day cooldown; CodeQL runs from
  `.github/workflows/codeql.yml` (advanced setup: `javascript-typescript` +
  `actions`, `security-extended`, SHA-pinned, no secret, weekly and on every
  PR). Secret scanning with push protection, private vulnerability reporting
  and Dependabot **security** updates are repository settings rather than
  files, and remain pending owner actions.

## Data handling & acceptable use

This section is the only place that states what the tool does with data — the
README's *Data handling* section points here instead of restating it — and it
exists because an MCP server is a data conduit, not just a client:

- **Outbound flow**: every tool result — issue content, comments, user names —
  enters the MCP client's model context and is transmitted to the AI provider
  (e.g. Anthropic) under *that* subscription's terms. The server adds no
  telemetry and calls no endpoint other than the configured Jira site (plus
  Atlassian's auth and gateway hosts in oauth mode, and the one bounded media
  hop of `jira_download_attachment`), but it cannot control what the client
  does with results. Whether provider terms
  permit training on the data depends on the operator's own plan (consumer vs
  Team/Enterprise), and this document cannot state it for them: the package is
  public, so every deployment runs under a different subscription (O-13). Check
  the terms of the plan the MCP client is signed into before pointing the
  server at tenant data. Attachment *content* is the deliberate exception: it
  goes to disk and the tool returns a path, so a downloaded file is the one
  payload that does not enter the model's context.
- **Authorization duty**: pointing this server at an employer's Jira tenant
  makes the operator responsible for having the right to export that data into
  an AI context — same duty as with any Jira API script, but worth stating
  because the data flow is less obvious.
- **Transcript persistence**: Jira content survives in MCP client transcripts
  and logs outside this server's control. Server-side there are exactly two
  places data lands: the write journal, if enabled, whose content form is
  deliberately minimized (O-8), and files written by `jira_download_attachment`
  into `JIRA_MEDIA_DIR` — real tenant documents, at `0600`, kept until the
  operator deletes them. In oauth mode the token store is a third file the
  server writes, but it holds credentials and a site identifier, never tenant
  content. No other tenant data is written and there is no cache; the only
  other files the server touches are operator-initiated (`doctor --save`'s env
  file) or transient (`<file>.lock` directories, `<journal>.1` rotation).
- **Acceptable use**: the tool surface (worklogs, changelogs, user search, and
  now watcher/vote lists and project-role membership) can technically
  reconstruct colleague activity. Using it for workplace
  monitoring/surveillance of individuals is outside the intended use and, in
  most jurisdictions, subject to labor/privacy law. This bullet is where that is
  stated; the README carries no separate acceptable-use text, only a pointer to
  this document.
- **PII minimization**: user objects are shaped to
  `{ accountId, displayName, active? }`; email appears only when a tool is
  explicitly asked (`includeEmail: true`) — see TOOLS.md shaping contract. The
  people-shaped Wave-7 reads keep that discipline: watcher rows and project-role
  actors are the same projection, and a group actor is reported as a group and
  never expanded into its members (D55). Where the tenant itself withholds a
  list, the result says so instead of looking empty — a caller without "View
  voters and watchers" gets `watchersVisible: false` plus a note, never a
  confident "nobody is watching" (D54, CC-47).

## Reporting

`SECURITY.md` at repo root (publish artifact) carries the disclosure policy:
supported versions, private vulnerability reporting through GitHub rather than a
public issue, and what to expect after a report. It is deliberately *not* a
second threat model — it links back here for that.
