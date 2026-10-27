// ---------------------------------------------------------------------------
// Completions — `completion/complete`, stage A (D154).
//
// Pure: every value comes from the manifest the server was built with, never
// from Jira. Two sources:
//
//   - a prompt argument that declares `values` (a closed set, such as the
//     bulk-preflight action) completes to those values;
//   - the `jira://reference/tools/{name}` template completes `name` to every
//     tool in the manifest — registered here or not, as the template reads.
//
// Everything else completes to nothing: a free-text argument, a key, and the
// export template (whose names exist only on disk). Live values — projects,
// versions, sprints — are stage B and are not built.
//
// Matching is a case-insensitive prefix match; results are sorted for the
// reference template, kept in declared order for a prompt argument, and capped
// at the protocol's 100 values with `total` and `hasMore`.
//
// Layering: `core ← api ← mcp ← tools`. SDK types only.
// ---------------------------------------------------------------------------

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CompleteRequest, CompleteResult } from '@modelcontextprotocol/sdk/types.js';

import { EXPORT_TEMPLATE } from './exports.js';
import { TOOL_REFERENCE_TEMPLATE } from './resources.js';
import type { PromptSpec } from './types.js';

/** The protocol's ceiling on one completion's `values`. */
export const COMPLETION_MAX_VALUES = 100;

export interface CompletionDeps {
  /** The prompts this configuration lists — a gated-out prompt does not complete. */
  readonly prompts: readonly PromptSpec[];
  /** Every tool name in the manifest, which the reference template accepts. */
  readonly toolNames: readonly string[];
}

export interface Completer {
  /** `completion/complete`. Throws `McpError` (InvalidParams) for an unknown ref. */
  complete(params: CompleteRequest['params']): CompleteResult;
}

function invalidParams(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

/** The values starting with `typed`, ignoring case, capped at the protocol limit. */
export function completionOf(
  candidates: readonly string[],
  typed: string,
): CompleteResult {
  const prefix = typed.toLowerCase();
  const matches = candidates.filter((value) => value.toLowerCase().startsWith(prefix));
  const values = matches.slice(0, COMPLETION_MAX_VALUES);
  return {
    completion: {
      values,
      total: matches.length,
      hasMore: matches.length > values.length,
    },
  };
}

const NOTHING: CompleteResult = { completion: { values: [], total: 0, hasMore: false } };

export function createCompleter(deps: CompletionDeps): Completer {
  const prompts = new Map(deps.prompts.map((prompt) => [prompt.name, prompt]));
  const toolNames = [...new Set(deps.toolNames)].sort();

  return {
    complete(params) {
      const { ref, argument } = params;
      if (ref.type === 'ref/prompt') {
        const prompt = prompts.get(ref.name);
        if (prompt === undefined) {
          throw invalidParams(
            `Unknown prompt "${ref.name}". prompts/list names every prompt this ` +
              'configuration offers.',
          );
        }
        const arg = prompt.arguments.find(
          (candidate) => candidate.name === argument.name,
        );
        if (arg === undefined) {
          throw invalidParams(`Prompt "${ref.name}" has no argument "${argument.name}".`);
        }
        return arg.values === undefined
          ? NOTHING
          : completionOf(arg.values, argument.value);
      }
      if (ref.uri === TOOL_REFERENCE_TEMPLATE) {
        return argument.name === 'name'
          ? completionOf(toolNames, argument.value)
          : NOTHING;
      }
      if (ref.uri === EXPORT_TEMPLATE) return NOTHING;
      throw invalidParams(
        `Unknown resource template "${ref.uri}". resources/templates/list names every ` +
          'template.',
      );
    },
  };
}
