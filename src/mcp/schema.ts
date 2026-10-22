// ---------------------------------------------------------------------------
// The JSON Schema a client receives for a tool (TOOLS.md §Reference resources,
// D124).
//
// zod → JSON Schema is the SDK's job (`toJsonSchemaCompat`); this module owns
// what is removed afterwards. Two things the converter emits say nothing a
// model can act on and cost a line in every one of the 59 schemas:
//
//   - the top-level `$schema` draft pointer, meaningless inside `tools/list`;
//   - the bounds zod attaches to every `.int()` — ±2^53-1, JavaScript's safe
//     integer range, not a limit the tool chose. A bound the tool DID choose
//     (`maxResults ≤ 100`) is a different number and survives untouched.
//
// Shared by `server.ts` (`tools/list`) and `resources.ts` (the per-tool
// reference), so the two never disagree about a schema. The manifest snapshot
// records the trimmed output, so a converter upgrade that changes either side
// of this is still a visible diff (CC-82).
//
// Layering: `core ← api ← mcp ← tools`. SDK only; no zod.
// ---------------------------------------------------------------------------

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { AnyToolSpec } from './types.js';

/** `tools/list` input schema type, re-exported so callers need no SDK import. */
export type ToolInputSchema = Tool['inputSchema'];

/** What zod emits for an unbounded `.int()`: `Number.MAX_SAFE_INTEGER` either way. */
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;

/**
 * Drop the keywords that carry no information for a caller, at every depth.
 * Pure: returns a new tree, never mutates the converter's output.
 */
export function trimJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trimJsonSchema);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (key === 'maximum' && child === SAFE_INT_MAX) continue;
    if (key === 'minimum' && child === SAFE_INT_MIN) continue;
    out[key] = trimJsonSchema(child);
  }
  return out;
}

/**
 * The input schema of one tool as a client sees it. The conversion is pure and
 * the manifest immutable, so callers convert once at startup and keep the
 * result (CC-81: no `$ref`; CC-1416: no `$schema`, no safe-integer bounds).
 */
export function toInputSchema(spec: AnyToolSpec): ToolInputSchema {
  return trimJsonSchema(
    toJsonSchemaCompat(spec.input as AnyObjectSchema, {
      strictUnions: true,
      // The schema describes what a CALLER sends, so defaults and coercions are
      // rendered on their input side — an `output` rendering would advertise
      // fields the model is not allowed to pass.
      pipeStrategy: 'input',
    }),
  ) as ToolInputSchema;
}
