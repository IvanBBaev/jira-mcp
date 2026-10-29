# DevOps / Release Engineering review — 2026-10-29

Scope: the release, CI and supply-chain side of `jira-mcp-ai` as it stood on `main` on 2026-10-29. Main sat at `6cd07bd`, two commits ahead of `origin/main` and 74 commits ahead of `v1.0.0`. This review does not cover product or code design. Method: everything was read-only. I read the workflows (`ci.yml`, `codeql.yml`, `publish.yml`), `dependabot.yml`, `package.json`, `server.json`, the plugin manifests, `docs/RELEASING.md`, `docs/ROADMAP.md`, `CHANGELOG.md` and `WORKLOG.md`. I ran read-only `gh api` GET calls for repository settings, branch protection, rulesets, environments, variables, secret *names*, Actions permissions, runs, releases and tags. I ran `npm view jira-mcp-ai` for the registry state and `npm audit --omit=dev` locally. I ran `git merge-tree` as a dry run to test whether a 1.0.1 hotfix could be cherry-picked. I did not build, test, publish or change anything. Any claim that rests on inference rather than a command is marked as inferred.

## Verdict

| Decision | Verdict | Condition |
|---|---|---|
| Ship `main` as 1.1.0 | CONDITIONAL GO | Three things first: confirm the publishing credential works (register the trusted publisher, or prove `NPM_TOKEN` is still valid); run a live read smoke of `/rest/software/1.0` (V3-21) under the auth mode users actually run; get `npm run check` green on the exact release commit. |
| The v3 plan (ROADMAP V3-xx) | CONDITIONAL GO | Add the missing release-infrastructure items (OPS-R1…R4) ahead of V3-16/17/23, and move V3-15 (de-flake) to the front. |

The release machinery is well above average for a one-maintainer package:
- actions are SHA-pinned;
- provenance is on;
- a tarball allowlist is enforced;
- version pins are machine-checked;
- a tag/version guard runs before publish.

The weak points are around that machinery, not in it. Publishing still depends on a bootstrap granular token that is repo-scoped, two months old and very likely close to npm's 90-day cap. Nothing on GitHub protects `main`, `v*` tags or the `release` environment. The only live safety net, the weekly `live` job, skips silently and still shows green, because no Jira secrets exist anywhere. With the 2026-11-01 removal of `/rest/agile/1.0` sprint routes, the real release risk is not packaging. The risk is shipping V3-01 without having seen `/rest/software/1.0` answer once, in a release whose credential may stop working on the day it is needed.

## Strengths

- **SHA-pinned actions with version comments.** checkout `3d3c42e…` (v7.0.1), setup-node `949feb2…` (v7.1.0) and codeql-action `24c5418…` (v4.38.3) are pinned in all three workflows. Dependabot's github-actions ecosystem keeps them moving (`.github/dependabot.yml`).
- **Least-privilege tokens.** Every workflow sets top-level `permissions: contents: read`. `id-token: write` exists only on the publishing job (`publish.yml:94`) and `security-events: write` only on the CodeQL job. The repo default workflow permission is read, and Actions cannot approve PRs (`gh api repos/IvanBBaev/jira-mcp/actions/permissions/workflow`).
- **Provenance actually lands.** `npm view jira-mcp-ai@1.0.0` shows an SLSA v1 provenance attestation, gitHead `e440ab2`, 121 files and `mcpName` `io.github.IvanBBaev/jira-mcp-ai`. `publishConfig.provenance: true` is set in `package.json`, and `--provenance` is passed in `publish.yml:179-180`.
- **Layered pre-publish guards in `publish.yml`:**
  - the `PUBLISH_ENABLED` kill switch (`:86`);
  - a per-ref concurrency group with no cancellation;
  - an npm >= 11.5.1 assertion;
  - the full gate (`:133`);
  - the tarball allowlist (`:138`);
  - a tag == `package.json` version guard (`:143-152`);
  - `--tag beta` for prerelease tags, so a prerelease never becomes `latest` (`:179`).
- **Tarball hygiene is enforced, not hoped for.** `scripts/check-tarball.mjs` checks four finding kinds: forbidden, missing, unexpected and dangling `sourceMappingURL`. `tsconfig.publish.json` strips maps for the published build. The `files` allowlist excludes tests, `build/testing` and `build/core/fakes`.
- **Version drift is caught by machine.** `src/manifest-sync.test.ts` keeps five manifest version fields in sync: `package.json`, `server.json` ×2 and the plugin/marketplace files. docs-lint check 5 pins eight more places. RELEASING.md §2 documents all 13.
- **Dependency intake is deliberate:**
  - weekly Dependabot with a 7-day `cooldown`, which limits the fresh-malicious-release window;
  - grouped minor/patch updates;
  - explicit ignores for TypeScript >= 6.1 and `@types/node` majors;
  - `npm audit --omit=dev --audit-level=high` inside `npm run check`;
  - `engine-strict=true` in `.npmrc`.
- **Release documentation is unusually honest.** RELEASING.md §4 names the point of no return, and §5 keeps a per-release ledger (run IDs, durations, file counts) of 0.9.0, 0.9.4, 1.0.0-beta.1 and 1.0.0. All four tags are annotated and pushed, and `v1.0.0` is an ancestor of `main`.
- **Static analysis covers the workflows too.** CodeQL advanced setup runs `javascript-typescript` and `actions` with `security-extended` (`.github/workflows/codeql.yml`).
- **The bin shim fails clearly.** `bin/jira-mcp-ai.cjs` is a CJS Node >= 22 guard, so users on an old Node get a readable error instead of an ESM syntax crash.

