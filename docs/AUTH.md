# Authentication

> Status: normative and implemented — this document and the code ship together;
> drift is a bug. This document owns the **credential lifecycle** and the
> **doctor ops contract**.

## Two modes

`JIRA_AUTH_MODE` (CONFIGURATION.md) selects where the credential comes from:

| Mode | Credential | Requests go to |
|---|---|---|
| `basic` (default) | `JIRA_EMAIL` + `JIRA_API_TOKEN` | the site host |
| `oauth` | a bearer access token minted by `jira-mcp-ai login` and refreshed in-process | the `api.atlassian.com` gateway (mandatory — JIRA-API.md) |

Both modes serve the same tool surface. Nothing about a tool's arguments,
results, write gate or error kinds changes with the mode; what changes is the
`Authorization` header, the origin, and a path prefix. That is deliberate — the
credential union is a discriminated type resolved once per call (D92), not a
branch threaded through the API layer.

**Basic is still the recommended mode.** It is one variable pair, it has no
refresh clock, no browser step, and no registration in a developer console.
Choose `oauth` when the org has disabled API tokens, or when you specifically
want a grant that is scoped rather than one that inherits the whole account
(D91).

## Basic auth with an API token (default mode)

- Header: `Authorization: Basic base64(JIRA_EMAIL + ":" + JIRA_API_TOKEN)`.
- Token creation: https://id.atlassian.com/manage-profile/security/api-tokens —
  tokens created after 2024 have mandatory expiry (max 1 year); the doctor
  subcommand surfaces auth failures with a renewal reminder. Optional
  `JIRA_TOKEN_EXPIRES` (ISO date) lets doctor and the startup report warn when
  the horizon drops under 30 days — a cron/CI deployment otherwise discovers
  expiry as a hard 401 at 3 a.m.
- The token inherits the user's permissions — the server can never do more than
  the human account can. This is a feature (no privilege escalation) and a
  documentation duty (permission errors often masquerade as 404, see JIRA-API.md).
