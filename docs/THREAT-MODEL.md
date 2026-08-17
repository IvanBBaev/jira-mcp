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

## Defenses

### Credentials
- Single redaction choke point (`core/redact.ts`): secret values registered at
  startup; all logs, `JiraError` messages (redacted in constructor), and shaped
  results pass through it. Structural stripping of `Authorization` echoes and
  token-bearing query strings happens before value redaction.
- Registered values are matched as **literal text**, so protection never depends
  on a secret looking like a credential — but a placeholder token that is very
  short, or that spells a word this server prints itself (`t`, `settings`), also
  matches ordinary output and buries the transcript under placeholders. The
  redactor registers it anyway: declining to protect a value the operator
  believes is protected trades a usability problem for a disclosure one. Startup
  validation raises a `warning`-severity finding naming the variable instead —
  visible in doctor and in the startup report, and never blocking the run
  [test: src/core/settings.test.ts].
- **Scope note: redaction targets secrets, not PII.** Emails, display names and
  account ids in tool results are legitimate payload — minimizing them is a
  shaping-level concern (see Data handling below and the user-shaping contract
  in TOOLS.md), not the redactor's job. Conflating the two would either break
  results or give false privacy assurance.
- Basic-auth header built in `core/http.ts` only; `extraHeaders` rejects
  `authorization`/`accept`/`content-type` overrides (ported rule).
- Env files 0600, atomic writes, cross-process lock.

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
  blocklist still applies; exactly ONE hop, and only from a binary GET; and no
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
  components, versions, attachment upload) — and `irreversible`, which is the
  three deletes (issue, comment, worklog) graduated by D45. D7's blanket v1
  exclusion of deletes matured into this tier: what was missing was never the
  endpoint, it was the ceremony. Bulk operations stay out of scope entirely
  (ROADMAP.md). Which tool sits in which tier is TOOLS.md's catalog.
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
  unauditable (CC-62…CC-66).
- Non-idempotent writes are NEVER auto-retried after an ambiguous failure
  (timeout/5xx after send); the error instructs the model to verify state first.
  Deletes are the literal case: a second call answers 404, not 204, so they are
  annotated `idempotentHint: false` and a replay could only report something
  untrue (D58). An attachment upload that fails mid-flight is the same shape —
  `ambiguous_write`, never replayed, remediation naming the attachment listing,
  because a blind resend leaves the issue with two copies (CC-59).
- Optional write journal (`JIRA_JOURNAL_PATH`): JSONL audit of every write call
  (content form: open decision O-8 in DECISIONS.md).

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
- HTTP: loopback bind only; fails closed without `JIRA_HTTP_TOKEN`;
  `timingSafeEqual` bearer comparison; same-origin `Origin` check.

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
  URL into a client that renders the markdown. `adfFromMarkdown` never
  synthesises a `mention`, so text that round-trips through the converter
  cannot fabricate a notification to an arbitrary account.

### Supply chain
- **Direct** runtime deps limited to `@modelcontextprotocol/sdk` and `zod`
  (dotenv dropped — D10 in DECISIONS.md: env files load via
  `process.loadEnvFile`). Say *direct*: the installed production tree is ~94
  packages, because the SDK depends unconditionally on a full HTTP/OAuth server
  stack (express, hono, cors, ajv, jose, pkce-challenge, eventsource). This
  server is stdio-only — `src/mcp/transport.ts` constructs
  `StdioServerTransport` and nothing else — so that half of the tree installs on
  every user's machine and never executes. Unreachable code is still attack
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
  telemetry and calls no endpoint other than the configured Jira site, but it
  cannot control what the client does with results. Whether provider terms
  permit training on the data depends on the user's plan (consumer vs
  Team/Enterprise) — open decision O-13 records which applies here. Attachment
  *content* is the deliberate exception: it goes to disk and the tool returns a
  path, so a downloaded file is the one payload that does not enter the model's
  context.
- **Authorization duty**: pointing this server at an employer's Jira tenant
  makes the operator responsible for having the right to export that data into
  an AI context — same duty as with any Jira API script, but worth stating
  because the data flow is less obvious.
- **Transcript persistence**: Jira content survives in MCP client transcripts
  and logs outside this server's control. Server-side there are exactly two
  places data lands: the write journal, if enabled, whose content form is
  deliberately minimized (O-8), and files written by `jira_download_attachment`
  into `JIRA_MEDIA_DIR` — real tenant documents, at `0600`, kept until the
  operator deletes them. Nothing else is written; there is no cache.
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