## Findings

| ID | Sev | Finding | Evidence | Recommendation | Est h |
|---|---|---|---|---|---|
| OPS-01 | P0 | Publishing still depends on the bootstrap `NPM_TOKEN`. It is repo-scoped, created 2026-08-17, and very likely near npm's 90-day cap. The trusted publisher is not registered. | `gh api …/actions/secrets` lists only `NPM_TOKEN` (2026-08-17). `publish.yml:167-171`. RELEASING.md §5 `:246-264`: token retirement is open, plus the 2FA-bypass restriction notice. | Register the npm trusted publisher (`publish.yml`, environment `release`), do a beta or rehearsal publish via OIDC, then delete the secret and revoke the token. | 1 (plus owner clicks) |
| OPS-02 | P0 | V3-01 moves every sprint/board call to `/rest/software/1.0` with no runtime fallback, and it has never been exercised live. The weekly live job cannot catch it because it skips silently and still shows green. | ROADMAP V3-21 `:331` is blocked-external ("a 403 has been reported"). D500 defers the fallback. `ci.yml:94,115-122`. No JIRA_* secrets at repo or `live`-environment level. Run 40305781634 shows "Run live read suite: skipped", 18 s, conclusion success. | Before tagging, run `scripts/verify-live.mjs` (reads only) against the owner's tenant under Basic and scoped-token auth. Make the live job fail, or at least warn loudly, when credentials are missing on `schedule`. | 1.5 |
| OPS-03 | P1 | The publish job runs `npm ci`, the full gate and all devDependency code twice while it holds `id-token: write` and the npm token sits in the npm config. | `publish.yml:94,124,133,171,179`. `package.json` `prepublishOnly` = `check:publish && build:publish && tarball:publish`, so `npm publish` re-runs the gate after the auth token has been set. | Split into a `build` job (no `id-token`; gate plus `npm pack`, upload the artifact) and a `publish` job (`id-token: write` only; download the tarball, run `npm publish <tgz> --provenance --ignore-scripts`). | 2.5 |
| OPS-04 | P1 | `main`, `v*` tags and the `release` environment have no protection at all. | `branches/main/protection` returns 404 "Branch not protected". `rulesets` is `[]`. Environments `release` and `live` have no protection rules and no deployment branch/tag policy (`…/environments/release/deployment-branch-policies` returns 404). `allowed_actions: all`, `sha_pinning_required: false`. WORKLOG: main was red on CI on 2026-10-23. | A ruleset on `main` (required status checks `check (22.x)`/`check (24.x)`, no force-push or delete). A tag ruleset on `v*` (creation restricted to the owner). `release` environment limited to `v*` tags, with a required reviewer. Turn on `sha_pinning_required`. | 1 |
| OPS-05 | P1 | GitHub security features are off, and SECURITY.md promises one of them. | Repo JSON: secret scanning, push protection and Dependabot security updates are disabled. `private-vulnerability-reporting` is `{"enabled":false}`, yet `SECURITY.md:30` tells reporters to use "Report a vulnerability". `vulnerability-alerts` returns 404. RELEASING.md `:30` was "verified 2026-08-17". | Enable PVR, secret scanning plus push protection, Dependabot alerts and security updates. Re-verify RELEASING §1 and date it. | 0.5 |
| OPS-06 | P1 | `audit:prod` inside the gate turns advisory timing into merge and release outages. | 2026-10-24/25: the zod high advisory failed the gate with 0 test failures (WORKLOG). Dependabot PRs #20/#21 are red at the audit step and stranded. `publish.yml:133` runs the same gate, so a new advisory on release day blocks the publish. | Keep the audit, but as a separate named CI job, plus a reviewed `audit-allowlist` (GHSA ID, reason, expiry) that the gate reads. The publish job fails only on advisories that are not allowlisted. | 2 |
| OPS-07 | P1 | The 1.1.0 release contains an output-field removal (`paging.total`, `paging.nextStartAt`; `startAt > 0` refused on Cloud) that the CHANGELOG does not flag as a breaking upstream change. | `CHANGELOG.md:177`. D501 labels it "additive". | Add a "Breaking upstream change (Atlassian CHANGE-3193)" callout at the top of 1.1.0, with migration advice. Ship as 1.1.0, not 1.0.1. | 0.5 |
| OPS-08 | P1 | A 1.0.1 hotfix of V3-01 alone is not a cherry-pick. It is a re-port, and it would also fail the release audit. | `git merge-tree v1.0.0 … 7f2b923` gives conflicts in 13 of 19 files, four of them modify/delete (`src/mcp/project-scope.ts(+test)` and `src/tools/sprint-summary.ts(+test)` do not exist at v1.0.0). The v1.0.0 lockfile has zod 4.6.5, fast-uri 3.1.8 and ip-address 10.7.3; the advisory fixes are in 6da3851/db5d8b9/0c9f5ba. | Drop the 1.0.1 option from V3-22 unless the owner must freeze the tool surface. If it is needed: a `release/1.0.x` branch from `v1.0.0`, cherry-pick the three lockfile commits, then hand-port V3-01 (3–5 h). | — (decision) |
| OPS-09 | P2 | The plugin marketplace serves `plugin.json` from the default-branch HEAD. Pushing the version bump before the npm publish makes `npx -y jira-mcp-ai@<new>` 404 for plugin users. | `.claude-plugin/marketplace.json:12` `"source": "./"`. `plugin.json` pins `jira-mcp-ai@1.0.0`. RELEASING §3 order: bump commit, push, CI green, tag. | Either push the bump and the tag together (publish runs within ~2 min), or pin the marketplace `source` to a tag/ref updated after publish. Document the window in RELEASING §3. | 1 |
| OPS-10 | P2 | The release produces no GitHub Release and no MCP Registry entry, though `server.json` is ready. | `gh release list` is empty. `publish.yml` has no `mcp-publisher` step. `server.json` version 1.0.0, never published. | After `npm publish`, add steps: `mcp-publisher login github-oidc && mcp-publisher publish`, and `gh release create v$VER --notes-file <changelog section>` with the tarball attached. | 1.5 |
| OPS-11 | P2 | Dependabot PRs go stale. CodeQL is one minor behind, and there is no rebase or merge policy. | PRs #20 (codeql-action 4.38.3 → 4.39.1) and #21 (npm minor/patch) are open and red since 2026-10-25. Stale remote `dependabot/*` branches. `delete_branch_on_merge: false`. | Ask `@dependabot rebase` after OPS-06. Merge actions groups weekly. Enable `delete_branch_on_merge`. Prune stale branches. | 0.5 |
| OPS-12 | P2 | Consumers resolve dependencies fresh (no shrinkwrap; `^1.30.0` SDK range), but CI tests only the lockfile's 1.32.1. Nothing smokes the packed tarball installed clean. | `package.json` dependencies. `npm ls`: SDK 1.32.1, `@hono/node-server` 2.1.0. `npm audit --omit=dev`: 1 moderate (`@hono/node-server`). | A CI job that does `npm pack`, installs the tgz into an empty dir without the lockfile, and runs an MCP `initialize` plus `tools/list` handshake over stdio. Optionally a lower-bound job with the SDK pinned to 1.30.0. | 2 |
| OPS-13 | P2 | The gate is slow and flaky under the parallel-worktree merge flow, and the flow has been bypassed. | WORKLOG: 2908 tests. Flakes CC-149/CC-1105 under load average ~55–90. On 2026-10-29 V3-02/03/04 were stranded and merged by hand `--no-ff`, which the ff-only merge script never does. CI run 40939847013 took 8.7 min wall clock. `ci.yml:52-55` says the coverage job "proves nothing the matrix does not". | Do V3-15 first. Drop or fold the redundant coverage job. Record in RELEASING how a stranded branch is landed. | 1 |
| OPS-14 | P2 | The V3-16/17/23 distribution items lack supply-chain acceptance criteria. | ROADMAP `:326,327,333` (D520/D521) do not mention digest pinning, a non-root user, SBOM/provenance attestations, multi-arch or OIDC-only credentials. | Add the criteria in the detailed section below to those rows. | 0.5 |
| OPS-15 | P3 | Release-notes hygiene. | `CHANGELOG.md:168` "59 tools, 29 reads" (main serves 82 tools). `[Unreleased]` runs to ~200 lines with no summary. | Fix the count and add a five-line "Highlights" block at the top of 1.1.0. | 0.5 |
| OPS-16 | P3 | No post-release observability. | Registry: 68 downloads/month, 1 maintainer. No release checklist step to check the provenance badge, `npx` cold start or the issue tracker after publish. | Add a RELEASING §4.1 "after publish" checklist (`npm view`, `npm audit signatures`, an `npx -y jira-mcp-ai@<v> --version` cold run, plugin install). | 0.5 |

