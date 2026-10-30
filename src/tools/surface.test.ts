// ---------------------------------------------------------------------------
// The surface ratchet (D510): what `tools/list` costs a client, per profile.
//
// Every tool a profile lists is context a model pays for on every turn in a
// client without tool search, and the list only ever grew: D124 trimmed it to
// 93,722 characters at 59 tools, and nothing noticed it climb past 145k at 82.
// This test pins each `JIRA_TOOL_PACKAGES` profile to the measured figures in
// `test/surface-budget.json` and caps every single tool, so a change that grows
// the surface has to say so by re-baselining the budget in the same commit.
//
// Two measures, kept apart on purpose (MCP-15):
//  - model-visible: name + description + input schema, which is what a client
//    hands the model (the Anthropic tool format carries no `outputSchema`);
//  - wire: the whole serialised `tools/list` result, `outputSchema`,
//    annotations and `_meta` included.
//
// It is a ratchet both ways: a profile more than the tolerance OVER its budget
// fails, and so does one more than the tolerance UNDER it, so room a trim frees
// is not silently there for the next change to grow into. The README states the
// budgeted figures; this test checks that it still does.
//
// It lives in the tools ring, not in mcp/, because only a composition root may
// see both the manifest and the server's `toMcpTool` (eslint layer zones).
//
// Re-baseline (rewrites the budget; then update the README table it prints):
//     npm run build && UPDATE_SURFACE_BUDGET=1 node --import ./build/testing/network-fence.js \
//       --test "build/tools/surface.test.js"
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { FAKE_AUTH_SETTINGS } from '../core/fakes/index.js';
import type { Settings } from '../core/types.js';
import { selectPackages } from '../mcp/registry.js';
import { toMcpTool } from '../mcp/server.js';
import { PACKAGE_PROFILES, type PackageProfile } from '../mcp/types.js';

import { PACKAGES } from './index.js';

const BUDGET_URL = new URL('../../test/surface-budget.json', import.meta.url);
const README_URL = new URL('../../README.md', import.meta.url);
const UPDATE_COMMAND =
  'npm run build && UPDATE_SURFACE_BUDGET=1 node --import ./build/testing/network-fence.js --test "build/tools/surface.test.js"';

/** How far a profile may drift from its budget before the test asks for a re-baseline. */
const TOLERANCE = 0.02;

/** No single tool may cost a model more than this many characters. */
const PER_TOOL_CAP = 4_000;

interface ProfileFigures {
  readonly tools: number;
  readonly modelVisible: number;
  readonly wire: number;
}

interface SurfaceBudget {
  readonly tolerance: number;
  readonly perToolCap: number;
  readonly profiles: Readonly<Record<PackageProfile, ProfileFigures>>;
}

const BASE_SETTINGS: Settings = {
  site: 'example.atlassian.net',
  allowedHosts: [],
  profiles: {},
  lockProfile: true,
  toolPackages: ['all'],
  packagesDeny: [],
  packagesReadonly: [],
  writeMode: 'plan',
  allowIrreversible: false,
  irreversibleConfirm: 'off',
  requestTimeoutMs: 30_000,
  callBudgetMs: 120_000,
  hostConcurrency: 4,
  retryAttempts: 3,
  maxResultChars: 25_000,
  maxPages: 20,
  metaCacheTtlS: 300,
  mediaMaxBytes: 1073741824,
  transport: 'stdio',
  httpPort: 3334,
  logLevel: 'info',
  ...FAKE_AUTH_SETTINGS,
};

/** The `tools/list` entries a default-configured server lists under `profile`. */
function listedTools(profile: PackageProfile): Tool[] {
  const settings: Settings = { ...BASE_SETTINGS, toolPackages: [profile] };
  const hints = { maxResultChars: settings.maxResultChars };
  return selectPackages(PACKAGES, settings)
    .packages.flatMap((pkg) => pkg.tools)
    .map((spec) => toMcpTool(spec, hints));
}

