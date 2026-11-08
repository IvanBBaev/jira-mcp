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
6. **Local filesystem abuse and data at rest** — four sinks write tenant data
   to disk (§Local filesystem: the write journal, attachment downloads, file
   exports and portfolio reports): a tenant-authored filename escaping
   `JIRA_MEDIA_DIR` or clobbering a file already there, an upload argument
   turning the server into a read-anything-on-disk exfiltration primitive, and
   tenant content left on disk where an operator does not expect it.
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
  credential nobody registered. The backstop also masks a value by the
  credential or header key it sits under in structured output (CC-564), the
  whole URL userinfo including a colon-less token (CC-565), and a credential
  parameter percent-encoded inside another parameter's value (CC-566).
  Because that backstop also sees issue text, a
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
- **The client-credentials grant (D302) moves the durable credential back into
  the env file.** With `JIRA_OAUTH_GRANT=client_credentials` there is no
  refresh token and no token file: the client id and secret alone mint a
  service-account token, so the secret is now what a refresh token is under
  3LO — whoever reads it acts as the service account until it is rotated in
  Atlassian Administration. It is redacted like every credential, the minted
  token lives in process memory only, and a failed mint is never replayed in a
  loop (CC-3010). Egress is unchanged: the same two OAuth origins.

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
  field of one record — and `irreversible`: the deletes and unlinks Jira
  cannot undo — issue, comment and worklog graduated by D45; component,
  version and sprint by D102, each of which makes Jira rewrite or strip every
  issue that referenced the deleted entity — plus the two bulk writes (D103),
  which multiply the blast radius to as many as 1000 issues in a single call;
  the tier's ceremony is exactly the mitigation that number demands. D7's
  blanket v1 exclusion of deletes matured into this tier: what was missing was
  never the endpoint, it was the ceremony. The two lists below are the whole
  write surface; a test derives both from the tool manifest and fails when
  either list here disagrees (CC-5140, CC-5141). TOOLS.md's catalog carries
  the same tiers per package.
  - `irreversible`: <!-- tools:irreversible -->`jira_delete_issue`,
    `jira_delete_comment`, `jira_delete_worklog`, `jira_unlink_issues`,
    `jira_delete_attachment`, `jira_delete_remote_link`,
    `jira_delete_component`, `jira_delete_version`, `jira_delete_sprint`,
    `jira_bulk_delete_issues`, `jira_bulk_edit_issues`<!-- /tools -->.
  - `standard`: <!-- tools:standard -->`jira_create_filter`,
    `jira_update_filter`, `jira_create_issue`, `jira_update_issue`,
    `jira_transition_issue`, `jira_add_comment`, `jira_update_comment`,
    `jira_assign_issue`, `jira_add_worklog`, `jira_update_worklog`,
    `jira_link_issues`, `jira_add_remote_link`, `jira_upload_attachment`,
    `jira_add_watcher`, `jira_remove_watcher`, `jira_add_vote`,
    `jira_remove_vote`, `jira_create_component`, `jira_update_component`,
    `jira_create_version`, `jira_update_version`, `jira_move_to_sprint`,
    `jira_move_to_backlog`, `jira_create_sprint`, `jira_start_sprint`,
    `jira_close_sprint`, `jira_update_sprint`, `jira_rank_issues`,
    `jira_set_estimate`<!-- /tools -->.
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
- **Optional third gate: a human confirmation per irreversible apply
  (`JIRA_IRREVERSIBLE_CONFIRM=elicit`, D303).** The question travels from the
  server to the client's UI through MCP form elicitation, so — unlike the
  confirm token D56 rejected — the model cannot answer it. It is checked
  before any network read: a client that does not declare form elicitation is
  refused and the plan is kept. It is asked after the claim and the stale
  check, quoting the request and the plan's redacted before-state; anything
  but an explicit yes (decline, cancel, a failed delivery) refuses the call
  and spends the plan (CC-3013…CC-3017). Residual risk: a client that
  auto-accepts elicitations collapses this gate into the other two.
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
- **What plan/apply is not: a human check against prompt injection (SEC-01).**
  In `apply` mode the model that asks for a write receives the `plan_id` and
  can spend it in its next call; nothing in that round trip involves the
  human. The plan step defends against accidents — a write the model did not
  mean, a retry of an ambiguous failure — and gives a client a diff to show
  before the apply. It does not stop a model that injected text has steered:
  for the `standard` tier the only checks between an injected instruction and
  an executed write are the operator's choice of `apply` mode, the client's
  own per-tool approval, `JIRA_PROJECTS` and the token's Jira permissions. The
  `irreversible` tier adds two controls the model cannot reach —
  `JIRA_ALLOW_IRREVERSIBLE` and, opt-in, the elicitation confirm above. A
  deployment that reads text written by people outside the tenant (JSM
  portals, mail handlers) and needs a human on every write should stay in
  `plan` mode, set `JIRA_WRITE_CONFIRM=elicit` (below), or rely on a client
  that asks before each tool call.