## Detailed findings

### OPS-01 — Bootstrap `NPM_TOKEN` is still the publishing credential

**What.** Every publish so far used the `NPM_TOKEN` repository secret, and so would 1.1.0. RELEASING.md §5 (`:246-264`) records the plan:
1. register the trusted publisher;
2. delete the secret;
3. revoke the token.

None of the three has happened. `gh api repos/IvanBBaev/jira-mcp/actions/secrets` shows `NPM_TOKEN` as the only secret, updated 2026-08-17T18:27Z. It is a repo-level secret, not a `release`-environment secret, so any workflow on any ref can read it. `publish.yml:169-171` prefers the token whenever it is present.

**Why it matters.** *Inferred, not verified:* npm granular write tokens have a maximum lifetime of 90 days. A token created on 2026-08-17 would therefore expire by about 2026-11-15, possibly earlier if a shorter expiry was chosen. npm also already printed a warning that tokens which bypass 2FA are restricted for direct publishing (RELEASING `:246`). If the token has expired, or the restriction is enforced, the 1.1.0 publish fails after the tag is pushed. That leaves a tag with no package, around the Atlassian deadline. A long-lived publish token in a repo-scoped secret is also the main supply-chain exposure of this repository.

**Recommendation.**
1. Register a trusted publisher on npmjs.com: repository `IvanBBaev/jira-mcp`, workflow `publish.yml`, environment `release`.
2. Delete the `NPM_TOKEN` secret, so the workflow takes the OIDC branch (`:173`).
3. Prove OIDC publishing with a `1.1.0-rc.1` on the `beta` dist-tag, or with the real 1.1.0.
4. Revoke the token on npmjs.com.
5. Optionally set the npm package to "require 2FA and disallow tokens" once OIDC works.

