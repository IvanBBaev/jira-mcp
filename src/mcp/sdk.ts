// ---------------------------------------------------------------------------
// The MCP SDK seam (V3-61 / D539, ARC-10).
//
// This is the only production module that imports `@modelcontextprotocol/sdk`.
// Every other module takes the SDK surface it needs from here, so an SDK major
// or the 3.0 wire (V3-28) changes one file, not nine. The eslint rule
// `@typescript-eslint/no-restricted-imports` bans the SDK specifier everywhere
// else in `src/` except tests, which drive the server through the SDK's client
// side (`Client`, `InMemoryTransport`) as an outside caller would.
//
// Re-exports only: no behaviour lives here. Adding a symbol means re-exporting
// it here first; the names stay the SDK's own so a reader can look them up.
//
// The Streamable HTTP transport is the one exception to a static re-export:
// stdio sessions must never load it (or the HTTP stack behind it), so it is
// reached through `loadStreamableHttpTransport()`, which `transport-http.ts`
// awaits when it starts. Its type is re-exported statically (erased at build).
// ---------------------------------------------------------------------------

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export type { StreamableHTTPServerTransport };
export { Server } from '@modelcontextprotocol/sdk/server/index.js';
export { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
export { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
export {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
export type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
export type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
export type {
  CallToolResult,
  CompleteRequest,
  CompleteResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The Streamable HTTP server transport class, loaded on demand so the stdio
 * path never pulls in the HTTP stack.
 */
export async function loadStreamableHttpTransport(): Promise<
  typeof StreamableHTTPServerTransport
> {
  const sdk = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  return sdk.StreamableHTTPServerTransport;
}
