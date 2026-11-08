// ---------------------------------------------------------------------------
// Completions — `completion/complete`, stage A (D154) and stage B (D551).
//
// Stage A is pure: values from the manifest the server was built with. Two
// sources:
//
//   - a prompt argument that declares `values` (a closed set, such as the
//     bulk-preflight action) completes to those values;
//   - the `jira://reference/tools/{name}` template completes `name` to every
//     tool in the manifest — registered here or not, as the template reads.
//
// Stage B adds one live source: a prompt argument marked `completion:
// 'projectKey'` completes to the project keys from `mcp/project-keys.ts` — a
// TTL-cached read, the scope's keys under `JIRA_PROJECTS`, nothing when it is
// off or the read fails. Only keys the argument itself accepts are offered.
//
// Everything else completes to nothing: a free-text argument, an issue key,
// and the export template (whose names exist only on disk). Versions and
// sprints are not built.
//
// Matching is a case-insensitive prefix match; results are sorted for the
// reference template, kept in declared order for a prompt argument, and capped
// at the protocol's 100 values with `total` and `hasMore`.
//
// Layering: `core ← api ← mcp ← tools`. SDK types only.
// ---------------------------------------------------------------------------

import { ErrorCode, McpError } from './sdk.js';
import type { CompleteRequest, CompleteResult } from './sdk.js';

import { EXPORT_TEMPLATE } from './exports.js';
import type { ProjectKeySource } from './project-keys.js';
import { acceptsArgumentValue } from './prompts.js';
import { TOOL_REFERENCE_TEMPLATE } from './resources.js';
import type { PromptSpec } from './types.js';

/** The protocol's ceiling on one completion's `values`. */
export const COMPLETION_MAX_VALUES = 100;

export interface CompletionDeps {
  /** The prompts this configuration lists — a gated-out prompt does not complete. */
  readonly prompts: readonly PromptSpec[];
  /** Every tool name in the manifest, which the reference template accepts. */
  readonly toolNames: readonly string[];
  /** Stage B project keys (D551). Absent = a `projectKey` argument completes to nothing. */
  readonly projectKeys?: ProjectKeySource | undefined;
}

export interface Completer {
  /** `completion/complete`. Rejects with `McpError` (InvalidParams) for an unknown ref. */
  complete(params: CompleteRequest['params']): Promise<CompleteResult>;
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
    async complete(params) {
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
        if (arg.values !== undefined) return completionOf(arg.values, argument.value);
        if (arg.completion !== 'projectKey' || deps.projectKeys === undefined) {
          return NOTHING;
        }
        // The source never rejects: a failed read is already an empty list.
        const keys = await deps.projectKeys();
        return completionOf(
          keys.filter((key) => acceptsArgumentValue(arg, key)),
          argument.value,
        );
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