**Acceptance.**
- `gh api …/actions/secrets` lists no `NPM_TOKEN`.
- The publish log shows the "Trusted publishing" notice.
- `npm view jira-mcp-ai@<v>` shows provenance.
- RELEASING §5 closes the bullet with a date.

### OPS-02 — `/rest/software/1.0` is unproven live, and the live job hides that

**What.**
- V3-01 (7f2b923) moved sprint/board routes to `/rest/software/1.0`. There is no fallback to `/rest/agile/1.0` (D500 defers it to V3-21).
- V3-21 (`ROADMAP.md:331`) is `blocked-external` and notes "a 403 has been reported" under some auth kinds.
- The CI `live` job (`ci.yml:94-123`) has two branches: the read suite runs only `if: env.JIRA_API_TOKEN != ''` (`:115`), otherwise "Report missing credentials" (`:121-122`) runs and the job succeeds.
- No JIRA_* secrets exist at repo level or in the `live` environment, so every weekly run looks green but tests nothing (run 40305781634: read suite *skipped*, 18 s).

**Why it matters.** This is the one change the 1.1.0 release exists for. If `/rest/software/1.0` returns 403 for API-token Basic auth, or for scoped tokens, 1.1.0 breaks every sprint tool for those users. And from 2026-11-01, 1.0.0 breaks them anyway. A green-but-empty live job gives false assurance to anyone reading the Actions tab.

**Recommendation.** Before tagging, the owner runs `node scripts/verify-live.mjs` (the read half only) from a laptop against the test tenant, under Basic auth, then a scoped token. Record the result in RELEASING §5 or under V3-21. In CI, either add the JIRA_* secrets to the `live` environment, or make a scheduled run without credentials fail or emit `::warning::` and set a non-success job summary, so "not run" stops looking like "passed".

**Acceptance.**
- A recorded live run that lists `get_sprint`/`list_sprints`/`get_board` (or equivalents) as OK under at least Basic auth.
- The `live` job is either really running, or its absence shows up as something other than success.

### OPS-03 — Publish job runs untrusted-surface code while holding publish credentials

**What.** A single job holds `id-token: write` (`:94`) and runs these steps in order:
1. `npm ci` (`:124`), which executes the install scripts of every devDependency;
2. the full gate (`:133`);
3. `npm config set …_authToken` (`:171`);
4. `npm publish` (`:179-180`).

Step 4 triggers `prepublishOnly` (`check:publish && build:publish && tarball:publish`). That re-runs typecheck, lint, the c8-instrumented test suite and docs-lint, with the token already written to the npm config and the OIDC request token in the environment.

**Why it matters.** Any compromised devDependency (eslint plugin, c8, typescript, prettier and so on) executes in a process that can mint an OIDC token for npm or read the npm auth token. The 7-day Dependabot cooldown lowers this risk but does not remove it. Running the gate twice also adds time and flake surface at the point of no return.

**Recommendation.**
- Job `build`: `contents: read`, no `id-token`. Steps: `npm ci`, `npm run check`, `npm run build:publish`, `npm run tarball:publish`, `npm pack`, then upload the `.tgz` with its sha256.
- Job `publish`: `needs: build`, `environment: release`, `id-token: write`. Steps: setup-node, download the artifact, verify the sha256, `npm publish ./jira-mcp-ai-<v>.tgz --provenance --access public --ignore-scripts`.
- No checkout and no `npm ci` in `publish`. Provenance still binds to the workflow run.

**Acceptance.**
- The publish job's log shows no `npm ci` and no lifecycle scripts.
- `id-token: write` appears only on the publish job.
- A `workflow_dispatch` rehearsal still stops before `npm publish`.

### OPS-04 — No protection on `main`, `v*` tags or the `release` environment

**What.**
- `gh api repos/IvanBBaev/jira-mcp/branches/main/protection` returns 404 "Branch not protected", and `rulesets` returns `[]`.
- Environments `release` and `live` have no protection rules and no deployment branch or tag policies.
- Actions settings: `allowed_actions: all`, `sha_pinning_required: false`.
- WORKLOG records that main's CI was red after the roadmap commit (2026-10-23), and the 2026-10-29 `--no-ff` merges landed outside the scripted ff-only flow.

**Why it matters.** The publish trigger is `push tags v*`. Today any credential with `contents: write` (a leaked PAT, a future collaborator, a mis-scoped app) can push a tag that publishes. Pinning is a convention, not a rule, so a future `uses: foo@v1` would pass. A red main is one push away from becoming a release.

**Recommendation.**
- Branch ruleset on `main`: block force-push and deletion; require status checks `check (22.x)` and `check (24.x)` (the owner can bypass for local ff-merges, but the push is still recorded).
- Tag ruleset on `v*`: restrict creation, update and deletion to the owner.
- `release` environment: deployment policy limited to tags `v*`, plus the owner as required reviewer (one click per release, and it also stops a mistaken tag).
- Set `sha_pinning_required: true`.

**Acceptance.** The `gh api` reads return a ruleset for each, a `release` policy of type tag `v*`, and `sha_pinning_required: true`.

