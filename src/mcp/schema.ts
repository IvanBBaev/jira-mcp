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

import { toJsonSchemaCompat } from './sdk.js';
import type { AnyObjectSchema, Tool } from './sdk.js';

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
 * One conversion per spec for the life of the process (D519). The manifest is
 * frozen and the conversion pure, so `tools/list`, the per-tool reference and
 * every HTTP session's `buildServer` share the result instead of each paying
 * for it again. Keyed weakly on the spec object, so a test's throwaway spec
 * leaves nothing behind.
 */
const converted = new WeakMap<AnyToolSpec, ToolInputSchema>();

/**
 * The input schema of one tool as a client sees it (CC-81: no `$ref`;
 * CC-1416: no `$schema`, no safe-integer bounds). Converted on first use and
 * memoised per spec (D519); the returned tree is frozen at every depth, because
 * every caller now holds the same object.
 */
export function toInputSchema(spec: AnyToolSpec): ToolInputSchema {
  const cached = converted.get(spec);
  if (cached !== undefined) return cached;
  const schema = deepFreeze(convert(spec));
  converted.set(spec, schema);
  return schema;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function convert(spec: AnyToolSpec): ToolInputSchema {
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
