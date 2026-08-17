<!--
Thanks for the PR. CONTRIBUTING.md has the long version of everything below.
Delete the sections that genuinely do not apply — but delete them, do not leave
them unticked and hope nobody notices.
-->

## What this changes

<!-- One paragraph. What behaviour is different after this merges? -->

## Why

<!--
The reasoning, not the diff. If this reverses or narrows an earlier choice, name
the decision row (D<n>) it touches.
-->

Closes #

## The gate

`npm run check` runs typecheck, lint, format check, build, the tarball
assertion, the test suite with coverage floors, docs-lint and a production
audit.

```text
<!-- Paste the real result here. If you could not run it, say which part and why. -->
```

- [ ] `npm run check` passes locally.
- [ ] New behaviour is covered by a colocated `*.test.ts`.
- [ ] No test reaches the network, and no test data comes from a real Jira site
      (placeholder ids, `example.atlassian.net`, `@example.invalid`).

## Spec corpus

The specification in `docs/` is normative and single-writer: a code change that
contradicts a document is a bug in one of them, and both get fixed in the same
PR.

- [ ] Docs updated in this PR, or: no normative fact changed.
- [ ] New `JIRA_*` variable → a row in `docs/CONFIGURATION.md` (a test enforces
      this in both directions).
- [ ] Tool surface changed → `docs/TOOLS.md` updated and `npm run readme`
      re-run (the README table is generated and asserted).

## Ledgers

- [ ] `docs/DECISIONS.md` — added a row, or: this change makes no choice a
      future reader could reverse by accident.
- [ ] `docs/CORNER-CASES.md` — added a `CC-nn` row for any behaviour Jira or the
      protocol forces on us, and a test that names the id.

## Load-bearing walls

Tick only what you touched, and say what the consequence is.

- [ ] `core/http.ts`, the retry matrix or the host allowlist
- [ ] The redactor or anything that formats an error
- [ ] The write gate (`JIRA_WRITE_MODE`, `plan_id`, `JIRA_ALLOW_IRREVERSIBLE`)
- [ ] Attachment paths or anything that writes to disk
- [ ] The layering zones, the `Clock` seam, or stdout/stderr handling

<!-- If any box above is ticked, explain the security consequence here. -->

## Confirmations

- [ ] English throughout — code, comments, docs, commit messages, test names.
- [ ] No credentials, `.env` contents, real issue keys, real account ids or real
      customer text anywhere in the diff, the description or a screenshot.
- [ ] One concern per PR (a refactor plus a behaviour change is two PRs).
