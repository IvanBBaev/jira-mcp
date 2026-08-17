# Releasing

> Status: procedural — the publish-day runbook. Unlike the rest of this corpus
> it does not describe shipped behaviour: every step below is an owner action
> that has not been taken yet, and the pipeline it drives is deliberately inert
> until it is (D37).

The release machinery was written, reviewed and dry-run long before the
decision to publish. That was the point: on the day, nothing here should need a
workflow edit, a code change or a judgement call. This file is the list of
things a file cannot do for you, in the order they have to happen.

Prerequisite: **O-9** in [DECISIONS.md](DECISIONS.md) — the decision to publish
at all — is still open. Nothing below applies until it is taken. **O-10** (repo
visibility) is resolved: the repository is public, which is what lets npm
provenance attest a public source.

## 1. Repository settings

None of these live in a file, so none of them are covered by the gate, by
review, or by anything a contributor can check. Most of them can nevertheless be
*read* without opening a browser, and a state nobody measured is a state nobody
knows — so the table carries the observed value and the read-only command that
produced it. Changing any of them still needs a human in the settings UI; that
asymmetry is the point of the last column.

State column verified 2026-08-17 by the commands in §1.1. Re-run them rather
than trusting the date.

| Setting | State (2026-08-17) | Why it matters here |
|---|---|---|
| Private vulnerability reporting | **off** — `private-vulnerability-reporting` reports `enabled: false` | [SECURITY.md](../SECURITY.md) names the **Report a vulnerability** button as the channel. Until this is on, that button does not exist and reporters fall through to the email fallback. |
| Secret scanning + push protection | **both off** — `security_and_analysis.secret_scanning` and `…_push_protection` are `disabled` | This server's whole threat story is credential handling. Push protection is what stops an API token reaching a public commit in the first place — free on a public repo. |
| Dependabot **security** updates | **off, and so is its prerequisite** — `automated-security-fixes` reports `enabled: false`, and `vulnerability-alerts` answers 404 (alerts themselves are off). Two toggles, in that order | `.github/dependabot.yml` configures *version* updates only. Security updates are a separate repository toggle, and they do nothing until Dependabot alerts are on — enabling only the second one looks done and changes nothing. |
| CodeQL default setup — leave **off** | **correct as it stands** — `code-scanning/default-setup` reports `state: not-configured` | Analysis ships as an advanced-setup workflow (D67). Turning default setup on silently disables that file. Run one or the other, never both. This row is a guard, not a task: the only wrong action is acting. |
| Environment `release` | **does not exist** — the repository has `github-pages` and `live` | `.github/workflows/publish.yml` declares it on the publishing job. It does not exist yet, so the first tagged run fails at job start — and it is the right place to hang a required reviewer. |
| Variable `PUBLISH_ENABLED` | **unset** — `actions/variables` returns `total_count: 0` | Unset is the O-9 gate itself. Setting it to `true` is the go signal; nothing publishes while it is absent. |
| GitHub Pages — deploy from `main`, `/docs` | **on and correctly wired** — `pages` reports `status: built`, source branch `main` path `/docs`, `public: true`, `https_enforced: true`, and its `html_url` equals `package.json`'s `homepage`. One human step remains: open it and confirm the page renders | No workflow builds the site, so this is a settings toggle like the rest of the table. `package.json` `homepage` is `https://ivanbbaev.github.io/jira-mcp/`, and that is the **Homepage** link npm renders on the package page — if Pages is off, the first thing a stranger clicks on a brand-new package 404s. `docs/robots.txt` and `docs/sitemap.xml` already advertise the URL. "Built" is GitHub's word for the last deploy, not a promise the HTML is right. |
| npm trusted publisher | **unverifiable from here, and the only genuinely blind row** — trusted-publisher configuration is npmjs.com account state with no read-only public API, and the package does not exist yet (`npm view jira-mcp-ai` → E404), so there is nothing to query even in principle | Register this repository and `publish.yml` as a trusted publisher for the package name. There is no `NPM_TOKEN` anywhere in this repo and there must never be one — OIDC replaces the long-lived-token class of supply-chain risk entirely (D37). |

### 1.1 Re-reading the state

Every row above except the npm one comes from a read-only call. None of them
change anything, so run them freely — including on release day, as the last
thing before the tag.

```sh
gh api repos/IvanBBaev/jira-mcp --jq '{visibility, security_and_analysis}'
gh api repos/IvanBBaev/jira-mcp/private-vulnerability-reporting
gh api repos/IvanBBaev/jira-mcp/automated-security-fixes
gh api -i repos/IvanBBaev/jira-mcp/vulnerability-alerts | head -1   # 204 on, 404 off
gh api repos/IvanBBaev/jira-mcp/code-scanning/default-setup --jq .state
gh api repos/IvanBBaev/jira-mcp/environments --jq '.environments[].name'
gh api repos/IvanBBaev/jira-mcp/actions/variables --jq '{total_count}'
gh api repos/IvanBBaev/jira-mcp/pages --jq '{status, source, html_url}'
```

