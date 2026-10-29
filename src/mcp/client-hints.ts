// ---------------------------------------------------------------------------
// Client hints on `tools/list` entries (D130).
//
// MCP leaves `_meta` on a tool open for vendor keys. Claude Code reads three
// of them (https://code.claude.com/docs/en/mcp), and each answers a real
// problem this server has:
//
// - `anthropic/requiresUserInteraction: true` forces a permission prompt on
//   EVERY call of the tool, even under acceptEdits/auto/bypassPermissions, and
//   no allow rule skips it. The irreversible tier (D45) is exactly the surface
//   where the prompt itself is the point: the plan/apply gate stops a model
//   from deleting by accident, this stops a permissive session from deleting
//   without a human looking. The cost is that dontAsk mode denies those tools
//   outright — which is the right failure for a delete.
// - `anthropic/maxResultSizeChars` raises the size at which Claude Code
//   persists a tool result to disk instead of inlining it (default 50 000
//   characters, ceiling 500 000). It is emitted only when
//   `JIRA_MAX_RESULT_CHARS` lets a result outgrow the default: an operator who
//   raised the budget asked for the bigger inline answer, and without the hint
//   the client would undo that by spilling it to a file.
// - `anthropic/alwaysLoad: true` keeps a tool out of Claude Code's tool-search
//   deferral, so the model sees it without a search step (D509). It is set on
//   the few reads almost every Jira session starts with — find issues, count
//   them, read one, resolve a person's accountId — and on nothing else: every
//   upfront tool costs context on every turn. A user can still defer the whole
//   server with `"alwaysLoad": false` in their MCP configuration.
//
// Other clients ignore unknown `_meta` keys, so the hints cost nothing there.
// ---------------------------------------------------------------------------

import type { AnyToolSpec } from './types.js';

/** Claude Code's `_meta` name that forces a prompt on every call. */
export const REQUIRES_USER_INTERACTION_META = 'anthropic/requiresUserInteraction';

/** Claude Code's `_meta` name that raises the persist-to-disk threshold. */
export const MAX_RESULT_SIZE_META = 'anthropic/maxResultSizeChars';

/** Claude Code's `_meta` name that loads a tool upfront, outside tool search. */
export const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

/**
 * The hottest reads, loaded upfront under tool search (D509). Kept short on
 * purpose: each name here is paid for in context on every turn. Their
 * descriptions open with the verb and the Jira noun (keyword-first), which
 * `tools/always-load.test.ts` holds them to.
 */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  'jira_search',
  'jira_count',
  'jira_get_issue',
  'jira_search_users',
]);

/** Claude Code's inline threshold when a tool declares none. */
export const CLIENT_DEFAULT_RESULT_CHARS = 50_000;

/** The highest `maxResultSizeChars` Claude Code honours. */
export const CLIENT_MAX_RESULT_CHARS = 500_000;

/**
 * Headroom over `JIRA_MAX_RESULT_CHARS` for what the text channel adds around
 * the budgeted JSON: the D15 taint banner and the fence-escaping of delimiter
 * characters inside it (`mcp/result.ts`).
 */
export const TEXT_CHANNEL_SLACK_CHARS = 4_096;

/** What the hints depend on besides the spec itself. */
export interface ClientHintOptions {
  /** `JIRA_MAX_RESULT_CHARS`. */
  readonly maxResultChars: number;
}

/**
 * The `_meta` object for one tool's `tools/list` entry, or `undefined` when
 * no hint applies — the entry then carries no `_meta` at all.
 */
export function clientHints(
  spec: AnyToolSpec,
  options: ClientHintOptions,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  if (spec.writeTier === 'irreversible') meta[REQUIRES_USER_INTERACTION_META] = true;
  if (ALWAYS_LOAD_TOOLS.has(spec.name)) meta[ALWAYS_LOAD_META] = true;
  const textChars = options.maxResultChars + TEXT_CHANNEL_SLACK_CHARS;
  if (textChars > CLIENT_DEFAULT_RESULT_CHARS) {
    meta[MAX_RESULT_SIZE_META] = Math.min(textChars, CLIENT_MAX_RESULT_CHARS);
  }
  return Object.keys(meta).length === 0 ? undefined : meta;
}