### OPS-05 — Security features disabled; SECURITY.md promises one of them

**What.**
- The repository JSON shows secret scanning, push protection and Dependabot security updates disabled.
- `private-vulnerability-reporting` returns `{"enabled":false}`, and `vulnerability-alerts` returns 404 (off).
- `SECURITY.md:30` tells reporters to use the "Report a vulnerability" button, which does not exist while PVR is off.
- RELEASING §1 (`:30`) says its settings table was "verified 2026-08-17".

**Why it matters.** This is a public repository whose CLAUDE.md records a credential pasted into chat. Push protection is the cheap backstop against committing one. A reporter following SECURITY.md finds no channel.

**Recommendation.** Enable all five features (free on public repositories), re-run RELEASING §1.1 and date the table.

**Acceptance.** `gh api repos/IvanBBaev/jira-mcp/private-vulnerability-reporting` returns `enabled: true`, and `security_and_analysis.*.status` reads `enabled` for secret scanning and push protection.

### OPS-06 — The audit inside the gate couples merges and releases to advisory timing

**What.** `npm run check` ends with `audit:prod` (`npm audit --omit=dev --audit-level=high`).
- On 2026-10-24/25 a new zod advisory (high at the time) made the gate red with zero test failures.
- Dependabot PRs #20/#21 have been red at that step ever since.
- `publish.yml:133` runs the same gate, so a high advisory published on release morning blocks the release, even when it does not affect this package's reachable code and there is no fix yet.

**Why it matters.** A deadline-bound release (2026-11-01) should not depend on a network call to the advisory database that has no override.

**Recommendation.**
- Keep `check:publish` (no network) as the gate everywhere.
- Run the audit as its own CI job (and a release-job step) that reads a committed `audit-allowlist.json` of `{ghsa, reason, expires}` entries, failing on unlisted high/critical advisories or on expired entries.
- Document the override in RELEASING §3.

**Acceptance.**
- The new advisory scenario can be unblocked by a reviewed one-line allowlist commit that expires.
- Local `npm run check` still reports the audit result.

### OPS-07 — 1.1.0 removes output fields without a breaking-change callout

**What.** `CHANGELOG.md:177`: on Cloud, `paging.total` and `paging.nextStartAt` are no longer returned, and `startAt > 0` is refused. D501 calls this "additive".

**Why it matters.** Agents and scripts that read `paging.total` will see `undefined`. Upstream forces it (CHANGE-3193), and that justifies doing it inside 1.x, but users should be told that loudly.

**Recommendation.** Ship as **1.1.0**. Open the release section with a "Breaking upstream change" note that names the fields, explains why, and says what to use instead (cursor or `nextPageToken`-style continuation).

**Acceptance.** The 1.1.0 section has the callout above its Added list, and the GitHub Release body (OPS-10) repeats it.

### OPS-08 — The 1.0.1 hotfix path is a re-port, not a cherry-pick

**What.** `git merge-tree --write-tree v1.0.0` against V3-01 (7f2b923, 19 files) conflicts in 13 files. Four are modify/delete: `src/mcp/project-scope.ts`, `src/tools/sprint-summary.ts` and their tests do not exist at v1.0.0.

Separately, the v1.0.0 lockfile pins zod 4.6.5, fast-uri 3.1.8 and ip-address 10.7.3, whose advisories were fixed only after the tag (6da3851, db5d8b9, 0c9f5ba). The `audit:prod` step in `publish.yml` would therefore fail a 1.0.1 built from `v1.0.0` unless those three commits are cherry-picked too.

**Why it matters.** V3-22 lists "or V3-01 alone as 1.0.1" as an equal option. It is not equal:
- it means hand-porting about 6 conflicting source files under deadline;
- it ships code that differs from what the 2908-test gate validated on main;
- it still needs a parallel release branch and its own CI.

**Recommendation.** Release 1.1.0 from main. Take the 1.0.1 path only if the owner explicitly needs to freeze the 1.0 tool surface, and then budget 3–5 h on a `release/1.0.x` branch.

**Acceptance.** Not applicable. This is a decision; see question 2.

### OPS-09 — Plugin pin points at an unpublished version during the release window

**What.** `.claude-plugin/marketplace.json:12` uses `"source": "./"`, so Claude Code plugin installs read `plugin.json` from the default branch. `plugin.json` runs `npx -y jira-mcp-ai@<version>`. RELEASING §3 pushes the bump commit first, waits for CI, and only then tags and publishes.

**Why it matters.** Between the bump push and the publish (CI time plus human time, which can be hours), every new plugin install or update fails with an npm 404.

**Recommendation.** Push the bump commit and the tag in one `git push --atomic origin main v1.1.0`. CI on main and the publish run in parallel, and the publish job runs the full gate anyway. Alternatively, make the marketplace entry point at a released tag. State the window in RELEASING §3.

**Acceptance.** RELEASING §3 documents the atomic push. After the next release, the window between main HEAD showing `1.1.0` and `npm view` showing `1.1.0` is under 5 minutes.

### OPS-10 — No GitHub Release, no MCP Registry publish

**What.** `gh release list` is empty for all four tags. `server.json` is complete (schema 2025-12-11, version-synced by `manifest-sync.test.ts`), but no workflow publishes it. The npm package already carries `mcpName`, which the registry uses to verify ownership.

