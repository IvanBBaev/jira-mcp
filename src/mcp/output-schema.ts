// ---------------------------------------------------------------------------
// The `outputSchema` every tool declares (D131).
//
// `structuredContent` has always been the result envelope (TOOLS.md §Result
// envelope); this module states that shape as JSON Schema so a client can
// validate it and a program can type it without reading TOOLS.md. It is the
// ENVELOPE only: `data` stays unconstrained, because per-tool data schemas
// would multiply the `tools/list` bytes D124 trimmed and drift from
// handlers no compiler checks them against.
//
// The schema has to accept every envelope `mcp/result.ts` can emit, failures
// included — the SDK client validates `structuredContent` whenever it is
// present, and a schema that rejected an `ok: false` envelope would turn a
// readable failure into a protocol error. Hence only `ok` is required: `data`
// is gone at the truncation floor, `error` exists only on failures, and
// `hints` is omitted when empty. Unknown members stay allowed, so adding an
// envelope field later is not a breaking change for a validating client.
// ---------------------------------------------------------------------------

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * JSON Schema of {@link ToolResult}, as `tools/list` advertises it: the member
 * names and their JSON types, nothing deeper. Spelling out `error`, `hints` and
 * `_truncation` field by field measured 786 bytes per tool — about 49 KB across
 * 61 tools, a third of the whole list — for structure TOOLS.md already states.
 */
export const ENVELOPE_OUTPUT_SCHEMA: Tool['outputSchema'] = Object.freeze({
  type: 'object' as const,
  properties: {
    ok: { type: 'boolean' },
    data: {},
    error: { type: 'object' },
    hints: { type: 'array' },
    _truncation: { type: 'object' },
    _untrusted: { const: true },
  },
  required: ['ok'],
});