- Scoped API tokens (Atlassian's newer granular-scope tokens) work identically
  over Basic auth; if used, `read:jira-work` + `write:jira-work` (+
  `read:jira-user`) cover the v1 surface. Doctor reports 401/403 per probe so a
  missing scope is visible immediately.

## OAuth 2.0 (3LO)

Everything in this section derives from Atlassian's published 3LO documentation.
Where that documentation is silent, this section says so instead of guessing —
see **What this section does not know** at the end. Endpoint URLs, the gateway
pattern and the wire-level error table live in JIRA-API.md, which owns them.

### Registering the app — and the tension in doing so

You register your own 3LO app in the Atlassian developer console and supply its
credentials as `JIRA_OAUTH_CLIENT_ID` and `JIRA_OAUTH_CLIENT_SECRET`
(CONFIGURATION.md). Both are required in oauth mode; a missing secret is a
configuration error at startup, not a field you may leave blank.

**This server is a confidential client, and PKCE does not change that** (D98).
Atlassian's 3LO documentation never mentions PKCE at all, `client_secret` is
documented `(required)` on both the code exchange and every refresh, and the
tenant's OpenID configuration advertises only `client_secret_basic` and
`client_secret_post` as token-endpoint auth methods — `none`, the public-client
method, is absent. Atlassian staff have confirmed that only the authorization
code flow is supported (feature request ECO-283). We still send
`code_challenge`/`code_challenge_method=S256` on the authorize request and
`code_verifier` on the exchange, because S256 is advertised as supported and it
hardens the callback leg; it is defence in depth, never a substitute for the
secret. Any claim that this server can run without a client secret is wrong.

The tension, stated plainly rather than glossed: the 3LO page now carries a
policy banner reading *"Apps that collect API tokens or instruct customers to
create individual 3LO apps don't comply with our Security requirements for cloud
apps and Acceptable use policy."* That warning is aimed at distributed
Marketplace apps that push their own users into creating apps. This server is
self-hosted software run by the owner of the credentials, and it has no other
option: there is no public-client mode to fall back on, and shipping a shared
client secret inside an npm package would be strictly worse — a secret in a
tarball is not a secret. You are registering an app for yourself, not being
instructed to register one on someone else's behalf. If your organisation reads
the banner as covering this case too, the answer is `basic` mode, not a
workaround.

### The redirect URI is the unverified part of this feature

The **only** normative statement in Atlassian's corpus about the callback is
*"Set this to any URL that is accessible by the app"*, plus the requirement that
`redirect_uri` match it exactly. The documentation says **nothing** about
loopback addresses, `127.0.0.1` versus `localhost`, plain http versus https,
wildcard ports, or whether an app may register more than one callback URL.

This server uses a fixed loopback callback,
`http://127.0.0.1:<JIRA_OAUTH_REDIRECT_PORT>/callback` (D99) — an IP literal
rather than the name `localhost`, so a dual-stack box cannot resolve the browser
to `::1` while the listener sits on IPv4, and a configured port rather than an
ephemeral one, because the registered URL and the listener must agree
character for character.

> **UNVERIFIED — confirm this first.** Nothing in the documentation promises
> that a plain-http loopback callback can be registered at all. The only
> evidence is a community report that the console's Save button greys out for
> http URLs yet accepts `http://localhost:<port>/…`, with no Atlassian staff
> answer, alongside other reports that an app may hold only one callback URL.
> **Before configuring anything else, paste the callback URL into the developer
> console by hand and confirm it saves.** If it does not, this feature does not
> work for you today, and we would rather you learn that in one minute than
> after a full setup.

### Scopes

Scopes are requested at authorize time from the set you added to the app in the
console. Two facts shape the default list:

- Atlassian recommends **classic** scopes ("use granular scopes only when you
  can't use classic scopes"), and
- **Jira Software supports no classic scopes at all** — boards, sprints and
  ranking force granular ones.

So any working deployment needs a *mixed* set. The exact default string is in
CONFIGURATION.md (`JIRA_OAUTH_SCOPES`), which owns it; what follows is the
mapping from this server's tool families onto it. `offline_access` is not a Jira
scope and appears on neither scopes page — it is documented only in the 3LO and
refresh-token prose, and without it no refresh token is issued and the session
dies at the first expiry.

| Tool family | Scope | In the default set |
|---|---|---|
| Platform reads — search, count, issue, comments, transitions list, changelog, worklogs, attachment metadata and download, projects, components and versions lists, field/status/link-type/createmeta metadata, saved filters | `read:jira-work` | yes |
| Platform writes — create/update issue, transition, add/edit comment, assign, add worklog, link issues, upload attachment, watchers, votes | `write:jira-work` | yes |
| Irreversible tier — delete issue, delete comment, delete worklog | `write:jira-work` (its published description names issue deletion) | yes |
| Users — user search, `myself` | `read:jira-user` | yes |
| Project configuration — create/update component, create/update version, project roles | `manage:jira-project` ("Project settings, versions, components") | yes |
| Irreversible tier (D102) — delete component, delete version | `manage:jira-project` (inferred — its published description names versions and components but does not say *delete*; the finding-1 rule applies: already in the default, and a 403 here is a documentation bug to file, not a configuration problem) | yes |
| Irreversible tier (D102) — delete sprint | `delete:sprint:jira-software` | **no** — see finding 5 |
| Boards — board listing | `read:board-scope:jira-software` | yes |
| Sprint reads — sprint listing, sprint issues | `read:sprint:jira-software`, plus `read:issue:jira-software` for the issue payloads | yes |
| Sprint writes — move issue to sprint, start sprint, close sprint | `write:sprint:jira-software` ("Update sprints, move issues to sprints, and update the order of sprints") | yes |
| Ranking and estimation on agile endpoints | `write:issue:jira-software` ("Rank and estimate issues") | yes |
| Create sprint | see finding 2 | — |
| Move issue to backlog | `write:board-scope:jira-software` (inferred — see finding 1) | yes |
| `jira_capabilities` | none — it makes no HTTP call | n/a |

Verified against the full tool inventory (TOOLS.md owns the counts). The mapping
is exhaustive over the surface; five things came out of doing it, and they are
findings, not formatting:

1. **An inferred scope.** `jira_move_to_backlog` posts to the Agile backlog
   endpoint, and no scope in Atlassian's published Jira Software list obviously
   covers it. The only plausible candidate is `write:board-scope:jira-software`,
   so it **is** in the default set — but on inference, not on documentation:
   Atlassian publishes no scope-to-endpoint map for the Agile API, and we will
   not assert one. It is included rather than left out for the same reason
   finding 3 keeps the surplus epic scopes: widening the list later forces every
   user to re-consent, so an unneeded scope costs consent breadth once while a
   missing one costs a second login for everybody. If backlog moves still fail
   with 403 under 3LO, this inference was wrong — that is a documentation bug to
   file here, not a configuration problem to work around.
2. **A probable gap.** `jira_create_sprint` posts a new sprint. The published
   description of `write:sprint:jira-software` covers updating sprints, moving
   issues into them and reordering them — it does not say *create*. It may well
   be the right scope; the documentation does not say so, so treat sprint
   creation as the second thing to test after a first login.
3. **Surplus.** `read:epic:jira-software` and `write:epic:jira-software` cover no
   endpoint this server calls — there is no epic tool and nothing touches an
   epic route. They stay in the default anyway, because widening scopes later
   forces every user to re-consent, and paying that once at first login is
   cheaper than paying it on an upgrade.
4. **The classic descriptions are coarse.** Atlassian's one-line summaries of
   `read:jira-work`/`write:jira-work` do not enumerate saved filters, field and
   status metadata, createmeta, watchers, votes, issue links, comment editing or
   worklog deletion. We map them there because that is where they plainly
   belong, not because a document says so. A 403 on one of those is a scope
   question, not necessarily a bug.
5. **Two deliberate exclusions.** `manage:jira-configuration` is global admin and
   nothing here needs it — no tool touches a permission scheme, workflow, screen,
   application role, group or site configuration. `delete:sprint:jira-software`
   was originally excluded for a simpler reason than "irreversible tier": this
   server shipped no sprint-delete tool at all, so there was nothing for it to
   authorise. Since D102 the tool exists, and the scope **stays out of the
   default anyway** — this is finding 3's economics running the other way:
   widening a consented list forces every existing user to re-login, and a
   scope whose only use is the rarest, most-gated write in the catalog does not
   earn that. Under the default scopes an oauth-mode `jira_delete_sprint` apply
   is a scope refusal from Jira; an operator who wants it adds
   `delete:sprint:jira-software` to `JIRA_OAUTH_SCOPES` and runs `login` again
   to re-consent.

One cross-family dependency arrived with D100: `resolveMentions: true` on the
issues-write family runs user search before it writes, so those calls need
`read:jira-user` in addition to `write:jira-work` — the same scope
`jira_search_users` needs, and already in the default set. Under a narrowed
scope list, a 403 on a mention-resolving write is this read dependency, not a
write-scope problem.

Two rules that catch people out:

- **A scope is a ceiling, not a grant.** "The permissions held by the user an app
  is acting for always constrain the app, regardless of the app's scopes." A
  green scope list does not mean a tool will work; it means it is not the scope
  that stopped it.
- **Changing scopes forces re-consent.** Users who previously consented must
  consent again when an app's scopes change, so editing `JIRA_OAUTH_SCOPES`
  after a successful login means running `jira-mcp-ai login` again.

### The login flow, end to end

`jira-mcp-ai login [--profile NAME] [--site SITE] [--cloud-id ID]
[--no-browser] [--json] [--timeout SECONDS]`

1. Settings load and validate: oauth mode, client id, client secret, scopes,
   redirect port. A missing required field fails here with exit code `2`, before
   anything is opened or listened on.
2. A `code_verifier`/`code_challenge` pair and a `state` nonce are generated from
   `node:crypto`, injected as a seam — never from the pseudo-random `Rng`, which
   this codebase documents as explicitly not a security primitive (D96).
3. A loopback HTTP server binds `127.0.0.1` only, on the configured port, and is
   torn down in a `finally` — including on the failure paths (CC-104).
4. The authorize URL is built and the browser is opened best-effort. A failure to
   open a browser degrades to printing the URL, never to an error; `--no-browser`
   always prints. A non-TTY run refuses up front rather than hanging: an OAuth
   login waiting for a browser inside a cron job is the failure mode this rule
   exists to prevent.
5. The callback arrives. `state` is compared in constant time and a mismatch
   aborts **before** any exchange (CC-97); a request with no `code` is rejected
   (CC-104).
6. The code is exchanged for tokens. Access token, refresh token and granted
   scopes are registered with the redactor the instant they exist.
7. Accessible resources are fetched with the fresh token and a site is selected —
   `--cloud-id` pins it, `--site` matches on URL or name; when a flag is absent
   the environment stands in (`JIRA_OAUTH_CLOUD_ID`, then the site of the
   profile being logged in: `JIRA_PROFILE_<NAME>_SITE` under `--profile`, else
   `JIRA_SITE`, CC-166). With nothing to match on, a single result is used and
   several are an ambiguity error that lists the candidates (CC-103); a pin that
   matches none of them is a `config` error listing what the grant does cover.
8. The store is written, and the site, cloudId, granted scopes and store path are
   printed. **No token is ever printed**, in any mode, including `--json`.

Exit codes match the rest of the CLI: `0` success, `1` the flow failed, `2` usage
or configuration error.

### The gateway

Under 3LO, requests do not go to your site host. Atlassian is explicit:
requests made with OAuth 2.0 (3LO) are made via `api.atlassian.com`, not
`https://your-domain.atlassian.net`. A bearer token against the site host is not
a supported path, so the gateway is **mandatory** rather than an optimisation —
JIRA-API.md carries the URL pattern.

This is why the resolved host in oauth mode carries a path prefix as well as an
origin: every tool's endpoint path is unchanged, and the prefix is prepended by
the host layer. It is also why a cloudId is validated before a URL is ever built
(CC-101) — a cloudId is a path segment, and an unvalidated one is a
path-injection primitive, not a cosmetic issue.

The cloudId is discovered per login from the accessible-resources endpoint;
`JIRA_OAUTH_CLOUD_ID` **pins** it rather than caching it. At call time the pin is
a check, not an override (CC-165). The stored refresh token was granted for the
cloudId recorded with it, so a pin that names a different site is a `config`
error before any request is sent. The fix is to re-run `login` or unset the pin.
Two properties of that endpoint are load-bearing:

- **`id` is not unique across containers** — two entries may share one — so site
  selection matches on URL or name and never treats `id` as a primary key.
- **It says nothing about permissions.** A site appearing in the list is not a
  promise that any tool will work against it, and neither `login` nor `doctor`
  claims otherwise.

Grant type matters too: an account-level grant can return many sites, while a
site-restricted grant returns only the sites it covers, and a token from such a
grant cannot be used with a site outside that list.

### Token storage

Tokens live in a dedicated store, `<config dir>/oauth.json` by default and
overridable with `JIRA_OAUTH_TOKEN_FILE` — not in the env file (D95). The env
file is edited by humans and read at startup; this file is rewritten by the
process on every refresh, and mixing the two would mean a background rotation
silently rewriting a file someone has open in an editor. A keychain was rejected
for the same reason it usually is: a native dependency plus no story for a
headless server.

- One file, keyed by profile, so several profiles can hold separate grants.
- Mode `0600`, written atomically, under the same cross-process lock the env
  writer uses. Doctor reports the mode; a loose mode is a finding, because the
  refresh token in this file is the durable credential — see THREAT-MODEL.md.
- Every token read out of it is registered with the redactor before use.

### Refresh and rotation

Refresh is **proactive**. The resolver refreshes when the access token is inside
a skew window before its expiry (`TOKEN_REFRESH_SKEW_MS`, two minutes), rather
than waiting for a 401. A 401 from Jira never triggers an automatic
refresh-and-replay of a write; only a replayable request is retried at all, and
a token POST is never replayed under any circumstance (D94) — a replayed refresh
is indistinguishable from a stolen-token replay, and burning a rotating refresh
token logs the operator out.

Rotation is the part that has to be got right:

- **Every new refresh token invalidates the one used to obtain it.** The store
  is therefore written *before* the new access token is used, and a failed write
  fails the refresh (CC-99). A rotated token held only in memory is a logout on
  the next restart.
- **Concurrent calls perform exactly one refresh** (CC-98): single-flight
  in-process, plus a cross-process lock with a re-read inside it, so a second
  process that refreshed first wins and this one adopts its token instead of
  burning it.
- Atlassian documents a **10-minute reuse interval** during which breach
  detection does not apply to repeated exchanges. That is the safety net for the
  crash-between-refresh-and-persist window. It is not a licence to race.
- The refresh token expires after **90 days of inactivity**, a rolling window
  that each successful rotation resets.

When a refresh fails terminally — a 400 or 403 whose `error` is one of
`invalid_grant`, `unauthorized_client` or `invalid_client` — the result is an
`auth` error whose remediation is to run `jira-mcp-ai login` again, never a retry
loop (CC-100). The usual causes are documented: the user changed their Atlassian
password, the refresh token expired, or the app failed to replace the previous
refresh token with the rotated one.

### `logout` deletes local tokens — it does not revoke them

`jira-mcp-ai logout [--profile NAME] [--all]` removes the stored tokens for a
profile, or every profile with `--all`. That is the whole of it.

**It does not revoke anything server-side.** Atlassian's OpenID configuration
advertises a revocation endpoint, but it appears nowhere in the 3LO
documentation, so this server does not call it and does not pretend to. Until
the refresh token's inactivity window elapses or the grant is removed by hand,
a copy of that token taken before logout still works. Revoking access properly
means removing the app's authorisation from the Atlassian account, or rotating
the app's client secret in the developer console — do that if you believe the
token file was exposed, and treat local deletion as housekeeping, not as
containment (THREAT-MODEL.md).

### What this section does not know

Stated as unknowns on purpose; none of these has a documented answer, and this
repo does not fill documentation gaps with folklore.

- **The access-token lifetime is NOT DOCUMENTED.** No number appears anywhere in
  Atlassian's 3LO pages — the familiar "one hour" is community lore. The
  reported `expires_in` is read at runtime and never hardcoded.
- **An absolute refresh-token expiry is NOT DOCUMENTED.** Only the rolling
  90-day inactivity window is published; do not assume a hard cap behind it.
- **`token_type` never appears in any documented response**, although `Bearer` is
  used throughout. It is neither required nor switched on.
- **Whether PKCE alone would work is unverified** and assumed not — `none` is not
  an advertised token-endpoint auth method.
- **Every redirect-URI specific beyond "any URL accessible by the app" is a
  community claim**, including loopback, plain http, wildcards and multiple
  callback URLs. See the warning above.
- **Rate limits on the auth host are NOT DOCUMENTED** (JIRA-API.md).

## Credential storage

- Preferred: env vars set by the MCP client config (Claude Code `.mcp.json`).
- Alternative: `~/.config/jira-mcp-ai/.env`, written atomically 0600 by
  `doctor --save` (prompts) — never hand-edited instructions in README.
- The token value is registered with the redactor at load; it can never appear
  in logs, errors, or tool results.
- In oauth mode the API token is replaced, not supplemented: the durable
  credential is the refresh token in the token store described above, written by
  `login` and rewritten by every rotation. The env file holds the client id and
  secret; it never holds a token.

## Multi-account

Named profiles (`JIRA_PROFILE_WORK_SITE=…`, `JIRA_ACTIVE_PROFILE=work`) allow
several sites/accounts; tools accept an optional `profile` argument unless
`JIRA_LOCK_PROFILE` is set. Follows the servicenow-mcp AsyncLocalStorage design.

**v1 default: locked** (O-6). A process serves one profile; per-call switching
requires unsetting `JIRA_LOCK_PROFILE` deliberately. Rationale: a model that
can pick the tenant per call can also leak an issue from tenant A into a
summary about tenant B, and the audit story ("which site did that write hit?")
gets much harder — one server per site is the cheap alternative.

**Secret registration is exhaustive at startup**: every credential in the
environment is registered with the redactor before anything can log — the
active profile's token, the tokens of **inactive** profiles, and
`JIRA_HTTP_TOKEN`. A secret that is merely present but unused is still a
secret that must never appear in a transcript.

Under oauth the token store is keyed by profile too, so `login --profile work`
and `login --profile personal` hold independent grants in one file. The grants
need not point at the same site, and nothing correlates them: each carries its
own cloudId and its own scope list.

## Doctor (CLI `jira-mcp-ai doctor`) — ops contract

Probes, in order (ALL run — no short-circuit on first failure, so one run
shows the complete picture):

1. settings load + report (missing/malformed vars);
2. host resolution + allowlist verdict;
3. env-file permissions (0600) when an env file is in use;
4. `GET /myself` → identity, accountId, timezone;
5. `GET /serverInfo` → deployment type sanity (warns if not Cloud);
6. one-page `search/jql` probe (`jql: "created >= \"1970-01-01\" order by
   created desc"`, maxResults 1) — verifies search permission and the
   new-endpoint availability. The date clause is a restriction Jira requires,
   not a filter: a query that restricts nothing is refused with HTTP 400
   "Unbounded JQL queries are not allowed here" on sites past a size Atlassian
   does not publish (D88);
7. agile root probe (`GET /rest/agile/1.0/board`, maxResults 1) — the Agile API
   is a separate root with its own permission surface; a green platform probe
   does not imply it;
8. journal-write probe when `JIRA_JOURNAL_PATH` is set (open/append check);
9. token-expiry horizon — `JIRA_TOKEN_EXPIRES` in basic mode (warn ≤ 30 days);
   in oauth mode the OAuth horizon is reported instead;
10. write-mode + package gating summary;
11. oauth token store — local, and therefore included under `--offline`: auth
    mode, whether a client id is configured, the store path and its file mode,
    the cloudId, the access-token horizon, and whether a refresh token is
    present. Nothing is printed that could reconstruct a token.

(D84 widened the probe list when it numbered ten; probe 11 arrives with Phase 8,
D91. The ledger row is history and stays as written — this list is the
normative one.)

Contract (D11 in DECISIONS.md):

- Human report on **stdout** — doctor is a CLI run, not an MCP session;
  structured log events stay on stderr.
- Exit codes: `0` all probes green (warnings allowed), `1` at least one probe
  failed, `2` usage/config error prevented probing at all.
- `--json`: single machine-readable report object on stdout (for CI/cron).
- `--offline`: local probes only (1–3, 8–11) — no network; pairs with startup's
  offline-only rule (OBSERVABILITY.md).
- Prompts (`doctor --save`) only on a TTY; non-interactive runs fail with a
  message instead of hanging. `--save` writes the three top-level variables,
  so it refuses in oauth mode and under an active profile that overrides any
  of them (CC-212).

## Still not supported (see ROADMAP.md)

- **Data Center PATs**: `Authorization: Bearer <pat>`, host via
  `JIRA_ALLOWED_HOSTS`, API version differences (v2 endpoints, no ADF —
  wiki-markup) make this a genuinely separate adapter, not just an auth switch.
  Parked by D104 and **un-parked in stages by D106**; nothing of it is
  reachable yet, and PAT auth is stage 13.2 (IMPLEMENTATION-PLAN.md). Note
  what OAuth changed and what it did not: the bearer *header* is now free —
  `authorizationHeader` switches on `kind` and the `bearer` arm ships — so the
  auth half of a DC build is a resolver, and the branch that picks a resolver by
  `authMode` already exists. Everything the sentence above calls "genuinely
  separate" survives that unchanged.