- **Optional human confirmation per write (`JIRA_WRITE_CONFIRM`, D529, SEC-01).**
  `elicit` puts the same form-elicitation question as D303 in front of every
  applied write, any tier; `tainted` does so only once this session's gate
  has returned a result branded `_untrusted` (a read of tenant text, a plan
  carrying a before-state or diff, a receipt) and then stays on for the
  session. The order is D303's: the availability check comes before the claim,
  so a client that does not declare form elicitation is refused
  (`write_confirm_unavailable`, naming `JIRA_WRITE_CONFIRM`) with the plan
  kept, and a registry built without a server has no confirmer and fails
  closed; a decline, cancel or undeliverable question spends the plan and
  nothing unsafe is sent (CC-5230…CC-5237). It adds to
  `JIRA_IRREVERSIBLE_CONFIRM` and never weakens it; default `off` keeps
  today's behaviour. Residual risks: a client that auto-accepts collapses it;
  the `tainted` latch sees only tool results passing the gate, not resources
  or prompts a client reads, it is per session and in memory, and it is a
  heuristic — `elicit` is the setting that does not depend on it.
- **The confirm prompt never lets tenant text speak first (D530, SEC-06).**
  An elicitation message is shown verbatim, so the question opens with a
  server-authored action line — `Confirm WRITE|IRREVERSIBLE <tool>: <METHOD>
  <path>.` plus the consequence — and anything that may carry tenant or model
  text (the before-state, the body a write sends) follows on one labelled line,
  flattened (control, format and line-separator characters removed), stripped
  of the fence marks and clipped to 200 characters inside `⟦…⟧`. A planted
  "safe, approve" or a fake second action line therefore stays visibly inside
  the quote (CC-5238, CC-5239).
  `jira_add_remote_link` accepts any https URL, so a steered write can carry
  data out in the URL itself.

### Project scope and profile lock
- **`JIRA_PROJECTS` (D400) confines every tool call to a list of project
  keys.** Search JQL is rewritten to `project in (…) AND (<query>)`, project
  and board lists are filtered, and every issue, project, board, sprint,
  component, version and issue link a request names is resolved to its project
  and refused (`kind=permission`) when outside the list — a write already at
  plan time, so a refused write never yields a `plan_id`. Bulk routes resolve
  their issue lists before anything is sent, a response that still carries an
  out-of-scope issue is refused as a last check, and routes the guard cannot
  place — attachments addressed by id, any unrecognised path — fail closed.
- **Its limits.** It is a server-side guard against an agent wandering, not an
  authorization boundary: the API token's own Jira permissions remain the
  boundary, and anyone who can start the process can change the list. Global
  metadata (fields, priorities, statuses, link types, the caller) and saved
  filters stay unscoped, so a filter's name and JQL from another project are
  still readable. Where the operator controls the Jira permission scheme, a
  dedicated account with access to only those projects is the stronger
  control.
- **`JIRA_LOCK_PROFILE` (default on, O-6) pins the tenant.** Any call that
  passes a per-call `profile` argument is refused (`kind=config`) before a
  request is built, so a model cannot read issue text in one tenant and write
  it into another. Unlocking is a deliberate operator act.

