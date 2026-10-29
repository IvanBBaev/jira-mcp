# Documentation & Onboarding review — 2026-10-29

Scope: the whole documentation system of `jira-mcp-ai` on `main` (README.md, CHANGELOG.md,
CONTRIBUTING.md, SECURITY.md, `.env.example`, `server.json`, every file in `docs/`, the GitHub
Pages site `docs/index.html`). It also covers the user-facing text the binary emits itself
(`--help`, startup errors, `doctor` remediations, tool descriptions). The review follows two
personas through their first hour: (a) a developer who registers the server in Claude Code,
Claude Desktop or Cursor with an API token, and (b) a Jira site admin who decides whether to
allow it. Method: everything was read-only. I checked 31 factual claims against the source
(`src/core/settings.ts`, `src/mcp/registry.ts`, `src/core/journal.ts`, `src/mcp/exports.ts`,
`src/tools/*.ts`, `src/cli/*.ts`, `src/index.ts`, `src/tools/manifest.snapshot.json`, counted
with a script) and against each other. 22 hold. 9 have drifted, and they are listed below. I did
not run the gate. Severity scale: P0 = wrong or misleading for users now; P1 = fix before the
next release; P2 = should fix; P3 = nice to have. Estimates are hours for one autonomous Opus
session at this repo's gate standard.

## Verdict

| Decision | Verdict | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | **CONDITIONAL GO** | First land DOC-R1 (wrong counts, plus a released-vs-unreleased marker), DOC-R2's secret-safe registration snippets, DOC-R3 (the data-at-rest statement in THREAT-MODEL is false) and DOC-R7 (1.1.0 upgrade notes for the breaking agile paging change, plus the pin bump). |
| The v3 plan (ROADMAP V3-xx) | **CONDITIONAL GO** | Keep V3-20, but cut it down to what it really is: contributor-corpus hygiene. Then add the user-docs and admin-docs items it leaves out (DOC-R4, R5, R6, R8) and a docs checklist in V3-22. |

The reference material is unusually rigorous. All 45 `JIRA_*` variables, their defaults and
the CLI flags match the code, and several docs-lint checks plus a generated README tool table
keep it that way. Where it falls down is the hand-written prose layer around that core. Tool
counts in README.md and on the Pages site disagree with each other and with the manifest. The
quick-start tells users to put an API token into a project-scoped config file that teams
usually commit. THREAT-MODEL makes a data-at-rest promise the code breaks. There is no
troubleshooting page and no one-page overview for admins, so both personas end up reading
rationale-heavy documents full of D-row references. None of this is hard to fix. Most of it is
a day of writing plus one new lint check, and that check stops the count drift from coming back.

## Strengths

- **The environment surface is complete and tested.** All 45 `JIRA_*` names appear in
  `docs/CONFIGURATION.md`, `.env.example` and `server.json`, and an env-docs sync test enforces
  this. Every default I checked matches `src/core/settings.ts:64-143` and `:890`: write mode
  `plan`, profile `all`, timeout 30000, budget 120000, concurrency 4, retry 3, 25000 result
  chars, 20 pages, cache TTL 300, port 3334, redirect port 8250, profile lock on, irreversible
  off, confirm `off`. The OAuth default scope list in `CONFIGURATION.md:73` matches
  `settings.ts:127-141`.
- **CLI docs match the parsers.** The `login`/`logout` flags in `docs/AUTH.md:233-267` match
  `src/cli/login.ts:263-300,336-349`. The `doctor --offline/--save/--json` flags in
  `AUTH.md:520-523` match `src/cli/doctor.ts:323-333`.
- **The tool reference is generated.** The README tool tables come from
  `scripts/generate-readme.mjs`, and "82 tools / 11 packages" in `docs/TOOLS.md:808-813` matches
  the manifest (82 tools, 40 writes).
- **docs-lint has 8 checks**: link, banner, owned, cc-ref, pin-mirror, test-bound, status and
  cc-src. pin-mirror already keeps the version pin aligned across documents, which is exactly
  the right mechanism to extend for counts (DOC-01).
- **The docs say plainly what has not been verified.** The DC preview and the OAuth redirect
  carry UNVERIFIED banners (`AUTH.md:110-133`). The README status box says how much has been
  proven live instead of claiming 100 %.
- **Operator help is good where it exists.** It covers the PATH and `npx` failure modes
  (`README.md:55-78`), stderr log locations, a proxy/custom-CA section in CONFIGURATION, and
  `doctor` with an offline mode.
- **The defaults are safe and documented that way**: plan mode, the irreversible tier off, the
  profile lock on, and an optional elicitation third gate (`JIRA_IRREVERSIBLE_CONFIRM=elicit`).
- **`SECURITY.md` is a real disclosure policy** with a table of supported versions.
- **`docs/README.md:26-50` assigns each fact one owning document** (single-writer fact
  ownership). This is the right governance model. It just needs enforcement (DOC-07).
- **There are in-product docs.** The `jira://reference/*` resources and the 10 MCP prompts give
  the model the reference material without a browser.
