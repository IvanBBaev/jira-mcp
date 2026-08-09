# Security policy

This file is about **reporting a vulnerability in this software**. It is not the
threat model — what the server defends against, what the write gate promises,
how untrusted Jira content is handled and what is redacted from logs live in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Supported versions

Pre-1.0 and pre-release: only the latest published version receives fixes. Once
a stable line exists this section will name it.

## Reporting a vulnerability

Please **do not open a public issue** for a security report — a public issue is
a disclosure.

Use GitHub's private reporting instead: the **Security → Advisories → Report a
vulnerability** form on
<https://github.com/IvanBBaev/jira-mcp>. It creates a private thread visible
only to the maintainer.

<!-- TODO(owner): if private vulnerability reporting is not enabled on the repo
     (Settings → Code security), enable it, or replace the line above with a
     contact address. A reporting policy that points at a form nobody has turned
     on is worse than none. -->

Please include:

- affected version and Node.js version,
- what an attacker gains (read of another site's data, credential disclosure, a
  write executed without the gate, …),
- reproduction steps or a proof of concept,
- whether a fix already exists.

Expect an acknowledgement within **7 days** and an assessment within **30 days**.
This is a personal, unfunded project — there is no bug bounty, and there is no
paid support tier.

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