**Why it matters.** The official MCP Registry and the downstream catalogs (V3-23) read from it. GitHub Releases are where people and Dependabot look for release notes.

**Recommendation.** Add two steps after `npm publish` in the publish job:
1. `mcp-publisher login github-oidc` and `mcp-publisher publish`. This reuses `id-token: write`, so no new secret is needed. Pin the publisher binary by checksum.
2. `gh release create "$TAG" --notes-file <extracted CHANGELOG section> <tgz>`. This needs `contents: write` scoped to that step's job, or a separate job.

Also backfill a v1.0.0 Release.

**Acceptance.**
- The registry lists `io.github.IvanBBaev/jira-mcp-ai` at 1.1.0.
- `gh release view v1.1.0` exists with the CHANGELOG body and the tarball attached.

### OPS-11 — Dependabot hygiene

**What.**
- PR #20 bumps codeql-action 4.38.3 → 4.39.1, and PR #21 is the npm minor/patch group. Both have been red at the audit step since 2026-10-25 and were never rebased.
- Stale `dependabot/*` and `oauth-3lo` remote branches exist.
- `delete_branch_on_merge` is false.

**Recommendation.**
- After OPS-06, comment `@dependabot rebase` on both PRs and merge them.
- Turn on `delete_branch_on_merge`.
- Delete the merged or abandoned remote branches; keep `oauth-3lo` only if it is live work.

**Acceptance.** No open Dependabot PR is older than a week, and the remote branch list shows only `main` plus active work.

### OPS-12 — No clean-install smoke of the shipped tarball

**What.**
- There is no `npm-shrinkwrap.json`, so users get whatever `^1.30.0` / `^4.6.5` resolve to on install day.
- CI only tests the lockfile (SDK 1.32.1).
- `check-tarball.mjs` proves the file list, not that the package starts.
- `npm audit --omit=dev` currently reports 1 moderate in `@hono/node-server` (an SDK transitive dependency).

**Why it matters.** An SDK minor release that breaks the stdio handshake would reach users while CI stays green. A missing runtime file that the allowlist does not list would ship.

**Recommendation.** Add a CI job:
1. `npm run build:publish && npm pack`;
2. in a temp dir, `npm init -y && npm i ../jira-mcp-ai-*.tgz` with no lockfile;
3. spawn `node_modules/.bin/jira-mcp-ai` and complete MCP `initialize` and `tools/list` over stdio, asserting the tool count;
4. optionally a second variant with `@modelcontextprotocol/sdk@1.30.0` forced, to prove the declared lower bound.

**Acceptance.** The job is green on main and is listed as a required check in OPS-04.

### OPS-13 — Gate cost and flakiness under the parallel merge flow

**What.**
- 2908 tests run under c8.
- WORKLOG records flakes (CC-149, CC-1105) at load average ~55–90 when several worktree gates run together.
- On 2026-10-29 three branches were stranded and merged by hand `--no-ff`, outside the merge-lock script (`start.mjs`: rebase, gate under lock, `--ff-only`).
- CI run 40939847013 took about 8.7 min, with jobs queued one after another.
- `ci.yml:52-55` itself says the coverage job "proves nothing the matrix does not".

**Why it matters.** A flaky gate under the merge lock wastes the lock slot. A flaky gate in `publish.yml` can fail a release at the last step.

**Recommendation.**
- Do V3-15 first.
- Delete the separate coverage job, or make it run only on schedule.
- Add a RELEASING or ROADMAP note on how a stranded branch is landed, so history stays linear.

**Acceptance.**
- 10 consecutive gate runs at a load average of about 50 with no flake.
- CI on main finishes in under 4 min wall clock.

### OPS-14 — Distribution items need supply-chain acceptance criteria

**What.** V3-16 (Docker, D520), V3-17 (MCPB, D521) and V3-23 (registry, ghcr, Docker MCP Catalog) state their deliverables but not their supply-chain properties.

**Recommendation.** Make these acceptance criteria explicit:
- **V3-16:**
  - base image pinned by digest (`node:24-alpine@sha256:…`), managed by Dependabot `docker`;
  - multi-stage build that installs from the packed tarball with `--omit=dev --ignore-scripts`;
  - non-root `USER node`;
  - `linux/amd64,linux/arm64`;
  - `docker/build-push-action` with `provenance: mode=max` and `sbom: true` (build only in V3-16);
  - all actions SHA-pinned;
  - stdio by default; HTTP transport only behind an explicit env var, binding loopback unless overridden.
- **V3-17:** the `.mcpb` is built from the same tarball, its sha256 is recorded, and it is uploaded to the GitHub Release (OPS-10).
- **V3-23:** ghcr push via `GITHUB_TOKEN` with `packages: write` on that job only, and MCP Registry via GitHub OIDC. No new long-lived secret. Docker MCP Catalog submission happens only after the image has a provenance attestation.

**Acceptance.** The ROADMAP rows reference these criteria (or a D-entry), and the workflows meet them.

### OPS-15 — CHANGELOG count drift and missing highlights

**What.** `CHANGELOG.md:168` says "59 tools, 29 reads", while the server on main exposes 82 tools. `[Unreleased]` runs to about 200 lines (Added 15–170) with no summary.

