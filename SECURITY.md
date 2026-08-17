# Security policy

This file is about **reporting a vulnerability in this software**. It is not the
threat model — what the server defends against, what the write gate promises,
how untrusted Jira content is handled and what is redacted from logs live in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Supported versions

Security fixes go to the **latest released version**, and only there.

- Once the `1.x` line exists, the newest `1.x` release is the supported one.
  Fixes are released as a new patch on that line; they are not backported to
  earlier minors, and an older minor is unsupported the moment a newer one
  ships.
- Anything below `1.0.0` is pre-release. It gets fixes only by moving to the
  current version.
- The published npm package and this repository are the same artifact. A fork,
  a vendored copy or a patched build is yours to maintain — report the issue
  here anyway if it is upstream, but the fix will land upstream only.

Before reporting, please confirm the problem is still present in the latest
version. Upgrading is the fastest fix that exists.

## Reporting a vulnerability

**Do not open a public issue.** For a security problem, opening the issue _is_
the disclosure.

Use GitHub's private vulnerability reporting: the **Report a vulnerability**
button under [Security](https://github.com/IvanBBaev/jira-mcp/security) on
<https://github.com/IvanBBaev/jira-mcp>. It opens a thread visible only to you
and the maintainer, and it is the preferred channel because the whole exchange —
report, fix, advisory — stays in one place.

If that button is not there, or you would rather not use GitHub, email
**ivanbbaev@gmail.com** with `jira-mcp-ai security` in the subject. Both routes
reach the same person.

Please include:

- affected version and Node.js version,
- what an attacker gains (read of another site's data, credential disclosure, a
  write executed without the gate, …),
- reproduction steps or a proof of concept,
- whether a fix already exists.

Redact as you would in any other report: no real API tokens (a token in a
report is a token to rotate), and no confidential Jira content beyond what the
proof of concept actually needs.

## What to expect

This is a personal, unfunded project maintained in spare time. There is no
service-level agreement, no bug bounty and no paid support tier, and this
document does not promise a response time it cannot keep.

What it does commit to:

- reports are read, and a genuine vulnerability is taken seriously ahead of
  feature work;
- the report stays private until there is a fix, or until you decide otherwise;
- a fix ships as a new release with a
  [GitHub Security Advisory](https://github.com/IvanBBaev/jira-mcp/security/advisories)
  describing the impact and the affected versions;
- you are credited in that advisory unless you ask not to be.

If a report gets no reply at all and the silence has become the problem, you are
free to disclose publicly — please just say so first.

## Scope

In scope:

- credential handling: leakage of `JIRA_API_TOKEN` or of a profile's token into
  logs, tool results, error messages, or files with permissive modes;
- the host allowlist: making the client send Atlassian credentials to a host you
  did not authorize;
- the write gate: executing a write tool without the configured mode and the
  explicit per-call opt-in;
- prompt injection through Jira content that reaches an agent as instructions
  rather than as labelled data;
- anything published in the npm tarball that should not be there.

Out of scope:

- vulnerabilities in Atlassian's own products or APIs — report those to
  [Atlassian](https://www.atlassian.com/trust/security);
- findings that require an attacker who already controls the machine running the
  server, or its environment variables;
- an agent making a bad-but-permitted Jira change, when the write gate was
  deliberately opened;
- dependency advisories with no exploitable path here (please still report them,
  but they are handled as ordinary maintenance).
