// ---------------------------------------------------------------------------
// Client hints on `tools/list` entries (D130).
//
// MCP leaves `_meta` on a tool open for vendor keys. Claude Code reads two of
// them (https://code.claude.com/docs/en/mcp), and both answer a real problem
// this server has:
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
//
// Other clients ignore unknown `_meta` keys, so the hints cost nothing there.
// ---------------------------------------------------------------------------

import type { AnyToolSpec } from './types.js';

/** Claude Code's `_meta` name that forces a prompt on every call. */
export const REQUIRES_USER_INTERACTION_META = 'anthropic/requiresUserInteraction';

/** Claude Code's `_meta` name that raises the persist-to-disk threshold. */
export const MAX_RESULT_SIZE_META = 'anthropic/maxResultSizeChars';

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
  const textChars = options.maxResultChars + TEXT_CHANNEL_SLACK_CHARS;
  if (textChars > CLIENT_DEFAULT_RESULT_CHARS) {
    meta[MAX_RESULT_SIZE_META] = Math.min(textChars, CLIENT_MAX_RESULT_CHARS);
  }
  return Object.keys(meta).length === 0 ? undefined : meta;
}
