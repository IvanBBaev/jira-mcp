// V3-13 / D518: the Cloud api modules never import the Data Center twins in
// `src/api/datacenter/`. The eslint `no-restricted-syntax` entry enforces it;
// this fixture pins that a static import fires in a Cloud module, that the
// compatibility `export … from` re-export stays allowed, and that the
// directory itself, the barrel and `adapters.ts` are exempt.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

const RULE = 'no-restricted-syntax';

async function zoneHits(code: string, filePath: string): Promise<number[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(result);
  return result.messages
    .filter((message) => message.ruleId === RULE && /D518/.test(message.message))
    .map((message) => message.line);
}

const IMPORTS = [
  "import { searchIssuesDataCenter } from './datacenter/search.js';",
  "import { DATACENTER_API } from './datacenter.js';",
  '',
  'export const both = [searchIssuesDataCenter, DATACENTER_API];',
  '',
].join('\n');

describe('Data Center zone lint rule (V3-13)', () => {
  it('fires on a Cloud api module that imports a datacenter module or the barrel', async () => {
    assert.deepEqual(await zoneHits(IMPORTS, 'src/api/search.ts'), [1, 2]);
  });

  it('fires in a nested Cloud module too', async () => {
    const code =
      "import { listChangelogDataCenter } from '../datacenter/issues.js';\n\nexport const f = listChangelogDataCenter;\n";
    assert.deepEqual(await zoneHits(code, 'src/api/issues/changelog.ts'), [1]);
  });

  it('allows the compatibility re-export', async () => {
    const code = "export { searchIssuesDataCenter } from './datacenter/search.js';\n";
    assert.deepEqual(await zoneHits(code, 'src/api/search.ts'), []);
  });

  it('exempts the datacenter directory, the barrel and adapters.ts', async () => {
    for (const file of [
      'src/api/datacenter/adapter.ts',
      'src/api/datacenter.ts',
      'src/api/adapters.ts',
    ]) {
      assert.deepEqual(await zoneHits(IMPORTS, file), [], file);
    }
  });
});
