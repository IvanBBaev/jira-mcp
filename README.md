# jira-mcp-ai

**The Jira MCP server that cannot do what you did not approve.**

Every write is a plan first. Scope is enforced on every call, not just hidden
from the menu. Bulk edits, ranks and sprints, on your machine, with your own
token.

An [MCP](https://modelcontextprotocol.io) server for **Jira Cloud**: it gives an
MCP-capable agent (Claude Code, Claude Desktop, or any other client) tools to
search, read and — behind an explicit gate — write Jira issues, using your own
Atlassian account: an API token, or OAuth 2.0 (3LO) through `jira-mcp-ai login`
([`docs/AUTH.md`](docs/AUTH.md)).

What "cannot" means here, concretely:

- **A write is a plan until you apply it.** Every write tool first answers with
  the request it *would* send and a `plan_id`; nothing reaches Jira. Executing
  takes `JIRA_WRITE_MODE=apply` in the configuration *and* `apply: true` with
  that `plan_id` on the call. From <!-- version:next -->1.1.0<!-- /version -->
  an issue-write plan also shows a field-by-field diff, and the apply is
  refused if the issue changed since the plan.
- **Out of scope is refused before anything is sent.** With
  `JIRA_PROJECTS=SCRATCH`, a call that names `LEGACY-1` fails at call time with
  "Nothing was sent to Jira", and searches are narrowed to the listed projects
  (<!-- version:next -->1.1.0<!-- /version -->, unreleased).
- **Irreversible writes need a human.** Deletes and bulk edits refuse unless
  `JIRA_ALLOW_IRREVERSIBLE` is set, even in apply mode. With
  `JIRA_IRREVERSIBLE_CONFIRM=elicit` (<!-- version:next -->1.1.0<!-- /version -->)
  each such apply also asks you through an MCP form that the model cannot
  answer for you.

Jira content is untrusted input as well: issue text arrives from whoever filed
the ticket, and it is labelled as data, never merged into the agent's
instructions. See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

### The demo

Recorded against the offline fake Jira (`scripts/fake-jira.mjs`) with
`JIRA_PROJECTS=SCRATCH` and `JIRA_WRITE_MODE=apply`. The "you" lines are
scripted; every other line is the server's real answer:

```text
you › Move SCRATCH-1 to Done and log the 2h I spent.
▸ jira_transition_issue — plan
  would POST /issue/SCRATCH-1/transitions   status In Progress → Done
▸ jira_add_worklog — plan   2h
  NOT performed — plan mode. Nothing was sent to Jira.

you › Close LEGACY-1 too while you are at it.
▸ jira_transition_issue LEGACY-1 — refused (permission)
  Issue "LEGACY-1" (project LEGACY) is outside the project scope of this
  server (JIRA_PROJECTS: SCRATCH). Nothing was sent to Jira.

you › The SCRATCH-1 plans look right. Apply them.
▸ jira_transition_issue — apply   ok   SCRATCH-1 → Done
▸ jira_add_worklog — apply   ok   2h logged
▸ jira_get_issue — read   status Done
```

To reproduce it, or to render it as a GIF (needs
[`agg`](https://github.com/asciinema/agg) on `PATH`):

```sh
npm run build
node scripts/record-demo.mjs                              # transcript
node scripts/record-demo.mjs --gif docs/assets/demo.gif   # GIF
```

The script fails instead of recording if a plan executes, if any write reaches
the fake before the apply, or if anything about `LEGACY-1` reaches it at all.

> **Status: latest release <!-- version:released -->1.0.0<!-- /version -->; this
> branch is `main`.** The specification in [`docs/`](docs/README.md) is
> normative and the code ships with it; drift is a bug. `jira-mcp-ai` is on npm
> with provenance, so the quick start below resolves as written, and
> the tool surface follows semver.
>
> - **Released (npm):** <!-- count:tools@released -->58<!-- /count --> tools in
>   <!-- count:packages@released -->10<!-- /count --> packages.
>   <!-- count:live -->40<!-- /count --> of them have been run against a real
>   Jira site; the remaining <!-- count:unproven@released -->18<!-- /count --> —
>   mostly permission-gated, irreversible and bulk writes — are verified
>   offline only.
> - **On `main`, not yet released:** <!-- count:tools -->82<!-- /count --> tools
>   in <!-- count:packages -->11<!-- /count --> packages. The
>   <!-- count:unreleased -->24<!-- /count --> newer ones are marked
>   *<!-- version:next -->1.1.0<!-- /version --> (unreleased)* in the
>   [tool list](#tools) and ship with the next release.
>
> See [the implementation plan](docs/IMPLEMENTATION-PLAN.md) and
> [`CHANGELOG.md`](CHANGELOG.md).

## When to use which

As of **2026-10-29**. The Atlassian column is taken from Atlassian's
[Rovo MCP supported-tools page](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/)
(updated 2026-10-27). The `sooperset/mcp-atlassian` column is taken from its
repository and the
[CVE-2026-77243 advisory](https://app.opencve.io/cve/CVE-2026-77243).
A cell marked *not verified* is one we could not confirm from a primary
source; corrections are welcome. The jira-mcp-ai column describes `main`
(<!-- version:next -->1.1.0<!-- /version -->, unreleased).

| | **jira-mcp-ai** | **Atlassian Rovo MCP server** | **sooperset/mcp-atlassian** |
|---|---|---|---|
| Where it runs | Your machine (stdio, or HTTP on loopback) | Hosted by Atlassian | Your machine or Docker, stdio or HTTP |
| Org-admin action needed | No | Yes, for API-token auth and the delete/manage tool groups | No |
| Confluence | No (by design) | Yes | Yes |
| Preview before every write | Yes (plan, then apply) | Only for screen updates and hierarchy conversion | *not verified* |
| Human confirmation the model cannot give | Yes, opt-in (MCP elicitation) | Agent-level confirmation for destructive tools; mechanism not documented | *not verified* |
| Project allow-list enforced at call time | Yes (`JIRA_PROJECTS`) | No allow-list; Atlassian permissions and admin tool groups | `JIRA_PROJECTS_FILTER`; call-time enforcement since 0.22.0 (CVE-2026-77243; listing only before) |
| Bulk edit / delete (up to 1000 issues) | Yes | No | *not verified* |
| Rank issues; create and update filters | Yes; yes | No; list filters only | *not verified* |
| Sprint lifecycle | Yes | Yes (since 2026-08-29) | *not verified* |
| Audit log, IP allow-list | No (local stderr logs only) | Yes (Atlassian Administration) | No |
| Jira Data Center | Unverified preview | No | Yes |
| Licence | GPL-3.0-only | Proprietary service | MIT (*not verified*) |

**In short.** Use the Rovo server if you want Jira and Confluence hosted by
Atlassian, with its audit logs and IP allow-listing. Use `sooperset/mcp-atlassian`
if you want Jira and Confluence together, including on Data Center. Use
**jira-mcp-ai** if an agent will *write* to your Jira and you need it unable to
touch the wrong project, to bulk-edit without a preview, or to delete without a
human saying yes, without asking your org admin for anything.

## Requirements

- Node.js ≥ 22 (env files are read with `process.loadEnvFile()`, not dotenv)
- A Jira Cloud site and an Atlassian API token (or, with `JIRA_AUTH_MODE=oauth`,
  an OAuth 2.0 app of your own — see [`docs/AUTH.md`](docs/AUTH.md))

## Quick start

**1. Mint an API token** in your
[Atlassian profile](https://id.atlassian.com/manage-profile/security/api-tokens)
(*Security → API tokens*). It inherits exactly your Jira permissions.

**2. Save and check the credentials** — once per machine, in a terminal:

```sh
npx -y jira-mcp-ai@1.0.0 doctor --save   # prompts for site, email and token
npx -y jira-mcp-ai@1.0.0 doctor          # probes them against your site
```

`--save` writes `~/.config/jira-mcp-ai/.env` with mode `0600`, and the server
reads it at every start. That keeps the token out of every client config below:
**never put the token in a file inside a repository** (`.mcp.json`,
`.cursor/mcp.json`, `.vscode/mcp.json`).

**3. Register the server** with your client:

- **Claude Code, plugin** — prompts for the credentials and keeps the token in
  secure storage, so step 2 is optional:
  `/plugin marketplace add IvanBBaev/jira-mcp`, then
  `/plugin install jira-mcp-ai@jira-mcp-ai`.
- **Claude Code, CLI** — user scope, outside the repository:

  ```sh
  claude mcp add --scope user jira -e JIRA_WRITE_MODE=plan -- npx -y jira-mcp-ai@1.0.0
  ```

- **Cursor** —
  [Add to Cursor](https://cursor.com/en/install-mcp?name=jira&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImppcmEtbWNwLWFpQDEuMC4wIl0sImVudiI6eyJKSVJBX1dSSVRFX01PREUiOiJwbGFuIn19).
- **VS Code** —
  [Install in VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=jira&config=%7B%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22jira-mcp-ai%401.0.0%22%5D%2C%22env%22%3A%7B%22JIRA_WRITE_MODE%22%3A%22plan%22%7D%7D).
- **Claude Desktop** — add this to `claude_desktop_config.json` and restart:

  ```json
  {
    "mcpServers": {
      "jira": {
        "command": "npx",
        "args": ["-y", "jira-mcp-ai@1.0.0"],
        "env": { "JIRA_WRITE_MODE": "plan" }
      }
    }
  }
  ```

Config file paths per OS, the JSON forms for every client, why the version is
pinned, and what to do when the client shows no server (almost always PATH) are
in [`docs/CONFIGURATION.md` §Registering with a client](docs/CONFIGURATION.md#registering-with-a-client).
`login` and `logout` (the OAuth flow), `--help` and `--version` are also
available.

**Try it.** Ask the agent: *"What is on my plate this sprint?"* — a read-only
search. Then ask it to comment on one of those issues: in the default `plan`
mode it shows the comment it would post and posts nothing.

### Docker

No image is published yet, so build it from a checkout. The image runs the
same files as the npm package, on Node 24, as the unprivileged `node` user:

```sh
git clone https://github.com/IvanBBaev/jira-mcp.git && cd jira-mcp
docker build -t jira-mcp-ai .
```

**stdio** (the default) — the client starts the container itself. Pass the
credentials with `--env-file` (the file `doctor --save` writes works as is,
unless a value needed quoting), so the token stays out of the client config:

```sh
claude mcp add --scope user jira -- \
  docker run -i --rm --env-file ~/.config/jira-mcp-ai/.env \
  -e JIRA_WRITE_MODE=plan jira-mcp-ai
```

**http** — one long-running container that clients connect to. Inside a
container the server must listen on `0.0.0.0`, so publish the port to the
host's loopback only, with the same port on both sides; the `Host` and `Origin`
checks stay loopback either way. Expect the `http_bind_not_loopback` warning
at startup: it describes the bind inside the container, not what the host
exposes.

```sh
export JIRA_HTTP_TOKEN="$(openssl rand -hex 32)"   # keep it: clients need it
docker run -d --name jira-mcp --env-file ~/.config/jira-mcp-ai/.env \
  -e JIRA_TRANSPORT=http -e JIRA_HTTP_BIND=0.0.0.0 -e JIRA_HTTP_TOKEN \
  -p 127.0.0.1:3334:3334 jira-mcp-ai
```

`JIRA_HTTP_TOKEN` must be at least 32 characters; clients send it as
`Authorization: Bearer <token>`. File output (`JIRA_MEDIA_DIR`,
`JIRA_REPORT_DIR`) needs a mounted volume writable by uid 1000. See
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for both transports.

## Configuration

Every setting is an environment variable with the `JIRA_` prefix. The full table
— names, defaults, required-ness, and where credentials may live — is in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md); [`.env.example`](.env.example)
is a fill-in-the-blanks copy.

### Choosing a surface

Every listed tool costs context. A client without tool search pays that cost
on every turn, and some clients cap how many tools a server may list.
`JIRA_TOOL_PACKAGES` picks a profile or a comma list of packages. Measured per
profile (model-visible = name + description + input schema; wire = the whole
`tools/list` result):

| Profile | Tools | Model-visible chars | Wire chars |
|---|---|---|---|
| `core` | 3 | 2.7k | 3.9k |
| `reader` | 34 | 37k | 50k |
| `all` (default) | 82 | 114k | 146k |

On a tool-capped client (Cursor has historically capped how many tools a
server may list),
use `JIRA_TOOL_PACKAGES=reader`, which is read-only, or list only the packages
you need, for example `core,search,issues,issues-write`. Claude Code defers
MCP tools behind tool search, so there `all` is fine. A test holds these
figures, so the table cannot go stale unnoticed (rationale: D510).

## Tools

<!-- GENERATED:TOOLS:START -->

<!-- Generated by scripts/generate-readme.mjs from the tool manifest.
     Do not edit by hand — run `npm run readme`. -->

82 tools in 11 packages, 40 of them write tools
behind the plan/apply gate. `JIRA_TOOL_PACKAGES`, `JIRA_PACKAGES_DENY` and
`JIRA_PACKAGES_READONLY` decide which of them a session actually sees; the
`core` package is always registered. Full input and output shapes are in
[`docs/TOOLS.md`](docs/TOOLS.md).

The Since column names the release that first shipped each tool. The latest
release, 1.0.0, has 58 of them; the 24 rows marked
`1.1.0 (unreleased)` are on `main` only, so the published package
does not have them yet.

### Core — `core`

Server self-description, credential and permission checks — always registered, even when every other package is denied.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_capabilities` | Describe this server | read-only | 0.9.0 | Describe this server's capabilities without calling Jira: the packages and tools that are registered, the site, the active profile, the write mode (plan vs apply) and the per-call limits. |
| `jira_get_myself` | Get authenticated user | read-only | 0.9.0 | Verify the configured credentials and return the account they belong to: accountId, displayName, active, accountType, timeZone and locale. |
| `jira_get_my_permissions` | Check my permissions | read-only | 1.1.0 (unreleased) | Check whether the configured account holds the named permissions globally, in a project or on one issue, before a write. |

### Search — `search`

JQL search over issues, approximate result counts, strict JQL checks, and the saved filters that store reusable JQL — read, created and edited, one page per call.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_search` | Search issues | read-only | 0.9.0 | Search Jira issues by JQL: ONE page per call, max 100 rows, plus data.nextPageToken — pass it back for the next page. |
| `jira_count` | Count issues | read-only | 0.9.0 | Count Jira issues matching a JQL query without fetching any of them. |
| `jira_parse_jql` | Check JQL | read-only | 1.1.0 (unreleased) | Check JQL against Jira's strict parser without running it: grammar, and whether every field, function and value it names exists for you. |
| `jira_list_filters` | List saved filters | read-only | 0.9.0 | Find saved filters — named, stored JQL — by name substring or owner, each with its jql. |
| `jira_get_filter` | Get saved filter | read-only | 0.9.0 | Read one saved filter by numeric id (from jira_list_filters): name, description, owner, the JQL it stores and whether you favourited it. |
| `jira_create_filter` | Create saved filter | write · standard | 1.1.0 (unreleased) | Save a JQL query as a new filter owned by you. The filter is private — no share or edit permission is ever sent — and this tool does not run the JQL. |
| `jira_update_filter` | Update saved filter | write · standard | 1.1.0 (unreleased) | Change a saved filter's name, JQL or description by numeric id (from jira_list_filters). Fields you leave out keep their current value; description "" clears it. |

### Issues (read) — `issues`

One issue and its comments, available transitions, change history, worklogs and remote links, plus the progress of a bulk task — reads only; the matching writes live in issues-write and issues-delete.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_get_issue` | Get issue | read-only | 0.9.0 | Get a Jira issue by key or id, or up to 100 (1000 with named single-value fields) with issues: [...]. |
| `jira_get_comments` | Get comments | read-only | 0.9.0 | List the comments on an issue, newest first by default (orderBy -created; Jira's own default is oldest first). |
| `jira_get_transitions` | Get transitions | read-only | 0.9.0 | List the workflow transitions available from this issue's CURRENT status: id, name and target status. |
| `jira_get_changelog` | Get changelog | read-only | 0.9.0 | Read an issue's changelog (change history) — field, from → to, author, created. |
| `jira_get_changelogs_bulk` | Get changelogs in bulk | read-only | 1.1.0 (unreleased) | Read the changelogs of up to 1000 issues in one bulk request, optionally only for some fields (fieldIds: ["status"] for status transitions). |
| `jira_get_worklogs` | Get worklogs | read-only | 0.9.0 | List the worklogs (work logged) on an issue: timeSpentSeconds, timeSpent, started, author and the flattened comment. |
| `jira_get_remote_links` | Get remote links | read-only | 1.1.0 (unreleased) | List the web links attached to an issue — pull requests, Confluence pages, runbooks: id, url, title, summary, relationship, application and, when the target reports one, resolved. |
| `jira_get_bulk_status` | Get bulk status | read-only | 1.0.0 | Poll a bulk operation by task id, UI-submitted included. |

### Issues (write) — `issues-write`

Issue changes: creation, fields, workflow transitions, comments and comment edits, assignee, worklogs, issue links and remote links — every tool is plan-gated.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_create_issue` | Create issue | write · standard | 0.9.0 | Create one issue. project and issueType are instance-specific: jira_list_projects and jira_get_create_meta resolve them, and the latter names the custom fields the project requires. |
| `jira_update_issue` | Update issue | write · standard | 0.9.0 | Update fields on one issue. |
| `jira_transition_issue` | Transition issue | write · standard | 0.9.0 | Move one issue through its workflow. |
| `jira_add_comment` | Add comment | write · standard | 0.9.0 | Add a comment to one issue. body takes plain text (converted to ADF) or a raw ADF document; format: "markdown" parses a string body as the markdown subset. |
| `jira_update_comment` | Update comment | write · standard | 0.9.0 | Edit one existing comment. |
| `jira_assign_issue` | Assign issue | write · standard | 0.9.0 | Set or clear the assignee of one issue. Pass exactly one of accountId (assign) or unassign: true (clear) — both together is rejected as ambiguous, neither is rejected as intentless. |
| `jira_add_worklog` | Add worklog | write · standard | 0.9.0 | Log work against one issue as a new worklog. Pass exactly one of timeSpentSeconds (preferred) or timeSpent ("2h 30m"). |
| `jira_update_worklog` | Update worklog | write · standard | 1.1.0 (unreleased) | Edit one existing worklog entry. Name only what changes — a duration (timeSpentSeconds or timeSpent, at most one), started, or comment — and only those fields are sent. |
| `jira_link_issues` | Link issues | write · standard | 0.9.0 | Link two issues. linkType is the link type NAME ("Blocks", "Relates"), and those names are instance-specific — read them from jira_list_link_types and spell them exactly. |
| `jira_add_remote_link` | Add remote link | write · standard | 1.1.0 (unreleased) | Attach a web link to an issue — a pull request, a Confluence page, a runbook. url must be absolute http(s). |

### Deletes and bulk changes (irreversible) — `issues-delete`

Irreversible deletions — an issue, a comment, a worklog entry, an issue link, an attachment, a remote link, a component, a version, a sprint — and the bulk writes that delete or edit up to 1000 issues in one asynchronous operation.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_delete_issue` | Delete issue | write · irreversible | 0.9.0 | Permanently delete one issue. IRREVERSIBLE: Jira has no undo and no trash for this, the issue and its comments, worklogs and attachments are gone. |
| `jira_delete_comment` | Delete comment | write · irreversible | 0.9.0 | Permanently delete one comment from an issue. IRREVERSIBLE: the comment is not recoverable and the deletion is not recorded in the issue changelog. |
| `jira_delete_worklog` | Delete worklog | write · irreversible | 0.9.0 | Permanently delete one worklog entry from an issue. IRREVERSIBLE: the logged time is gone and Jira gives it back to the remaining estimate (its default adjustment). |
| `jira_unlink_issues` | Unlink issues | write · irreversible | 1.1.0 (unreleased) | Remove one link between two issues. The link disappears from BOTH issues. IRREVERSIBLE: Jira keeps no record of the removed link; jira_link_issues can only create a new one in its place. |
| `jira_delete_attachment` | Delete attachment | write · irreversible | 1.1.0 (unreleased) | Permanently delete one attachment from its issue. IRREVERSIBLE: the file is gone from Jira and only a local copy (jira_download_attachment) survives. |
| `jira_delete_remote_link` | Delete remote link | write · irreversible | 1.1.0 (unreleased) | Remove one web link (pull request, page, runbook) from an issue. IRREVERSIBLE: Jira keeps no record of the removed link; jira_add_remote_link can only create a new one in its place. |
| `jira_delete_component` | Delete component | write · irreversible | 1.0.0 | Permanently delete one project component. IRREVERSIBLE: no undo, and every issue referencing it is rewritten — reassigned to moveIssuesTo when given, stripped of the component when not. |
| `jira_delete_version` | Delete version | write · irreversible | 1.0.0 | Permanently delete one version (release). |
| `jira_delete_sprint` | Delete sprint | write · irreversible | 1.0.0 | Permanently delete one sprint. IRREVERSIBLE: the sprint record and its history are gone; its issues are NOT deleted — Jira moves the open ones to the backlog. |
| `jira_bulk_delete_issues` | Bulk delete issues | write · irreversible | 1.0.0 | Permanently delete up to 1000 issues in one asynchronous bulk operation. IRREVERSIBLE: no undo, and subtasks of selected parents go with them (they count toward the 1000). |
| `jira_bulk_edit_issues` | Bulk edit issues | write · irreversible | 1.0.0 | Edit up to 1000 issues in one asynchronous bulk operation: one change set — labels, priority, assignee, fix versions — applied to every issue. |

### Attachments — `attachments`

Files on issues: list what is attached, download one into the server's media directory, and attach a file from it. The two byte-moving tools need JIRA_MEDIA_DIR and never touch anything outside it.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_list_attachments` | List attachments | read-only | 0.9.0 | List the attachments (files) of one issue: id, filename, size in bytes, mime type, author and creation time. Metadata only — no bytes are transferred and no local directory is needed. |
| `jira_download_attachment` | Download attachment | read-only | 0.9.0 | Download one attachment INTO THIS SERVER'S media directory and return the local path — the bytes never pass through the conversation. |
| `jira_upload_attachment` | Upload attachment | write · standard | 0.9.0 | Upload an attachment to an issue from this server's media directory. |

### Watchers, votes & project setup — `collab`

The surface around an issue: who watches it, who voted for it, and the components and versions a project files work under — including cutting a release. Reversible writes only; nothing here deletes anything.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_list_watchers` | List watchers | read-only | 0.9.0 | List the watchers of an issue — the accounts watching it — with the watch count and whether this server's own account is among them. |
| `jira_add_watcher` | Add watcher | write · standard | 0.9.0 | Add a watcher: make an account watch an issue, so Jira notifies it of every change. Adding an account that already watches changes nothing. |
| `jira_remove_watcher` | Remove watcher | write · standard | 0.9.0 | Remove a watcher: stop an account watching an issue — it no longer gets notifications. |
| `jira_add_vote` | Vote for issue | write · standard | 0.9.0 | Cast THIS SERVER'S OWN vote for an issue. There is no way to vote on behalf of another account — the endpoint takes no accountId — so a request to record someone else's vote cannot be honoured. |
| `jira_remove_vote` | Withdraw vote | write · standard | 0.9.0 | Withdraw THIS SERVER'S OWN vote from an issue; other people's votes are untouched and unreachable. Nothing is deleted beyond the vote itself, and jira_add_vote casts it again. |
| `jira_list_components` | List components | read-only | 0.9.0 | List a project's components — the sub-areas an issue's `components` field points at — with their id, name, description, lead and default assignee rule. |
| `jira_create_component` | Create component | write · standard | 0.9.0 | Create a component in a project — a sub-area issues can be filed under. Takes the project KEY (jira_create_version takes a numeric id instead; that asymmetry is Jira's). |
| `jira_update_component` | Update component | write · standard | 0.9.0 | Change a component. This is a PARTIAL update, unlike jira_update_issue: only the fields you pass are changed and everything you omit keeps its current value. |
| `jira_list_versions` | List versions | read-only | 0.9.0 | List a project's versions (releases) — what fixVersions and affectedVersions point at — with id, name, dates and whether released or archived. |
| `jira_create_version` | Create version | write · standard | 0.9.0 | Create a version (a release) in a project — a value issues can then use in fixVersions. Takes the NUMERIC projectId, not the key (jira_create_component takes a key; the asymmetry is Jira's). |
| `jira_update_version` | Update version | write · standard | 0.9.0 | Change a version — how a release is cut (released: true) and un-cut (released: false). A PARTIAL update, unlike jira_update_issue: only the fields you pass change; omitted ones keep their value. |
| `jira_list_project_roles` | List project roles | read-only | 0.9.0 | List a project's roles (Administrators, Developers, …) with their ids, and — with a roleId — the accounts and groups in that one role: who can do what here. |

### Metadata & discovery — `meta`

Projects, fields, create metadata, statuses, link types, priorities, resolutions, issue types, labels and time tracking settings — the reads that turn names into the ids every other package needs.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_list_projects` | List projects | read-only | 0.9.0 | List the Jira projects you can see — id, key, name, project type and lead. This is how a project NAME becomes the KEY every other tool wants. |
| `jira_get_project` | Get project | read-only | 0.9.0 | Read one project in detail: description, lead, issue types, components and versions — what you need before creating an issue, because issue type ids and component/version names are per-project. |
| `jira_list_fields` | List fields | read-only | 0.9.0 | List every field with id, name, schema type and custom flag — THE discovery tool for field ids, so "Story Points" resolves to customfield_10016 and back. |
| `jira_get_create_meta` | Get create metadata | read-only | 0.9.0 | Read the create metadata for a project: what jira_create_issue accepts. |
| `jira_list_statuses` | List statuses | read-only | 0.9.0 | List workflow statuses — id, name, category and scope — so JQL like status = "In Review" names a status that really exists on this site. |
| `jira_list_link_types` | List issue link types | read-only | 0.9.0 | List the issue link types configured on this site with their inward and outward phrases (for example "blocks" / "is blocked by"). |
| `jira_list_priorities` | List priorities | read-only | 1.1.0 (unreleased) | List the priorities configured on this site — id, name, colour and which one is the default — so JQL like priority = High and the priority field of a create or update name a priority that really exis… |
| `jira_list_resolutions` | List resolutions | read-only | 1.1.0 (unreleased) | List the resolutions configured on this site (Done, Won't Do, Duplicate, ...) with their ids. |
| `jira_list_issue_types` | List issue types | read-only | 1.1.0 (unreleased) | List every issue type the caller can see, site-wide: id, name, subtask flag, hierarchy level, and scopeProjectId for a team-managed project's own type — two rows can share a name, so pick by id. |
| `jira_list_labels` | List labels | read-only | 1.1.0 (unreleased) | List the labels already in use on this site, so a create, an update or JQL like labels = backend reuses an existing label instead of minting a near-duplicate ("Backend" vs "backend"). |
| `jira_get_timetracking_config` | Get time tracking settings | read-only | 1.1.0 (unreleased) | Read the time tracking config: whether it is on and how this site counts time: working hours per day, days per week, display format and default unit, plus secondsPerDay and secondsPerWeek — what "1d"… |

### User lookup — `users`

Finding people by name or email — the one path from a human name to the accountId every other tool requires.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_search_users` | Search users | read-only | 0.9.0 | Find users by display name or email and return their accountId — the id every other tool takes; Cloud has no usernames. |

### Boards & sprints — `agile`

Jira Software boards, sprints and their issues, the two moves (into a sprint, out to the backlog) and the sprint lifecycle — the only tools that speak the Agile API rather than the platform one.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_list_boards` | List boards | read-only | 0.9.0 | List the Jira Software boards you can see — id, name, type and the project each belongs to. The board id is what jira_list_sprints takes, so this is the first call of any sprint workflow. |
| `jira_get_board_config` | Get board configuration | read-only | 1.1.0 (unreleased) | Read one board's configuration: the saved filter behind it (filterId), its columns with the status ids each one holds, the column constraint, the estimation field (estimation.fieldId — the story-poin… |
| `jira_list_sprints` | List sprints | read-only | 0.9.0 | List a board's sprints with their id, name, state, goal and dates. Filter with state ("active" for the sprint in flight, "future" for the ones planned). |
| `jira_get_sprint_issues` | Get sprint issues | read-only | 0.9.0 | List the issues in one sprint, flattened like jira_search: rich text as plain text, users as accountId + displayName. |
| `jira_get_backlog` | Get board backlog | read-only | 1.1.0 (unreleased) | List a board's backlog — the issues of its filter that sit in no active or future sprint — in board rank order, flattened like jira_search. |
| `jira_move_to_sprint` | Move issues to sprint | write · standard | 0.9.0 | Move up to 50 issues into a sprint — the only way to set a sprint, which is not an editable field on jira_update_issue. |
| `jira_move_to_backlog` | Move issues to backlog | write · standard | 0.9.0 | Send up to 50 issues back to the backlog — Jira defines it as "remove the future and active sprints from these issues", so it is the inverse of jira_move_to_sprint and the only way to clear a sprint… |
| `jira_create_sprint` | Create sprint | write · standard | 0.9.0 | Create a sprint on a Scrum board and returns its id. The sprint is created in the "future" state — this does NOT start it, jira_start_sprint does, and only a started sprint is the work in flight. |
| `jira_start_sprint` | Start sprint | write · standard | 0.9.0 | Start a sprint: "future" becomes "active", making its issues the work in flight that every board report measures from. |
| `jira_close_sprint` | Close sprint | write · standard | 0.9.0 | Complete the active sprint. |
| `jira_update_sprint` | Update sprint | write · standard | 1.1.0 (unreleased) | Edit a sprint's name, goal or dates and leaves every other field as it is; at least one is required. It never changes the state — jira_start_sprint and jira_close_sprint do. |
| `jira_rank_issues` | Rank issues | write · standard | 1.1.0 (unreleased) | Move issues directly above or below another issue in the board order, keeping their given order. Give exactly one of rankBeforeIssue or rankAfterIssue. |
| `jira_set_estimate` | Set estimate | write · standard | 1.1.0 (unreleased) | Set an issue's estimate in the field its board estimates with — story points or a time estimate — so no custom field id is needed. |
| `jira_sprint_summary` | Summarise a sprint | read-only | 1.1.0 (unreleased) | Summarise one sprint in one call, in place of Jira's velocity / sprint report: issue counts and the board's estimate (story points) summed by status category, the completion ratio, the issues added a… |

### Portfolio — `portfolio`

Cross-board analysis: hierarchy per project, duplicate and overlapping work, reuse candidates, cross-project blockers and shared hotspots — as data, or as a Markdown report with Mermaid diagrams written into JIRA_REPORT_DIR.

| Tool | Title | Access | Since | What it does |
| --- | --- | --- | --- | --- |
| `jira_portfolio_analyze` | Analyze portfolio | read-only | 1.1.0 (unreleased) | Analyze a portfolio — the work of several projects or boards — in one sweep: the epic/story/subtask hierarchy per project, likely duplicate and overlapping open work across boards, open issues that r… |
| `jira_portfolio_report` | Write portfolio report | read-only | 1.1.0 (unreleased) | Write a portfolio report: runs the jira_portfolio_analyze sweep and saves the result as a Markdown file into JIRA_REPORT_DIR: per-project tables, Mermaid hierarchy and findings diagrams, and tables o… |

<!-- GENERATED:TOOLS:END -->

Beyond the tool list, the server serves **reference resources** (MCP
`resources/read`): `jira://reference/tools` indexes every tool and says whether
your configuration registered it, `jira://reference/tools/{name}` returns one
tool's full schema with an example call, and `jira://reference/write-mode`,
`jira://reference/jql` and `jira://reference/markdown` hold the plan/apply
contract, JQL idioms and the markdown subset the write tools accept. A client
that reads resources gets the detail on demand; the tool descriptions stay
short.

It also serves **prompts** (MCP `prompts/list`): `jira_sprint_review`,
`jira_standup`, `jira_triage_unassigned`, `jira_release_notes`,
`jira_issue_brief`, `jira_worklog_summary`, `jira_epic_progress`,
`jira_my_work`, `jira_blocked_report` and `jira_bulk_preflight` are
ready-made read-only workflows over the existing tools. A prompt is listed only
when every tool it names is registered in your configuration.

## Data handling

What leaves your machine, what is written to disk, what is redacted from logs,
and what the write gate does and does not promise are documented in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). Credential storage and lifecycle
are in [`docs/AUTH.md`](docs/AUTH.md).
A Jira admin or security reviewer deciding whether to allow this server can
start with the one-page [`docs/ADMIN-OVERVIEW.md`](docs/ADMIN-OVERVIEW.md).

To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## Development

```sh
npm install
npm run check   # typecheck, lint, format, build, tarball, test, docs-lint, prod audit
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor entry point: the
`npm run check` gate, the rules a PR cannot break, and how to point the server
at a real Jira site without endangering anyone's tenant.
[`docs/README.md`](docs/README.md) is the index to the specification and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the place to start; the test
taxonomy and the coverage gate are in [`docs/TESTING.md`](docs/TESTING.md).
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Copyright (C) 2026 Ivan Baev. Licensed under
[GPL-3.0-only](LICENSE). Versions up to and including 1.0.0-beta.1 were published under MIT and remain available under it.

**Does using it make my code GPL?** No. Running the server, and connecting
your agent or your tools to it, does not put your code under the GPL. The
licence matters only if you distribute a modified copy of the server itself.

Jira and Atlassian are trademarks of Atlassian Pty Ltd. This project is an
independent, unofficial client and is not affiliated with or endorsed by
Atlassian.
