# jira-mcp-ai

An [MCP](https://modelcontextprotocol.io) server for **Jira Cloud**: it gives an
MCP-capable agent (Claude Code, Claude Desktop, or any other client) tools to
search, read and — behind an explicit gate — write Jira issues, using your own
Atlassian account and API token.

Two things shape the design:

- **Writes are gated.** Write tools default to describing what they *would* do
  instead of doing it. Executing requires both an opt-in configuration and an
  explicit flag on the call. See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
- **Jira content is untrusted input.** Issue text arrives from whoever filed the
  ticket. It is labelled as data, never merged into the agent's instructions.

> **Status: pre-code.** The specification in [`docs/`](docs/README.md) is
> complete and normative; the implementation is being built against it. Nothing
> is published to npm yet, so the registration example below will not resolve
> until the first release.

## Requirements

- Node.js ≥ 22 (env files are read with `process.loadEnvFile()`, not dotenv)
- A Jira Cloud site and an Atlassian API token

## Registration

```jsonc
// .mcp.json / claude mcp add
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "jira-mcp-ai@0.1.0"],
      "env": {
        "JIRA_SITE": "mycompany",
        "JIRA_EMAIL": "me@example.com",
        "JIRA_API_TOKEN": "…",
        "JIRA_WRITE_MODE": "plan"
      }
    }
  }
}
```

The version is pinned on purpose: an unpinned `npx -y` re-resolves to whatever is
newest at spawn time, so a fresh publish could start running new code inside an
agent session with no review step. Bump the pin once you have read the changelog.

## Configuration

Every setting is an environment variable with the `JIRA_` prefix. The full table
— names, defaults, required-ness, and where credentials may live — is in
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md); [`.env.example`](.env.example)
is a fill-in-the-blanks copy.

## Tools

<!-- GENERATED:TOOLS:START -->

The tool table is generated from the package definitions and inserted here.
Until then, [`docs/TOOLS.md`](docs/TOOLS.md) is the catalog: tool names, input
and output shapes, packages, and the plan/apply contract for the write tier.

<!-- GENERATED:TOOLS:END -->

## Data handling

What leaves your machine, what is written to disk, what is redacted from logs,
and what the write gate does and does not promise are documented in
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). Credential storage and lifecycle
are in [`docs/AUTH.md`](docs/AUTH.md).

To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

## Development

```sh
npm install
npm run check   # typecheck, lint, format, build, test, docs-lint, prod audit
```

[`docs/README.md`](docs/README.md) is the index to the specification;
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is the place to start.
Contributor conventions, the test taxonomy and the coverage gate are in
[`docs/TESTING.md`](docs/TESTING.md).

## License

[MIT](LICENSE).

Jira and Atlassian are trademarks of Atlassian Pty Ltd. This project is an
independent, unofficial client and is not affiliated with or endorsed by
Atlassian.
