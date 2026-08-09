# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because registrations pin an exact version (see README), this file is the thing a
user reads before bumping the pin. Entries describe what changes for **them** —
new or renamed tools, changed tool input/output shapes, changed defaults, changed
env var names — not internal refactors.

## [Unreleased]

Pre-code. The specification in `docs/` is complete; implementation is in
progress and nothing has been published.

### Added

- Repository furniture: build, lint, format, coverage and CI configuration; the
  `npm run check` gate; the docs consistency linter (`scripts/docs-lint.mjs`).
