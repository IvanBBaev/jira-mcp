// V3-61 / D539: `src/mcp/sdk.ts` is the one production module that imports the
// MCP SDK. Static imports and re-exports are banned elsewhere by
// `@typescript-eslint/no-restricted-imports`, a dynamic `import()` by a
// `no-restricted-syntax` selector. This fixture pins that both fire in every
// layer and stay quiet in the seam itself and in tests.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

const FIXTURE = [
  "import { McpError } from '@modelcontextprotocol/sdk/types.js';",
  "import type { Tool } from '@modelcontextprotocol/sdk/types.js';",
  "export { Server } from '@modelcontextprotocol/sdk/server/index.js';",
  '',
  'export async function load(): Promise<unknown> {',
  "  return import('@modelcontextprotocol/sdk/server/stdio.js');",
  '}',
  '',
  'export function make(tool: Tool): McpError {',
  '  return new McpError(0, tool.name);',
  '}',
  '',
].join('\n');

const SEAM = /src\/mcp\/sdk\.ts/;

async function seamHits(filePath: string): Promise<number[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(FIXTURE, { filePath });
  assert.ok(result);
  return result.messages
    .filter(
      (message) =>
        (message.ruleId === '@typescript-eslint/no-restricted-imports' ||
          message.ruleId === 'no-restricted-syntax') &&
        SEAM.test(message.message),
    )
    .map((message) => message.line);
}

describe('MCP SDK seam lint rule (V3-61)', () => {
  it('fires on static, type-only, re-export and dynamic SDK imports in every layer', async () => {
    for (const file of [
      'src/mcp/server.ts',
      'src/mcp/define.ts',
      'src/core/http-util.ts',
      'src/api/shared.ts',
      'src/tools/index.ts',
      'src/index.ts',
    ]) {
      assert.deepEqual(await seamHits(file), [1, 2, 3, 6], file);
    }
  });

  it('stays quiet in the seam itself and in tests', async () => {
    for (const file of ['src/mcp/sdk.ts', 'src/mcp/server.test.ts']) {
      assert.deepEqual(await seamHits(file), [], file);
    }
  });
});
