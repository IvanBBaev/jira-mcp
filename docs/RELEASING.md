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
review, or by anything a contributor can check. All of them were off at the
last audit (2026-08-15).

| Setting | Why it matters here |
|---|---|
| Private vulnerability reporting | [SECURITY.md](../SECURITY.md) names the **Report a vulnerability** button as the channel. Until this is on, that button does not exist and reporters fall through to the email fallback. |
| Secret scanning + push protection | This server's whole threat story is credential handling. Push protection is what stops an API token reaching a public commit in the first place — free on a public repo. |
| Dependabot **security** updates | `.github/dependabot.yml` configures *version* updates only. Security updates are a separate repository toggle. |
| CodeQL default setup — leave **off** | Analysis ships as an advanced-setup workflow (D67). Turning default setup on silently disables that file. Run one or the other, never both. |
| Environment `release` | `.github/workflows/publish.yml` declares it on the publishing job. It does not exist yet, so the first tagged run fails at job start — and it is the right place to hang a required reviewer. |
| Variable `PUBLISH_ENABLED` | Unset, which is the O-9 gate itself. Setting it to `true` is the go signal; nothing publishes while it is absent. |
| GitHub Pages — deploy from `main`, `/docs` | No workflow builds the site, so this is a settings toggle like the rest of the table. `package.json` `homepage` is `https://ivanbbaev.github.io/jira-mcp/`, and that is the **Homepage** link npm renders on the package page — if Pages is off, the first thing a stranger clicks on a brand-new package 404s. `docs/robots.txt` and `docs/sitemap.xml` already advertise the URL. Verify by loading it, not by assuming. |
| npm trusted publisher | Register this repository and `publish.yml` as a trusted publisher for the package name. There is no `NPM_TOKEN` anywhere in this repo and there must never be one — OIDC replaces the long-lived-token class of supply-chain risk entirely (D37). |

## 2. The version bump is a set, not a field

Nine places carry the version or a pin of it, and they move **together**. Five
are manifests:

- `package.json` — `version`
- `server.json` — `version` **and** `packages[0].version` (two fields, one file)
- `.claude-plugin/plugin.json` — `version`
- `.claude-plugin/marketplace.json` — `plugins[0].version`

Four are registration pins, and those are machine-checked: the canonical value
lives in [CONFIGURATION.md](CONFIGURATION.md), and `scripts/docs-lint.mjs`
check 5 asserts that `README.md`, the GitHub Pages page and
`.claude-plugin/plugin.json` mirror it exactly (D61, D68). A drifted pin is a
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

### Rehearsing the install before it is irreversible

§5 says to install the published artifact and run `doctor` against it. The whole
of that can be done *before* publishing, against the same bytes npm would upload,
and it is the only check that catches an entry point the allowlist excluded or a
runtime file that was never emitted:

```sh
npm pack --pack-destination /tmp/rehearse     # the real tarball, not a listing
mkdir /tmp/rehearse/client && cd /tmp/rehearse/client && npm init -y
npm install /tmp/rehearse/jira-mcp-ai-<version>.tgz
./node_modules/.bin/jira-mcp-ai --version
./node_modules/.bin/jira-mcp-ai doctor --offline    # expect exit 2 with no site
```

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

- **zod 3 → 4** (O-14). It re-validates the emitted schema of every tool, and
  that churn is free while nothing consumes them. The default answer is
  "before 1.0.0", but it is an owner call.
- **Gate C** — verification against a live Jira site. It blocks the release in
  the sense that publishing software that has never spoken to the real API is
  not a thing this project does; the procedure lives with the scripts, not
  here.