- **The CHANGELOG has the right intent** (`CHANGELOG.md:8-11`: entries describe what changes
  for users).
- **`CONTRIBUTING.md` is a solid contributor entry point**: gate, test rules, the two ledgers,
  and running against a real site.

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| DOC-01 | P0 | The tool counts in README and on the Pages site are wrong and contradict each other | `README.md:17-24` (80 / 40) vs the generated `README.md:94` (82); `docs/index.html:126,134,1430,2394,2506,2533` (58/82/55/59, "other 21", "17 writes") | Fix every claim. Add a docs-lint `count` check against the manifest snapshot | 2 |
| DOC-02 | P0 | README and the site advertise the 82-tool `main` catalogue, but the pinned install is 1.0.0 (58 tools) | `README.md:89-259` vs the pin `jira-mcp-ai@1.0.0`; `CHANGELOG.md:210-222` ("40 of the 58") | Add a "Since" column, or a released/unreleased marker, in the generated tables, plus a status line naming both versions | 1.5 |
| DOC-03 | P0 | The quick-start puts the API token inline in project-scoped `.mcp.json` / `.vscode/mcp.json` | `README.md:32-53`; the `docs/index.html` install tabs; `AUTH.md:440-444` | Use user scope, `${VAR}` expansion or the `~/.config/jira-mcp-ai/.env` file. Add an explicit "never commit" warning | 1.5 |
| DOC-04 | P0 | THREAT-MODEL says only two places write tenant data to disk; exports and portfolio reports also do | `docs/THREAT-MODEL.md:362-413`; `src/mcp/exports.ts:1-13`; `src/tools/portfolio.ts:429` | List all four sinks (journal, media, exports, reports) with their modes and variables | 1 |
| DOC-05 | P1 | THREAT-MODEL lists stale tier contents: "six deletes" (there are 9 plus 2 bulk), and filters and remote links are missing | `THREAT-MODEL.md:179-194`; manifest: issues-delete 11/11 | Generate the tier lists from the manifest, or point to TOOLS.md | 1 |
| DOC-06 | P1 | No troubleshooting page; error kinds have no operator-facing fixes | no hits for `troubleshoot` in the repo; `TOOLS.md:99-121` (kinds without remediation) | Add `docs/TROUBLESHOOTING.md` (kind → cause → fix, with anchors) and link it from README | 2 |
| DOC-07 | P1 | `doctor` and startup errors cite bare doc names or unpinned `blob/main` URLs; docs are not in the tarball | `src/cli/doctor.ts:572,1171,1506`; `src/core/settings.ts:1233`; `src/index.ts:97-111`; `package.json` `files` | Use tag-pinned absolute URLs with anchors from one helper, and test that the anchors exist | 1.5 |
| DOC-08 | P1 | No one-page governance overview for site admins | Governance is spread across AUTH (542 lines), THREAT-MODEL (420), CONFIGURATION and SECURITY | Add `docs/ADMIN-OVERVIEW.md`: a controls matrix, scopes, service account, data, audit trail, egress | 3 |
| DOC-09 | P1 | `JIRA_PROJECTS` (project scope) is missing from every security-facing doc | 0 hits in README, AUTH, THREAT-MODEL, SECURITY, index.html; present only in CONFIGURATION and `.env.example:143` | Document it in THREAT-MODEL controls, the admin overview and the README safety section, with its limits | 0.5 |
| DOC-10 | P1 | The AUTH scope map claims to be exhaustive but is not; no read-only or minimal scope preset; no scope guidance for service accounts | `AUTH.md:135-231` (claim at `:169`) misses bulk, filters, remote links, permissions, sprint update/rank/estimate, portfolio; `AUTH.md:399-438` | Complete the map (ideally generated), add `reader` and `core` scope presets, add service-account scopes | 2 |
| DOC-11 | P1 | CHANGELOG [Unreleased] has no highlights, no upgrade notes, and an unlabeled breaking change | `CHANGELOG.md:13-208` (about 195 lines, 43 D-refs); `:171-181` agile `paging.total`/`nextStartAt` removed, `startAt>0` refused; `:168` "Gate C claim C44" | Add Highlights, "Upgrading from 1.0", "Breaking (forced by Atlassian CHANGE-3193)". Move internal IDs out | 1.5 |
| DOC-12 | P1 | `server.json` (version 1.0.0) advertises env vars that 1.0.0 does not have | `server.json` lists `JIRA_PROJECTS`, `JIRA_IRREVERSIBLE_CONFIRM`, `JIRA_OAUTH_GRANT`, `JIRA_CLOUD_ID`, `JIRA_REPORT_DIR`, `JIRA_META_CACHE_TTL_S`, which are Unreleased per CHANGELOG | Bump it together with the release (V3-22 checklist), or keep main's server.json in step with the version field | 0.5 |
| DOC-13 | P2 | No Cursor config anywhere; Claude Desktop only on the site | `README.md:32-53` (Claude Code only); `docs/index.html` install tabs (Code/Desktop/VS Code) | Add per-client snippets with the config path for Cursor (`~/.cursor/mcp.json`), Desktop and VS Code | 1 |
| DOC-14 | P2 | Registration, PATH and log content is duplicated in three places, against the single-writer rule | `README.md:55-78` ≈ `CONFIGURATION.md:205-248` ≈ `docs/index.html#install` | Pick one owner (CONFIGURATION, or the new TROUBLESHOOTING); the others link | 1 |
| DOC-15 | P2 | The doc map is stale and has no audience split | `docs/README.md:20` "Phases 0–13" (the plan has 0–16 plus v2 wave 6); `:22` "v1.5 / v2" (the roadmap is at v3); one flat table | Regroup into User / Admin / Contributor / Maintainer; fix the stale lines; lint the phase range | 1 |
| DOC-16 | P2 | The journal description in CONFIGURATION is inaccurate | `CONFIGURATION.md:194` "every write tool call: tool, args hash, result" vs `src/core/journal.ts:1-25`, `OBSERVABILITY.md:121-146` (applied writes only; `{ts,cid,tool,argsHash,ok,httpStatus?,issueKey?}`; about 5 MB rotation) | Replace it with one accurate line plus a link to OBSERVABILITY | 0.25 |
| DOC-17 | P2 | Internal D-/CC- IDs leak into user docs, error strings and model-facing tool descriptions | CONFIGURATION 18 D-refs, AUTH 23, TOOLS 92; `CONFIGURATION.md:80-93`; `settings.ts:771,860,948`; `doctor.ts:1171`; `issues-write.ts:875` "CC-31"; `meta.ts:573` "CC-253" | Keep IDs in contributor docs. User docs get plain prose plus at most one "Rationale: Dnnn" footnote. Strip IDs from runtime strings | 2 |
| DOC-18 | P2 | Count claims, prose lists and the README's links are not machine-checked | docs-lint covers links only under `docs/**`; `TOOLS.md` says "never hand-maintain counts in prose", but nothing enforces it | Extend docs-lint to README.md, SECURITY.md and CONTRIBUTING.md links, plus the count check from DOC-01 | (in DOC-01) |
| DOC-19 | P3 | Nothing explains how agent writes appear in Jira's own history | No User-Agent marker in `src/core/*`; no docs mention it | Document "writes appear as the credential's user, unmarked". Optionally ask the owner about a marker | 0.5 |
| DOC-20 | P3 | Readability: very long DECISIONS rows; dense AUTH and CONFIGURATION paragraphs | `docs/DECISIONS.md` has 8 lines over 2000 chars (longest 3311) | Cover this with V3-20's per-file split. Do a sentence-length pass on user docs | 1 |