Two of these read as absences rather than values, and an absence is easy to
misread. `vulnerability-alerts` has no response body at all: 204 means on, 404
means off, which is why the `-i` flag is not optional. `actions/variables`
returning an empty list is indistinguishable from a repository where the API
call was scoped away — if the token in use cannot see variables, this row is
unanswered rather than answered "unset".

The npm side has no equivalent. Trusted publishing has to be confirmed by
logging into npmjs.com and looking, both before the release (the publisher is
registered) and after it (the run that published carries a provenance
attestation).

## 2. The version bump is a set, not a field

Twelve places carry the version or a pin of it, and they move **together**. Five
are manifest fields, in four files:

- `package.json` — `version`
- `server.json` — `version` **and** `packages[0].version` (two fields, one file)
- `.claude-plugin/plugin.json` — `version`
- `.claude-plugin/marketplace.json` — `plugins[0].version`

Those five fields are machine-checked as a set **[test: src/manifest-sync.test.ts]**:
the distribution-manifest suite ([TESTING.md](TESTING.md) suite 10) asserts that
all four manifest version fields equal `package.json`'s, so bumping some and
forgetting the rest fails `npm run check` instead of reaching a registry. What it
cannot tell you is whether the number is the *right* one — it checks agreement,
not intent, and every field agreeing at `0.0.0` is exactly the state this
document exists to get you out of.

The other seven are registration pins — copy-pasteable `jira-mcp-ai@<version>`
snippets — and those are machine-checked too: the canonical one lives in
[CONFIGURATION.md](CONFIGURATION.md), and `scripts/docs-lint.mjs` check 5 asserts
that the other six mirror it exactly (two in `README.md`, three on the GitHub
Pages page, one in `.claude-plugin/plugin.json` — D61, D68). A drifted pin is a
copy-pasteable snippet that 404s, which is the worst possible first-run
experience — so the lint fails rather than the user.

Note the deliberate inconsistency before the first publish: the manifests read
`0.0.0` while the registration pins already name the version that will exist.
Both forms are broken today; only the pins become correct on publish day
without an edit.

Also on the day: drop `"private": true` from `package.json` (it is the last
mechanical stop before an accidental publish) and turn the CHANGELOG's
unreleased section into a dated release entry.

## 3. Publishing

1. Run `npm run check` locally and read it. Not the summary — the output.
2. Rehearse the install (below). `check-tarball` proves the tarball's *contents*;
   only an install proves the artifact *starts*.
3. Make the version-set edit from §2 in one commit.
4. Push it, and let CI go green on `main`.
5. Tag `v<version>` and push the tag.
6. `publish.yml` fires: it re-runs the full gate — including the advisory audit,
   which lives in the workflow rather than in `prepublishOnly` precisely so a
   freshly disclosed CVE stops the release *before* anything irreversible
   (D62) — then publishes with provenance.

### 3.1 The tarball is compiled by a different config

`npm run build` and `npm run build:publish` produce different bytes, and the
difference is deliberate.

`tsconfig.json` emits source maps, because `.c8rc.json` measures coverage over
the *compiled* output and remaps it back through those maps — without them the
excludes (written in `src/` terms) stop matching and the floors stop meaning
anything. But `files` in `package.json` excludes every map from the tarball: a
map embeds absolute build paths and, with `sourcesContent`, the TypeScript
source. tsc does not know that, so it writes a `sourceMappingURL` footer into
every emitted file regardless — and the published package ends up with every
single file pointing at a file nobody can fetch. Harmless at runtime, and still
a dangling reference in every file of a release.

`tsconfig.publish.json` turns the two map flags off, and only the publish path
uses it: `prepublishOnly` runs `check:publish` (which builds *with* maps and
measures coverage), then `build:publish`, then `tarball:publish`. That last one
is `scripts/check-tarball.mjs --publish`, which fails if any shipped file still
carries a footer — so the ordering cannot silently regress. Both modes of that
script also assert `tsconfig.publish.json` still exists and still says what
`--publish` depends on, which means deleting it fails the everyday gate instead
of release day.

Two consequences worth knowing before you hit them:

- **After any `build:publish`, rebuild with `npm run build` before measuring
  coverage again.** A map-free `build/` does not make c8 fail; it makes c8
  report the wrong thing — test files and fakes counted as product code, against
  floors that were never set for them.
- **`removeComments` is deliberately not set.** It looks like free size on the
  JS side, but it is one flag for both emits: turning it on also strips every
  JSDoc block from the `.d.ts` files this package advertises through `types`,
  which is the documentation a consumer sees on hover. The comments are also
  what make a stack trace from a published build readable. Both audits so far
  have reached the same answer; overturn it with a ledger entry, not a commit.

### Rehearsing the install before it is irreversible

§5 says to install the published artifact and run `doctor` against it. The whole
of that can be done *before* publishing, against the same bytes npm would upload,
and it is the only check that catches an entry point the allowlist excluded or a
runtime file that was never emitted:

```sh
npm run build:publish                         # §3.1 — `npm pack` never runs prepublishOnly
npm run tarball:publish                       # no dangling sourceMappingURL footers
npm pack --pack-destination /tmp/rehearse     # the real tarball, not a listing
mkdir /tmp/rehearse/client && cd /tmp/rehearse/client && npm init -y
npm install /tmp/rehearse/jira-mcp-ai-<version>.tgz
./node_modules/.bin/jira-mcp-ai --version
./node_modules/.bin/jira-mcp-ai doctor --offline    # expect exit 2 with no site
npm run build                                 # restore the map-carrying dev build
```

The first and last lines are the ones people skip. `npm pack` reads `build/` off
disk and runs `prepack`/`postpack` — it never runs `prepublishOnly`, so nothing
in the publish chain fires and you would otherwise be packing whatever the last
`npm run build` left behind. The last line puts the source maps back before
anyone measures coverage again (§3.1).

Then drive one MCP `initialize` + `tools/list` over stdin and confirm the tool
count. A binary that prints its version proves less than it looks: the version
falls back to `0.0.0` when `package.json` cannot be read, which is also the
pre-release value — patch the installed `package.json` to a sentinel if you want
that check to mean anything.

Do **not** reach for `npm publish --dry-run` to inspect what would ship. It runs
`prepublishOnly` first, which runs `check:publish` → `build` → `clean`, so it
deletes `build/` as a side effect of a command whose name promises it changes
nothing. `npm pack --dry-run --json` is the read-only form, and it is what
`scripts/check-tarball.mjs` already calls.

A hand-run `npm publish` from a laptop is the fallback, not the path.
`prepublishOnly` protects it, but two things bite. It produces no provenance
attestation, and an unattested release of a package whose whole selling point is
credential handling is worth avoiding. And `publishConfig.provenance` is `true`,
which npm honours only in a supported CI environment — from a laptop the publish
*fails* at provenance generation rather than quietly proceeding without it, so
the fallback needs an explicit `npm publish --provenance=false`. That flag is the
signal you have left the reviewed path; do not add it to `publishConfig` to make
the error go away.

## 4. Where "irreversible" starts

The tag is not the point of no return; the successful `npm publish` is. npm
allows an unpublish only within a short window after first publication and only
while nothing depends on the package — and a version number, once used, can
never be reused even after an unpublish. Plan on the release being permanent
and ship a patch instead: `1.0.1` released ten minutes later costs nothing,
while an unpublish-and-retry burns the number and breaks anyone who was fast.

## 5. After the first publish

- Install the published artifact into a scratch client from the registry — not
  from the working tree — and run `doctor` against a real site. The tarball's
  contents are gate-checked (`scripts/check-tarball.mjs`), but "the tarball is
  right" and "the published package starts" are different claims. The §3
  rehearsal already answers the second one; what only the registry can answer is
  whether npm stored and served the same bytes, and `doctor` against a real site
  is the part no local run reaches at all.
- Verify the provenance attestation appears on the package page.
- The Claude plugin manifest becomes functional at this moment and not before
  (D68) — installing it from a clone was never going to work.
- Open a new issue once and confirm both issue forms render. GitHub validates
  the forms on push and shows a banner on the Issues tab if one is malformed;
  only its own parser is authoritative.

## 6. Things this file deliberately does not decide

- **Deferred dependency majors.** No longer open: `zod` 4, `fast-check` 4 and
  eslint 10 all landed before 1.0.0 (D82, closing O-14), and re-validating the
  emitted schema of every tool is now the manifest snapshot's job rather than a
  release-day errand (CC-82). What stays deferred is named in
  `.github/dependabot.yml` with the event that unblocks it — `typescript` 7 and
  `@types/node` above the supported Node floor.
- **Gate C** — verification against a live Jira site. It blocks the release in
  the sense that publishing software that has never spoken to the real API is
  not a thing this project does. What this file will not decide is *which* site
  and *when*; the procedure itself is no longer prose. It is one command,
  rehearsed offline against the fake before it is ever pointed at a tenant
  ([TESTING.md](TESTING.md), "Rehearsing the live gate"), and it is refused
  outright unless the operator names the host it is about to write to:

  ```sh
  JIRA_SITE=https://<scratch>.atlassian.net JIRA_EMAIL=… JIRA_API_TOKEN=… \
    node scripts/verify-live.mjs --project <KEY> --project2 <KEY2> \
      --write --irreversible --confirm-site <scratch>.atlassian.net
  ```

  Run it against a **scratch** site. It creates issues, a version, a sprint and
  an attachment, and every run ends by printing an inventory of what it left
  behind together with the command that removes the removable part — see
  `scripts/verify-live.mjs`, whose header is the authoritative safety contract.
  Two artifacts (the version and the sprint) cannot be removed by any command,
  because this server ships no delete for either and the gate does not get to
  widen the product's write surface (D73); the inventory says so in as many
  words rather than implying a cleanup that does not exist.