**Recommendation.** Correct the count (or drop it; docs-lint pins counts elsewhere). Add a short "Highlights" block and the OPS-07 callout at the top of 1.1.0.

**Acceptance.** No stale tool count remains in the 1.1.0 section.

### OPS-16 — No post-release verification checklist

**What.** RELEASING §5 records the publish runs, but there is no standard set of checks after publish.

**Recommendation.** Add RELEASING §4.1:
- `npm view jira-mcp-ai@<v> dist-tags dist.attestations`;
- `npm audit signatures` in a scratch install;
- `npx -y jira-mcp-ai@<v>` cold start (the handshake from OPS-12);
- a plugin install from the marketplace;
- registry lookup;
- `gh release view`.

**Acceptance.** The 1.1.0 entry in §5 records each check.

## Recommended release plan

Target: `jira-mcp-ai@1.1.0` from `main` before 2026-11-01. Do not take the 1.0.1 re-port path (OPS-08).

1. **Freeze `main` for release.** Finish or park in-flight V3 worktrees. Pick the release commit, which must include V3-01 7f2b923, V3-06 and the two unpushed commits `306d322` and `6cd07bd`.
2. **Credential check (OPS-01), on 2026-10-30.** On npmjs.com, check the `NPM_TOKEN` token's expiry date. Register the trusted publisher (`IvanBBaev/jira-mcp`, `publish.yml`, environment `release`). Do not delete the secret yet if there is no time for a rehearsal: the workflow prefers the token if it is present (`publish.yml:169`). If the token has already expired, delete the secret now so the run takes the OIDC branch.
3. **Live smoke (OPS-02).** Run the read half of `scripts/verify-live.mjs` against the owner's tenant under Basic auth, and under a scoped token if one exists. If `/rest/software/1.0` returns 403 under Basic auth, **stop**: 1.1.0 needs the V3-21 fallback before it ships, and the fallback becomes the critical path.
4. **Quick hardening (about 30 min, owner clicks, OPS-04/05).** Restrict the `release` environment to `v*` tags with the owner as reviewer. Add a tag ruleset for `v*`. Enable PVR, secret scanning and push protection.
5. **Release commit.**
   - Bump the 5 manifest fields and 8 pins to 1.1.0 (RELEASING §2).
   - Date the CHANGELOG section.
   - Add the "Breaking upstream change" callout (OPS-07) and fix the "59 tools" line (OPS-15).
   - Optionally `npm audit fix` for the moderate `@hono/node-server` advisory.
   - Then run `npm run check` locally and confirm it is green.
6. **Rehearsal.** Run a `workflow_dispatch` of `publish.yml` on that commit. It runs everything up to `npm publish` and catches advisory or gate surprises before the tag exists.
7. **Atomic push (OPS-09).** `git push --atomic origin main v1.1.0` (an annotated tag). Approve the `release` environment, then watch the run.
8. **Verify.** `npm view jira-mcp-ai` shows `latest` = 1.1.0 with provenance. Cold-start with `npx -y jira-mcp-ai@1.1.0`, install the plugin, and record the run in RELEASING §5.
9. **Retire the token.** If step 7 used `NPM_TOKEN`, delete the secret and revoke the token now. The next release proves OIDC.
10. **Post-release.**
    - Create the GitHub Release for v1.1.0 (and backfill v1.0.0) by hand.
    - Publish `server.json` with `mcp-publisher` by hand.
    - Rebase and merge Dependabot #20/#21.

**Fallback.** If step 3 or 6 turns up a blocker that cannot be fixed by 10-31, publish `1.1.0-rc.1` on the `beta` dist-tag (the workflow already routes `-` tags there). Tell sprint-tool users to pin `@beta`, and promote it with `npm dist-tag add` once the fix lands. Do not move `latest` on an unproven route.

## Assessment of the existing roadmap

- **V3-22 (release 1.1.0): agree, re-scope.**
  - Remove the "or V3-01 alone as 1.0.1" alternative (OPS-08), unless the owner decides otherwise.
  - Add hard prerequisites: OPS-R1 (credential) and the V3-21 live read.
  - 1.5 h is right for the release itself; the prerequisites are listed separately.
- **V3-21 (live check of software routes): reorder to the front, and re-scope.** It is not "blocked-external" for the Basic-auth case: the owner can run it today against the test tenant. Split it into:
  - (a) Basic/scoped-token reads, a release prerequisite of 0.5 h;
  - (b) OAuth 3LO, which can follow later.

  If (a) shows a 403, the fallback D500 deferred becomes P0 for 1.1.0.
- **V3-15 (de-flake): reorder to first.** It is 1 h and makes every later merge-lock slot and the publish gate more reliable (OPS-13).
- **V3-16 (Docker): agree, add criteria.** Build-only first is the right split. Add the OPS-14 supply-chain criteria. It should come after OPS-R2, so the image is built from the same packed tarball that npm gets.
- **V3-17 (MCPB): agree, add criteria.** It should upload to the GitHub Release that OPS-R2 creates. Without that, there is nowhere to distribute the bundle.
- **V3-23 (distribution): agree, re-scope.**
  - The MCP Registry part needs no new credentials (GitHub OIDC) and can move ahead of V3-16 as part of OPS-R2.
  - ghcr and the Docker MCP Catalog stay behind V3-16.
  - It should state that no new long-lived secret is created.