## Detailed findings

### DOC-01 — The tool counts in README and on the Pages site are wrong and contradict each other
**What.** The README status box (`README.md:17-24`) says "40 of the 80 tools … the other 40",
but the generated block in the same file (`README.md:94`) says "82 tools in 11 packages, 40 of
them write tools". The Pages site gives six different figures: `docs/index.html:126` (FAQ
JSON-LD: "40 of the 58 tools … 18 still unproven"), `:134` ("40 of the 82"), `:1430` ("the 42
still unproven — 17 writes"; there are 40 writes and 13 proven, so 27 writes are unproven), the
install section ("the other 21"; 82 − 40 = 42), `:2394` ("the last 40 tools"), `:2506` ("of
today's 55 tools") and `:2533` ("40 of 59").
**Evidence.** Manifest count: core 3, search 7, issues 8, issues-write 10, issues-delete 11,
attachments 3, collab 12, meta 11, users 1, agile 14, portfolio 2 = 82 tools; 40 writes; 15
`destructiveHint`.
**Why it matters.** This is the first number both personas see. Contradictory counts read as
carelessness, and an admin will extend that judgement to the safety claims. The FAQ JSON-LD
also feeds search snippets.
**Recommendation.** Fix each claim. Then add a docs-lint `count` check. It reads
`src/tools/manifest.snapshot.json`, finds marked count phrases in README.md and
docs/index.html (for example `<!-- count:tools -->82<!-- /count -->`), and fails on a mismatch.
The "proven live" numbers belong in one owned place (the Gate C ledger) and get mirrored the
same way.
**Acceptance.** `grep -nE '\b(55|58|59|80)\b tools'` over README.md and index.html returns
only historical CHANGELOG-style context. Changing one marked number makes docs-lint fail.

### DOC-02 — README and the site advertise the 82-tool `main` catalogue, but the pinned install is 1.0.0 (58 tools)
**What.** The registration snippet pins `jira-mcp-ai@1.0.0`, which shipped 58 tools
(`CHANGELOG.md:210-222`). The tool tables list all 82 (`README.md:89-259`), including
`jira_portfolio_report`, the bulk tools, `JIRA_PROJECTS` and elicitation, none of which exist in
1.0.0.
**Why it matters.** A developer who copies the snippet and then asks for a tool from the table
gets "unknown tool". This is the most likely first-hour failure that cannot be self-diagnosed.
**Recommendation.** The generator emits a "Since" column (from a `since` field in the manifest,
or from a diff against the last tag's snapshot), and the status box says "Latest release: 1.0.0
(58 tools). `main` (unreleased): 82 tools". Owner decision: see Open question 1.
**Acceptance.** Every tool row added after 1.0.0 carries `1.1.0 (unreleased)` until the
release. A test asserts that the generator output marks them.

### DOC-03 — The quick-start puts the API token inline in project-scoped config files
**What.** `README.md:32-53` shows a `.mcp.json` with `JIRA_API_TOKEN: "<api-token>"` inline.
The site's VS Code tab does the same with `.vscode/mcp.json`. `AUTH.md:440-444` calls
"env vars set by the MCP client config (Claude Code `.mcp.json`)" the preferred method. Both
files are project-scoped and are often committed so the team shares the server. Only the site's
VS Code note says "prefer keeping the token out of project files".
**Why it matters.** This is the single most damaging thing a first-hour user can do with this
tool: an Atlassian token in git grants full user-level access. It also contradicts the repo's
own secrets posture (SECURITY.md).
**Recommendation.** Lead with the secret-free paths: (1) `claude mcp add --scope user …`, which
writes to user config, not the repo; (2) keep only non-secret vars in the client config and the
token in `~/.config/jira-mcp-ai/.env` (already supported); (3) use `${JIRA_API_TOKEN}`
expansion where the client supports it. If a project-file example remains, put a "do not commit
this file" warning directly above it.
**Acceptance.** No snippet in README.md, docs/index.html or AUTH.md places a token placeholder
in a project-scoped file without the warning. AUTH's "preferred" line points to user-scoped
storage.

### DOC-04 — THREAT-MODEL says only two places write tenant data to disk
**What.** `docs/THREAT-MODEL.md:362-413` says "Server-side there are exactly two places data
lands" (the journal and attachment downloads) and "No other tenant data is written". In fact
`output: "file"` writes JSONL exports of issue rows into `JIRA_MEDIA_DIR`
(`src/mcp/exports.ts:1-13`, D152), and `jira_portfolio_report` writes Markdown reports into
`JIRA_REPORT_DIR` (`src/tools/portfolio.ts:429`, `open(path, 'wx', REPORT_FILE_MODE)`).
THREAT-MODEL never mentions `JIRA_REPORT_DIR`, exports, D152 or D126.
**Why it matters.** This is the paragraph an admin or security reviewer quotes in an approval.
A false "no other data" statement is a P0 trust defect, even though the code itself is
reasonable (exclusive create, file mode).
**Recommendation.** Turn the paragraph into a table of four sinks: journal, attachment media,
exports, reports. For each give the path variable, default, file mode, what it holds (metadata
only, or tenant content), retention, and how to disable it.
**Acceptance.** Every `open(`/`writeFile` call site under `src/` that persists tenant data maps
to a row. A review note in the test-bound docs-lint links the table to those call sites.

### DOC-05 — THREAT-MODEL lists stale tier contents
**What.** `THREAT-MODEL.md:179-194` describes the irreversible tier as "the six deletes … plus
the two bulk writes". The `issues-delete` package holds 11 tools: delete issue, comment,
worklog, attachment and remote link; unlink; delete component, version and sprint; plus the two
bulk tools. The standard-tier list also omits filters and remote links.
**Recommendation.** Replace the hand list with a pointer to the generated TOOLS.md tier table,
or generate the list. **Acceptance.** No enumerated tool list remains in THREAT-MODEL that a
test does not bind to the manifest.

### DOC-06 — No troubleshooting page
**What.** A repo-wide search for "troubleshoot" finds nothing. `TOOLS.md:99-121` lists the 13
error kinds (config, auth, permission, not_found, validation, rate_limited, transport, timeout,
ambiguous_write, budget_exceeded, write_gated, unexpected_shape, unsupported) for the model,
with no "what the operator should do".
**Why it matters.** Users meet `write_gated` and `permission` in their first session, and
`ambiguous_write` is exactly the case where a human must check Jira before retrying.
**Recommendation.** Add `docs/TROUBLESHOOTING.md` with one stable anchor per kind
(`#write_gated`, …), giving symptom → likely cause → fix → which `doctor` check covers it, plus
the client-side failures (PATH/`npx`, the server not showing in the client, logs). Move
`README.md:55-78` there.
**Acceptance.** Each `ErrorKind` value has an anchor. A test enumerates the kinds and asserts
that each anchor exists.

### DOC-07 — `doctor` and startup errors cite bare or unpinned doc references
**What.** `src/cli/doctor.ts:572` ("AUTH.md §Scoped API tokens"), `:1506`
("docs/CONFIGURATION.md §"Proxy and custom CA""), `:1171` ("(D106)"). `src/core/settings.ts:1233`
and `src/index.ts:97-111` link `…/blob/main/docs/CONFIGURATION.md`. The npm tarball ships only
`bin`, `build`, `CHANGELOG.md` and README, so a bare file name points nowhere, and `blob/main`
describes unreleased behaviour (DOC-02).
**Recommendation.** Add one `docUrl(file, anchor)` helper that builds
`https://github.com/IvanBBaev/jira-mcp/blob/v<pkg.version>/docs/<file>#<anchor>`, and use it
for every remediation. Remove D-IDs from these strings.
**Acceptance.** A test greps `src/` for `\.md` in string literals outside the helper and finds
none. A test resolves every anchor the helper is called with.

### DOC-08 — No one-page governance overview for site admins
**What.** Persona (b) needs AUTH (542 lines), THREAT-MODEL (420), CONFIGURATION (248) and
SECURITY (94) to answer six questions: what can it do, with whose identity, which scopes, how
do I restrict it, where does data go, and what does the audit trail show.
**Recommendation.** Add `docs/ADMIN-OVERVIEW.md` (at most two screens). It needs:
- a 3-sentence summary;
- a controls matrix covering the read-only profile (`JIRA_TOOL_PACKAGES=reader`),
  `JIRA_PACKAGES_DENY`/`READONLY`, `JIRA_PROJECTS`, `JIRA_WRITE_MODE`,
  `JIRA_ALLOW_IRREVERSIBLE`, elicitation, and the profile lock, giving for each what it
  enforces and what it does not;
- the identity options (personal token / scoped token / 3LO / service account);
- recommended scope sets per profile;
- the egress hosts;
- the data-at-rest table (DOC-04);
- the audit story: write journal plus Jira's native history (DOC-19);
- "how to revoke";
- links to the deep docs.

Link it from the README.
**Acceptance.** An admin can answer all six questions from this page alone. Its links pass
docs-lint, and its variable names are checked by the env-docs sync test.

### DOC-09 — `JIRA_PROJECTS` is missing from every security-facing doc
**What.** `JIRA_PROJECTS` appears in CONFIGURATION and `.env.example:143`, but nowhere in
README, AUTH, THREAT-MODEL, SECURITY or index.html. It is the control admins ask about most
("can I limit it to project X").
**Recommendation.** Document it in the THREAT-MODEL controls and in DOC-08. Spell out its
limits: it is server-side filtering, not a Jira permission boundary, and Jira permissions remain
the real boundary.
**Acceptance.** It appears in THREAT-MODEL, ADMIN-OVERVIEW and the README safety section.

### DOC-10 — The AUTH scope map is not exhaustive
**What.** `AUTH.md:169` calls the scope table "exhaustive over the surface". It does not
mention the bulk tools, filter creation, remote links, `my_permissions`, sprint
update/rank/estimate, or portfolio. The default scope list includes `manage:jira-project`.
There is no read-only preset, and the service-account section (`AUTH.md:399-438`) does not say
which scopes to grant.
**Recommendation.** Generate the per-tool scope column from a `scopes` field next to the tools,
or at least bind the table to the manifest with a test. Publish two presets: "reader"
(read-only granular scopes) and "core writes". Add a scope checklist for service accounts.
**Acceptance.** A test fails if a manifest tool lacks a row. AUTH shows copy-pasteable preset
scope lists.

### DOC-11 — CHANGELOG [Unreleased] has no highlights, no upgrade notes, and an unlabeled breaking change
**What.** `CHANGELOG.md:13-208` is about 195 lines ordered by D-number, with 43 D-refs.
`:171-181`, filed under "Changed", removes `paging.total`/`nextStartAt` from agile results on
Cloud and refuses `startAt > 0` (D500/D503). This is forced by Atlassian CHANGE-3193
(2026-11-01), and it is breaking for any prompt or script that pages agile results. `:168`
carries internal noise ("59 tools, 29 reads … Gate C claim C44").
**Recommendation.** Lead the 1.1.0 entry with 5–7 Highlights, then a "Breaking / Upgrading
from 1.0" block (the agile paging change and what to do), then Added/Changed/Fixed in user
language. D-numbers move to a trailing "Decisions" line per section. Remove the Gate C ledger
references.
**Acceptance.** Someone on 1.0.0 can tell what to change in under a minute. No bullet starts
with an internal ID.

### DOC-12 — `server.json` advertises env vars that 1.0.0 does not have
**What.** `server.json` is at version 1.0.0 but lists six variables that CHANGELOG puts under
[Unreleased]. Registry consumers will show options the installed version ignores.
**Recommendation.** Make this part of the V3-22 release checklist. Optionally add a test that
the env vars in server.json are a subset of those in the released snapshot.
**Acceptance.** Every version of server.json matches what that version supports.

### DOC-13 — No Cursor config anywhere; Claude Desktop only on the site
**What.** The README shows only Claude Code. The site adds Desktop and VS Code. "Cursor"
appears in no user doc (it appears only in pagination senses elsewhere).
**Recommendation.** Use a per-client block (Claude Code CLI command; Claude Desktop
`claude_desktop_config.json` path per OS; Cursor `~/.cursor/mcp.json`; VS Code). Each block
gets the same three env vars, the token kept out of project files (DOC-03), and a restart hint.
**Acceptance.** All four clients are documented in one owned place, and the README links to it.

### DOC-14 — Registration, PATH and log content is duplicated in three places
**What.** `README.md:55-78`, `CONFIGURATION.md:205-248` and the site's install section carry
the same pin rationale, PATH failure and log paths. pin-mirror only keeps the version string in
sync, not the prose.
**Recommendation.** Make CONFIGURATION (or TROUBLESHOOTING) the owner, add it to the ownership
table, and shrink the others to a one-line link. **Acceptance.** The owned-check lists the
fact, and the duplicate paragraphs are gone.

### DOC-15 — The doc map is stale and has no audience split
**What.** `docs/README.md:20` says "IMPLEMENTATION-PLAN Phases 0–13", but the plan runs to
phase 16 plus "v2 wave 6". `:22` describes ROADMAP as "Post-v1 items (v1.5 / v2)", but the
roadmap is on v3. The map is one flat table mixing user, operator and contributor docs.
**Recommendation.** Split it into four groups: *Use it* (README, CONFIGURATION, AUTH quick
part, TROUBLESHOOTING, TOOLS); *Approve it* (ADMIN-OVERVIEW, THREAT-MODEL, SECURITY);
*Build it* (CONTRIBUTING, ARCHITECTURE, TESTING, JIRA-API, CORNER-CASES, DECISIONS);
*Run the project* (ROADMAP, IMPLEMENTATION-PLAN, RELEASING). **Acceptance.** No stale range
remains. The groups match the audiences above.

### DOC-16 — The journal description in CONFIGURATION is inaccurate
**What.** `CONFIGURATION.md:194` says the journal records "every write tool call: tool, args
hash, result, timestamp". According to `src/core/journal.ts:1-25` and `OBSERVABILITY.md:121-146`,
only **executed** writes are recorded (not plan calls), with the shape
`{ts, cid, tool, argsHash, ok, httpStatus?, issueKey?}`, and the file rotates at about 5 MB
with one `.1` kept. **Recommendation.** Write one accurate line and link to OBSERVABILITY.
**Acceptance.** The line matches the code.

### DOC-17 — Internal D-/CC- IDs leak into user docs, error strings and tool descriptions
**What.**
- User docs carry D-refs: CONFIGURATION 18, AUTH 23, TOOLS 92.
- `CONFIGURATION.md:80-93`, the Data Center paragraph, is a chain of D-refs.
- Runtime strings contain IDs: `settings.ts:771,860,948` (D106, CC-29, CC-30) and
  `doctor.ts:1171`.
- Model-facing descriptions contain IDs: `src/tools/issues-write.ts:875` ("CC-31") and
  `src/tools/meta.ts:573` ("CC-253"). These cost tokens and mean nothing to the model.

**Recommendation.** Rule: user docs and runtime strings explain the behaviour. IDs appear only
as a trailing "(rationale: Dnnn)" link in docs and never in runtime strings. Add a docs-lint or
unit check that bans `\b(D|CC-)\d{2,}\b` in string literals under `src/tools/` and
`src/cli/`.
**Acceptance.** Zero matches in runtime strings. In user docs, D-refs are each 1 or fewer per
section.

### DOC-18 — Count claims, prose lists and the README's links are not machine-checked
**What.** docs-lint's link check covers `docs/**` only. README, SECURITY and CONTRIBUTING links
are unchecked. TOOLS.md tells authors not to hand-maintain counts, but no check enforces it.
That gap is why DOC-01 happened. **Recommendation.** This is folded into DOC-R1.

### DOC-19 — Nothing explains how agent writes appear in Jira's own history
**What.** `src/core/` sets no User-Agent or other marker, and no doc says so. In Jira's
history, an agent's edits are indistinguishable from the credential owner's own. Admins will ask.
**Recommendation.** Say so plainly in ADMIN-OVERVIEW, and recommend a service account (D302)
for attributable audit. Whether to add a marker (a User-Agent suffix, or an optional comment or
label) is an owner decision (Open question 4).

### DOC-20 — Readability
**What.** `docs/DECISIONS.md` has 168 rows, 8 of them over 2000 characters (the longest 3311).
AUTH mixes rationale with operator steps. The 3LO app registration (`AUTH.md:78-108`) is
paragraphs, not a numbered checklist. **Recommendation.** V3-20's per-decision files fix
DECISIONS. Convert the AUTH registration and login sections into numbered steps.

## First-hour walkthroughs

### (a) Developer, API token, Claude Code / Claude Desktop / Cursor

| # | Step | Where | Friction | Time |
|---|---|---|---|---|
| 1 | Land on the GitHub README, read what it is and the status box | `README.md:1-24` | "40 of 80" vs "82 tools" two screens later (DOC-01) | 2 min |
| 2 | Create an Atlassian API token | README links to Atlassian | Fine. Scoped-token users need `JIRA_CLOUD_ID`, which they find only in AUTH | 3 min |
| 3 | Choose the client config | `README.md:32-53` | Claude Code only. Desktop users must find the Pages site. Cursor users must guess (DOC-13) | 5–10 min |
| 4 | Paste the token into `.mcp.json` | `README.md:32-53` | Token lands in a project file and may get committed (DOC-03) | 1 min |
| 5 | Restart the client; the server fails to start (`npx` not on the GUI PATH) | `README.md:55-78` | Well covered, but only if they scroll, since there is no Troubleshooting heading (DOC-06) | 5 min |
| 6 | Run `npx jira-mcp-ai@1.0.0 doctor` | `README.md:59-64` | Good. Remediations say "see AUTH.md §…" and the file is not in the package (DOC-07) | 3 min |
| 7 | First prompt: "search my open issues" | — | Works (plan-mode-safe reads) | 2 min |
| 8 | Asks for a tool from the README table, e.g. the portfolio report | `README.md:89-259` | "Unknown tool": it does not exist in 1.0.0 (DOC-02) | 5–10 min lost |
| 9 | Tries a write; gets `write_gated` | `TOOLS.md:99-121` | Has to work out `JIRA_WRITE_MODE=apply` and `apply:true` from CONFIGURATION. No error → fix page (DOC-06) | 5 min |

Happy path: about 20 min. Realistic path with the friction above: 40–50 min. Fixing DOC-02,
-03, -06 and -13 brings the realistic path down to about 20 min.

### (b) Jira site admin deciding whether to allow it

| # | Question | Where they must look | Friction | Time |
|---|---|---|---|---|
| 1 | What is it, and can it destroy data? | README safety line → TOOLS tiers → THREAT-MODEL | Spread over three docs. THREAT-MODEL undercounts the irreversible tier (DOC-05) | 10 min |
| 2 | Whose identity? Can I use a service account? | `AUTH.md:399-438` | Possible (client_credentials), but no scope checklist (DOC-10) | 10 min |
| 3 | Which OAuth scopes, and is there a read-only set? | `AUTH.md:135-231` | Says exhaustive but is not. Default includes `manage:jira-project`. No read-only preset (DOC-10) | 15 min |
| 4 | Can I restrict it to read-only or certain projects? | CONFIGURATION | `reader` profile documented; `JIRA_PROJECTS` absent from every security doc (DOC-09) | 10 min |
| 5 | Where does data go / what is stored on disk? | `THREAT-MODEL.md:362-413` | States "exactly two places", which is false (DOC-04) | 5 min, wrong conclusion |
| 6 | What is the audit trail? | OBSERVABILITY, CONFIGURATION | Two descriptions disagree (DOC-16). Jira-side appearance undocumented (DOC-19) | 10 min |
| 7 | Vulnerability policy | SECURITY.md | Good | 2 min |

Today: 60+ min, ending with at least one false conclusion. With ADMIN-OVERVIEW (DOC-08):
about 15 min, with the deep docs available for a second pass.

## Assessment of the existing roadmap

- **V3-20** (`docs/ROADMAP.md:330`: split DECISIONS into `docs/decisions/Dnnn.md` plus an index,
  archive IMPLEMENTATION-PLAN phases 0–16, split CORNER-CASES by domain; solo, after
  V3-01…V3-19, 4h). **I agree with it as contributor hygiene.** It fixes DOC-20 for DECISIONS
  and shrinks the corpus agents read. But it is **not a documentation fix for users or admins**.
  It touches none of README, the Pages site, CONFIGURATION, AUTH, THREAT-MODEL, CHANGELOG or
  the runtime strings, which is where every P0/P1 above lives. Re-scope its title to
  "Contributor corpus split". Keeping it solo and last is correct, because it renames files
  every other item cites. It must also update the docs-lint cc-ref and owned checks and the
  `docs/README.md` map (DOC-15) in the same commit, or links will break. 4h is plausible if the
  split is scripted. Budget 5h if anchors in TOOLS, AUTH and source comments must be rewritten.
- **V3-22** (release 1.1.0, blocked on the owner, 1.5h) has no docs checklist. Add: the pin
  bump everywhere pin-mirror covers; server.json version and env list (DOC-12); CHANGELOG
  Highlights and Upgrading (DOC-11); clear the "unreleased" markers (DOC-02); refresh the
  site's counts (DOC-01). Re-estimate it at 2h, or make it depend on DOC-R7.
- **V3-16** (Docker; owns the README install section) and **V3-17** (MCPB Desktop bundle) both
  touch the install path that DOC-R2 restructures. Sequence DOC-R2 first, or have V3-16 and
  V3-17 add their tab inside the new per-client structure, so the install section is not
  written three times.
- **V3-23** (distribution / registry): depends on server.json being honest (DOC-12).
- **V3-03** (config drift, done) proves the env-sync approach works. DOC-R1 applies the same
  idea to counts.
- **Missing from the roadmap:** a troubleshooting page, an admin overview, the scope-map
  completion, the THREAT-MODEL data-at-rest correction, the secret-safe quick-start, and a
  count lint. All are proposed below.

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| DOC-R1 | Count and release-marker truth: fix every count; docs-lint `count` check against the manifest; README "Since" column / released-vs-main status; README links in docs-lint | DOC-01, DOC-02, DOC-18 | `README.md` (status box), `scripts/generate-readme.mjs`, `scripts/docs-lint*`, `docs/index.html` (count spans) | — | No | 3 |
| DOC-R2 | Secret-safe per-client quick-start (Claude Code user scope, Claude Desktop, Cursor, VS Code) and a README restructure to the outline below | DOC-03, DOC-13, DOC-14 | `README.md` (install section), `docs/CONFIGURATION.md` §registration, `docs/index.html#install`, `docs/AUTH.md:440-444` | DOC-R1 (same README) | No; sequence it before V3-16/V3-17 | 2.5 |
| DOC-R3 | THREAT-MODEL correction: data-at-rest table of 4 sinks, tier lists bound to the manifest, `JIRA_PROJECTS` control | DOC-04, DOC-05, DOC-09 | `docs/THREAT-MODEL.md` | — | No | 1.5 |
| DOC-R4 | `docs/TROUBLESHOOTING.md` with one anchor per ErrorKind, plus a tag-pinned `docUrl()` helper for doctor, startup and `--help` remediations, with anchor tests | DOC-06, DOC-07 | `docs/TROUBLESHOOTING.md` (new), `src/cli/doctor.ts`, `src/core/settings.ts`, `src/index.ts`, a new helper and test | DOC-R2 (it moves the PATH/log content) | No | 3.5 |
| DOC-R5 | `docs/ADMIN-OVERVIEW.md`: one-page governance (controls matrix, identity, scopes, egress, data at rest, audit, revoke) | DOC-08, DOC-19 | `docs/ADMIN-OVERVIEW.md` (new), README pointer | DOC-R3, DOC-R6 | No | 3 |
| DOC-R6 | AUTH scope map bound to the manifest, plus read-only and core-writes scope presets and a service-account scope checklist; AUTH registration as numbered steps | DOC-10, DOC-20 (AUTH part) | `docs/AUTH.md`, a scope-map test | — | No (Open question 3 may change the default list) | 2.5 |
| DOC-R7 | 1.1.0 release docs: CHANGELOG Highlights / Breaking / Upgrading in user language, internal IDs moved out; server.json env list; docs checklist added to V3-22 | DOC-11, DOC-12 | `CHANGELOG.md`, `server.json`, `docs/ROADMAP.md` (V3-22 row), `RELEASING.md` | DOC-R1 | **Yes**: the owner's V3-22 decision and Open question 2 (semver) | 1.5 |
| DOC-R8 | Audience-split doc map, an accurate journal line, and removal of D-/CC-IDs from user docs and runtime strings, with a lint ban | DOC-15, DOC-16, DOC-17 | `docs/README.md`, `docs/CONFIGURATION.md`, `src/core/settings.ts`, `src/cli/doctor.ts`, `src/tools/issues-write.ts`, `src/tools/meta.ts`, docs-lint | DOC-R4 (shares doctor/settings), before V3-20 | No | 3 |

Total: about 20.5 h. DOC-R1, R2, R3 and R7 (about 8.5 h) are the conditions for 1.1.0.

**Proposed README outline (DOC-R2):**
1. One-line what-it-is, then three safety bullets (plan mode by default, irreversible tier off,
   read-only profile and project scope available).
2. Status: "Latest release X (N tools) · `main` unreleased (M tools)", with generated counts.
3. Quick start in three steps: create a token → `npx jira-mcp-ai@X doctor` → register (tabs for
   Claude Code / Desktop / Cursor / VS Code; token outside project files).
4. "Try this first": three example prompts, one read and one plan-mode write.
5. Safety controls: a table of the five controls with links.
6. Tools: generated, with a "Since" column.
7. Troubleshooting → TROUBLESHOOTING.md. For admins → ADMIN-OVERVIEW.md.
8. Data handling: three lines plus a link to the THREAT-MODEL table.
9. Development → CONTRIBUTING.md. License.

## Open questions for the owner

1. Should `main`'s README describe the **released** surface (generated from the last tag's
   manifest, with unreleased tools in a separate section) or the `main` surface with "Since"
   markers? npm shows the README of the published version, but GitHub shows `main`.
2. The 1.1.0 agile paging change (`paging.total`/`nextStartAt` removed, `startAt > 0` refused)
   breaks callers. Upstream forces it, but is a minor bump acceptable under the project's
   semver policy, or should it ship as 2.0.0?
3. Should the default OAuth scope list stay broad (it includes `manage:jira-project`), or should
   the default follow `JIRA_TOOL_PACKAGES` (a read-only profile gets read-only scopes)?
4. Should agent writes carry a marker in Jira (a User-Agent suffix such as
   `jira-mcp-ai/<version>`, or an opt-in label/comment footer), or is "use a service account"
   the official attribution answer?
5. Should the docs ship in the npm tarball (`files` += `docs/*.md` for the user docs), or are
   tag-pinned GitHub URLs (DOC-R4) enough?
6. Should V3-20's DECISIONS split run **before** the 1.1.0 release (it shrinks the corpus
   agents read during the remaining V3 items), or stay solo and last as planned?