/** Name + description + input schema: what the model is handed for one tool. */
function modelVisible(tool: Tool): number {
  return (
    tool.name.length +
    (tool.description ?? '').length +
    JSON.stringify(tool.inputSchema).length
  );
}

function measure(profile: PackageProfile): ProfileFigures {
  const tools = listedTools(profile);
  return {
    tools: tools.length,
    modelVisible: tools.reduce((sum, tool) => sum + modelVisible(tool), 0),
    wire: JSON.stringify({ tools }).length,
  };
}

/** `113,600` → `114k`, `2,742` → `2.7k`: the precision the README quotes. */
function roughThousands(chars: number): string {
  const k = chars / 1_000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/** The README table row for one profile, rendered from its budget. */
function readmeRow(profile: PackageProfile, figures: ProfileFigures): string {
  const label = profile === 'all' ? '`all` (default)' : `\`${profile}\``;
  return `| ${label} | ${figures.tools} | ${roughThousands(figures.modelVisible)} | ${roughThousands(figures.wire)} |`;
}

const measured = Object.fromEntries(
  PACKAGE_PROFILES.map((profile) => [profile, measure(profile)]),
) as Record<PackageProfile, ProfileFigures>;

if (process.env.UPDATE_SURFACE_BUDGET === '1') {
  const next: SurfaceBudget = {
    tolerance: TOLERANCE,
    perToolCap: PER_TOOL_CAP,
    profiles: measured,
  };
  writeFileSync(BUDGET_URL, `${JSON.stringify(next, null, 2)}\n`);
  process.stderr.write(
    `surface budget rewritten; README rows:\n${PACKAGE_PROFILES.map((p) => readmeRow(p, measured[p])).join('\n')}\n`,
  );
}

const budget = JSON.parse(readFileSync(BUDGET_URL, 'utf8')) as SurfaceBudget;

test('[D510] the budget file holds the constants this test enforces', () => {
  assert.equal(budget.tolerance, TOLERANCE);
  assert.equal(budget.perToolCap, PER_TOOL_CAP);
  assert.deepEqual(Object.keys(budget.profiles).sort(), [...PACKAGE_PROFILES].sort());
});

test('[D510] every profile lists the budgeted number of tools', () => {
  for (const profile of PACKAGE_PROFILES) {
    assert.equal(
      measured[profile].tools,
      budget.profiles[profile].tools,
      `${profile}: the tool count changed — re-baseline with: ${UPDATE_COMMAND}`,
    );
  }
});

test('[D510] every profile stays within its budget, both ways', () => {
  for (const profile of PACKAGE_PROFILES) {
    for (const key of ['modelVisible', 'wire'] as const) {
      const actual = measured[profile][key];
      const allowed = budget.profiles[profile][key];
      const drift = (actual - allowed) / allowed;
      assert.ok(
        Math.abs(drift) <= TOLERANCE,
        `${profile} ${key}: ${actual} chars vs a budget of ${allowed} ` +
          `(${(drift * 100).toFixed(1)} %, tolerance ±${TOLERANCE * 100} %). ` +
          `If the change is deliberate, re-baseline with: ${UPDATE_COMMAND}`,
      );
    }
  }
});

test('[D510] no tool costs a model more than the per-tool cap', () => {
  for (const tool of listedTools('all')) {
    const size = modelVisible(tool);
    assert.ok(
      size <= PER_TOOL_CAP,
      `${tool.name} is ${size} model-visible chars, over the ${PER_TOOL_CAP} cap: ` +
        'move examples and caveats to its reference resource (D124).',
    );
  }
});

test('[D510] the README quotes the budgeted figure for every profile', () => {
  const readme = readFileSync(README_URL, 'utf8');
  for (const profile of PACKAGE_PROFILES) {
    const row = readmeRow(profile, budget.profiles[profile]);
    assert.ok(readme.includes(row), `README.md is missing the row:\n${row}`);
  }
});

test('[D510] roughThousands rounds the way the README quotes', () => {
  assert.equal(roughThousands(113_600), '114k');
  assert.equal(roughThousands(10_000), '10k');
  assert.equal(roughThousands(2_742), '2.7k');
});