### Local filesystem
Four sinks write tenant data to disk. Each is off until the operator sets its
variable (CONFIGURATION.md); unset, the tools that need it refuse with
`kind=config` before any Jira call, and everything else keeps working. Each
file is created `0600` and none is ever deleted by the server — retention is
the operator's job.

<!-- sinks -->
| Sink | Variable | Holds | Written by | Mode and naming | Retention |
|---|---|---|---|---|---|
| journal | `JIRA_JOURNAL_PATH` | Metadata of every executed write: time, correlation id, tool, argument hash, outcome, HTTP status, issue key. No field values, no JQL (O-8). | every executed write tool | `0600`, append-only JSONL, passed through the redactor | rotated at ~5 MiB to `<journal>.1`, one previous file kept |
| media | `JIRA_MEDIA_DIR` | Attachment bytes exactly as stored in Jira — real tenant documents. | <!-- tools:media -->`jira_download_attachment`<!-- /tools --> | `0600`, opened `wx` (never overwrites), name sanitized from the Jira filename (D49); refused past `JIRA_MEDIA_MAX_BYTES` | until the operator deletes it |
| exports | `JIRA_EXPORT_DIR`, default `<JIRA_MEDIA_DIR>/exports` (created `0700`); never `JIRA_MEDIA_DIR` itself (D531) | One page of issue, comment, changelog, worklog or sprint rows as JSONL — tenant content, redacted for secrets before it is written (D152). | <!-- tools:exports -->`jira_search`, `jira_get_comments`, `jira_get_changelog`, `jira_get_worklogs`, `jira_get_sprint_issues`<!-- /tools --> when called with `output: "file"` | `0600`, opened `wx`, `jira-export-<tool>-<UTC stamp>-<8 hex>.jsonl`; also readable as `jira://exports/{name}`; refused past `JIRA_MEDIA_MAX_BYTES` | until the operator deletes it |
| reports | `JIRA_REPORT_DIR` | A Markdown portfolio report: issue keys, summaries, blockers and duplicate findings across the swept projects (D126). Not passed through the redactor. | <!-- tools:reports -->`jira_portfolio_report`<!-- /tools --> | `0600`, opened `wx`, `portfolio-<UTC stamp>.md` | until the operator deletes it |
<!-- /sinks -->

A test binds this table to the code: the tools in each row are derived from
the tool definitions, and every file-creating call site under `src/` must map
to a row here or to the non-tenant files listed under *Data handling*
(CC-5142, CC-5143). Note that `jira_download_attachment` and
`jira_portfolio_report` are annotated `readOnlyHint: true` — they change
nothing in Jira, but they do write to local disk.

**Exports and downloads are not upload material (D531, SEC-02).** A steered
model that could export a wide search and then upload the file to an issue the
attacker can read would move one call's worth of rows instead of one comment's
worth. Three locks stand in the way:

- Exports live in their own directory. `JIRA_EXPORT_DIR`, or by default the
  `exports/` subdirectory of `JIRA_MEDIA_DIR`; an upload takes a plain
  basename, so it cannot name a file in a subdirectory. Setting
  `JIRA_EXPORT_DIR` to the media directory itself is a startup error
  (`export_dir_is_media_dir`).
- The upload refuses any name shaped like an export
  (`jira-export-….jsonl`), even one a person copied into the media directory.
- The upload refuses a file this process downloaded, matched by device, inode,
  size and modification time. A downloaded attachment goes back out only after
  a person copies it to a new file.

Residual risk: the record of downloaded files lives in memory, so after a
restart an earlier download is uploadable again. A person who copies a file
has, by design, made it theirs. Two paths that differ only through a symlink
or letter case are not recognised as the same directory at startup; the
basename rule still keeps exports out of reach when they sit below the media
directory, but an operator who points `JIRA_EXPORT_DIR` at an alias of
`JIRA_MEDIA_DIR` defeats the first lock.

**Disk use is bounded (D531, SEC-07).** Each output directory, media and
exports separately, has a byte quota, `JIRA_MEDIA_MAX_BYTES` (1 GiB by
default, `0` turns it off). It counts the regular files directly in the
directory and is checked before every write, with writes to one directory run
one at a time so two concurrent downloads cannot both fit and together pass
it. A write that would pass it is refused with `kind=config` and nothing is
written. A file is written in full or removed: short writes are continued, a
write that lands nothing is reported as a full filesystem, and the partial
file is deleted.