- **V3-24 (2.0 renames): agree, defer until after 1.1.0.** That is the point where OPS-R4 (audit policy) and OPS-R6 (consumer smoke) should already protect it. A 2.0 with renamed tools is exactly what the clean-install handshake test should guard.
- **Missing from the roadmap:**
  - trusted-publishing migration and token retirement (open since 2026-08, only in RELEASING §5);
  - repository and release-environment hardening;
  - a publish-job split;
  - GitHub Release creation;
  - an honest live job;
  - an audit override policy;
  - a packed-tarball smoke test;
  - Dependabot hygiene.

  These are OPS-R1…R8 below.

## Proposed roadmap items

| Proposed ID | Item | Why (finding IDs) | Owns (files) | Deps | Blocked? | Est h |
|---|---|---|---|---|---|---|
| OPS-R1 | Trusted publishing: register the npm trusted publisher, prove an OIDC publish, delete `NPM_TOKEN`, revoke the token, close RELEASING §5 | OPS-01 | `docs/RELEASING.md` (§5), npm/GitHub settings | — | blocked-owner (npmjs.com and GitHub settings) | 1 |
| OPS-R2 | Publish pipeline v2: split build and publish jobs, publish the packed tgz with `--ignore-scripts`, add a GitHub Release and an `mcp-publisher` OIDC step | OPS-03, OPS-10, OPS-07 | `.github/workflows/publish.yml`, `docs/RELEASING.md` (§3–§4) | OPS-R1 | no (code); first real run needs a release | 3.5 |
| OPS-R3 | Repo hardening: `main` ruleset, `v*` tag ruleset, `release` environment tag policy plus reviewer, `sha_pinning_required`, PVR, secret scanning, push protection, Dependabot alerts; re-verify RELEASING §1 | OPS-04, OPS-05 | `docs/RELEASING.md` (§1), GitHub settings | — | blocked-owner (settings) | 1 |
| OPS-R4 | Audit policy: move `audit:prod` to its own CI job with an expiring `audit-allowlist.json`; keep the publish job failing only on unlisted high/critical | OPS-06, OPS-11 | `package.json` (scripts), `scripts/audit-gate.mjs` (new), `audit-allowlist.json` (new), `.github/workflows/ci.yml`, `.github/workflows/publish.yml` (audit step only) | — (coordinate with OPS-R2 on `publish.yml`) | no | 2 |
| OPS-R5 | Honest live job: JIRA_* secrets scoped to the `live` environment, a missing-credentials run on `schedule` reported as a warning or failure, read-only scope enforced | OPS-02 | `.github/workflows/ci.yml` (`live` job), `docs/TESTING.md` (live section) | V3-21a | blocked-owner (secrets) | 1 |
| OPS-R6 | Packed-tarball clean-install smoke plus SDK lower-bound job | OPS-12 | `.github/workflows/ci.yml` (new job), `scripts/smoke-pack.mjs` (new) | — | no | 2 |
| OPS-R7 | Plugin pin window: atomic bump-and-tag push in RELEASING §3, or a ref-pinned marketplace source; post-release checklist §4.1 | OPS-09, OPS-16 | `docs/RELEASING.md`, `.claude-plugin/marketplace.json` (if ref-pinned) | — | no | 1 |
| OPS-R8 | CI and Dependabot hygiene: drop the redundant coverage job, `delete_branch_on_merge`, prune stale branches, rebase or merge #20/#21 | OPS-11, OPS-13 | `.github/workflows/ci.yml` (`coverage` job), GitHub settings | OPS-R4, V3-15 | partly blocked-owner (settings, branch deletion) | 1 |
| OPS-R9 | Supply-chain acceptance criteria for V3-16/17/23 (digest-pinned non-root multi-arch image with SBOM and provenance; MCPB on the Release; OIDC-only distribution) | OPS-14 | `docs/ROADMAP.md` (V3-16/17/23 rows), `docs/DECISIONS.md` (D520/D521 amendment) | — | no | 0.5 |

## Open questions for the owner

1. **Credential state.** What expiry did you set on the `NPM_TOKEN` granular token when you created it on 2026-08-17? Can you register the npm trusted publisher before 2026-10-31? That decides whether 1.1.0 goes out on the token or on OIDC.
2. **1.1.0 versus 1.0.1.** Do you accept 1.1.0 from `main` (74 commits, 82 tools) as the CHANGE-3193 release? Or must the 1.0 surface stay frozen, which means a 3–5 h hand-port of V3-01 onto `release/1.0.x` plus the three lockfile advisory commits?
3. **Live proof before tagging.** Will you run the read half of `verify-live.mjs` against the test tenant before the tag? If `/rest/software/1.0` returns 403 under Basic auth, do you accept slipping `latest` and shipping `1.1.0-rc` on `beta` until the `/agile` fallback lands?
4. **Release reviewer gate.** Do you want a required-reviewer approval on the `release` environment (one click per release) in exchange for blocking an unintended `v*` tag from publishing?
5. **Live CI secrets.** Are you willing to store a read-only Jira API token for a test account as a `live`-environment secret, so the weekly job really runs? Or should the job be removed or relabelled so it stops reporting green?
6. **Audit policy.** Is an expiring, reviewed allowlist of advisories acceptable as the override when a high advisory has no fix on release day, or must the release always wait?