The attachment half is bounded as follows. Unset `JIRA_MEDIA_DIR`, the two
byte-moving tools refuse with `kind=config` having made zero Jira calls, while
attachment *metadata* keeps working — it needs no directory (CC-58).

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
  after it (CC-54), so an oversized body is never buffered whole. An upload
  reads at most the size `fstat` reported plus one byte, so a file that grows
  while it is read is refused instead of being read past the cap. A download
  with a usable `Content-Length` is collected in one preallocated buffer, so
  it is held in memory once rather than twice (TSN-14).

### Transport
- stdio: console guard; protocol on stdout, diagnostics on stderr.
- HTTP (D101): loopback bind by default (CC-115); `JIRA_HTTP_BIND` can move
  the socket to another IP literal for a container, with a startup warning
  and a doctor warning, and moves only the socket — the `Host` and `Origin`
  checks stay loopback, so the one supported container publish is
  `-p 127.0.0.1:<port>:<port>` (D532); fails closed without
  `JIRA_HTTP_TOKEN` — twice, in settings (CC-30) and again in the transport —
  and the same way on a token under 32 characters (D532);
  constant-time `timingSafeEqual` bearer comparison on every request (CC-114);
  `Host` checked against the bound loopback authority and `Origin`, when
  present, against loopback origins before any JSON-RPC is processed (CC-116);
  one session per `Mcp-Session-Id`, whose teardown takes its armed plans with
  it (CC-117), and bound to a digest of the bearer that opened it, so a
  request naming it with any other bearer is answered as if it did not exist
  (D532); one plan store for all sessions, each plan bound to the
  session and to a SHA-256 fingerprint of the bearer that planned it, so
  another session or credential is refused without burning the plan, with
  128-bit CSPRNG plan ids, a 60-minute TTL and a per-session quota that one
  session cannot use to evict another's plans (D511–D514); a POST body read under a 4 MiB cap, after the bearer check, so
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
  plan/apply gate above is **not** a hard control against a text-driven write:
  `JIRA_WRITE_MODE=plan` refuses every apply, but in `apply` mode the steered
  model plans the write and spends its own `plan_id` (§Write safety, "What
  plan/apply is not"). What holds there is the irreversible tier's operator
  gates, `JIRA_PROJECTS`, the client's per-tool approval and the token's Jira
  permissions.
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
- **Prompts, completions and export resources add no new channel.** Prompt
  texts (D125, D153) are server-authored; their arguments are pinned by
  pattern or length, and every text carries the read-only rule, so no prompt
  asks for a write. Completions (D154) answer from closed sets the server
  already holds — declared prompt values and manifest tool names — and, for a
  `project` argument, from project keys (D551): one read of the projects the
  default profile already sees, cached per process for
  `JIRA_META_CACHE_TTL_S`, or the `JIRA_PROJECTS` keys with no call at all.
  The credential is process-wide, so the cache shares nothing a session could
  not read itself; only keys the argument's pattern accepts are offered. The
  `jira://exports/{name}` resource reads only names matching
  the export pattern, so it is never a general reader over the export directory;
  what it returns is the same redacted rows the export wrote, and they are as
  untrusted as the read that produced them.
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
- `npm audit --omit=dev` through `scripts/audit-gate.mjs` inside `npm run check`
  and as its own CI job, failing on high/critical unless an expiring,
  reviewed `audit-allowlist.json` entry covers it (D546); lockfile
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
  and logs outside this server's control. Server-side, tenant data lands in
  the four sinks of §Local filesystem — the write journal (metadata only,
  O-8), attachment downloads, file exports and portfolio reports — each off
  until its variable is set, each `0600`, none deleted by the server. In
  oauth mode the token store is one more file the server writes, but it holds
  credentials and a site identifier, never tenant content. The only cache is
  the in-memory
  metadata cache (D123): field, status, link-type and create-meta catalogues,
  keyed by profile, bounded, never written to disk, gone with the process. The only
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
