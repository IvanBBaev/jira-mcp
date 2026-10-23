// Tests for the pure portfolio analysis (D126): normalisation, tokens,
// hierarchy, and the four finding kinds. No network, no clock — the module is
// a function of its rows.
//
// What these tests pin down:
//   * CC-1431 — normalisation reads the hierarchy level from `subtask`, then
//     `hierarchyLevel`, then the type name, and link direction from which side
//     Jira filled;
//   * CC-1432 — a child whose parent was not swept hangs under a stub node,
//     and a parent cycle still surfaces every member exactly once;
//   * CC-1433 — open/open pairs are duplicates or overlaps by threshold,
//     open/done pairs are reuse candidates, done/done pairs are dropped,
//     same-project pairs only on request, and epics never pair with stories;
//   * CC-1434 — a cross-project Blocks link is reported once, from the
//     waiting side, and a finished waiting side is not a dependency;
//   * CC-1435 — hotspots are case-folded and need two projects;
//   * CC-1436 — the result does not depend on row order, and pair lists are
//     capped at MAX_PAIR_FINDINGS with the cap reported.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SearchIssue } from '../api/search.js';
import {
  MAX_PAIR_FINDINGS,
  analysePortfolio,
  buildHierarchy,
  jaccard,
  normaliseIssue,
  tokenize,
} from './portfolio-analysis.js';

interface RowSpec {
  readonly summary: string;
  readonly done?: boolean;
  readonly type?: string;
  readonly hierarchyLevel?: number;
  readonly subtask?: boolean;
  readonly parent?: string;
  readonly labels?: readonly string[];
  readonly components?: readonly string[];
  readonly issuelinks?: readonly unknown[];
}

/** A raw search row, shaped like `/rest/api/3/search/jql` returns it. */
function row(key: string, spec: RowSpec): SearchIssue {
  const project = key.slice(0, key.lastIndexOf('-'));
  return {
    id: key,
    key,
    fields: {
      summary: spec.summary,
      project: { key: project },
      issuetype: {
        name: spec.type ?? 'Story',
        ...(spec.subtask === undefined ? {} : { subtask: spec.subtask }),
        ...(spec.hierarchyLevel === undefined
          ? {}
          : { hierarchyLevel: spec.hierarchyLevel }),
      },
      status: {
        name: spec.done === true ? 'Done' : 'In Progress',
        statusCategory: { key: spec.done === true ? 'done' : 'indeterminate' },
      },
      ...(spec.parent === undefined ? {} : { parent: { key: spec.parent } }),
      labels: spec.labels ?? [],
      components: (spec.components ?? []).map((name) => ({ name })),
      issuelinks: spec.issuelinks ?? [],
    },
  };
}

const BLOCKS = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };

// ---------------------------------------------------------------------------
// Normalisation and tokens
// ---------------------------------------------------------------------------

test('[CC-1431] the hierarchy level comes from subtask, then hierarchyLevel, then the name', () => {
  assert.equal(
    normaliseIssue(row('A-1', { summary: 'x', subtask: true })).level,
    'subtask',
  );
  assert.equal(
    normaliseIssue(row('A-2', { summary: 'x', hierarchyLevel: -1 })).level,
    'subtask',
  );
  assert.equal(
    normaliseIssue(row('A-3', { summary: 'x', hierarchyLevel: 1, type: 'Initiative' }))
      .level,
    'epic',
  );
  assert.equal(
    normaliseIssue(row('A-4', { summary: 'x', hierarchyLevel: 0, type: 'Epic' })).level,
    'standard',
  );
  assert.equal(normaliseIssue(row('A-5', { summary: 'x', type: 'Epic' })).level, 'epic');
  assert.equal(normaliseIssue(row('A-6', { summary: 'x' })).level, 'standard');
});

test('[CC-1431] links keep their direction, relation phrase and the other side status', () => {
  const issue = normaliseIssue(
    row('A-1', {
      summary: 'x',
      issuelinks: [
        {
          type: BLOCKS,
          inwardIssue: {
            key: 'B-1',
            fields: { status: { statusCategory: { key: 'done' } } },
          },
        },
        { type: BLOCKS, outwardIssue: { key: 'B-2' } },
        { type: { name: 'Relates' }, outwardIssue: { key: 'B-3' } },
        { type: BLOCKS }, // no other side — dropped
        { inwardIssue: { key: 'B-4' } }, // no type — dropped
      ],
    }),
  );
  assert.deepEqual(issue.links, [
    {
      type: 'Blocks',
      relation: 'is blocked by',
      direction: 'inward',
      key: 'B-1',
      statusCategory: 'done',
    },
    { type: 'Blocks', relation: 'blocks', direction: 'outward', key: 'B-2' },
    { type: 'Relates', relation: 'Relates', direction: 'outward', key: 'B-3' },
  ]);
});

test('[CC-1431] the project falls back to the key prefix and blanks are dropped', () => {
  const issue = normaliseIssue({
    id: '1',
    key: 'MY_PROJ-12',
    fields: {
      summary: '  ',
      labels: ['ok', ' ', 3],
      components: [{ name: '' }, { name: 'UI' }],
    },
  });
  assert.equal(issue.project, 'MY_PROJ');
  assert.equal(issue.summary, '');
  assert.deepEqual(issue.labels, ['ok']);
  assert.deepEqual(issue.components, ['UI']);
  assert.equal(issue.statusCategory, undefined);
});

test('tokenize drops stop words, numbers and one-letter tokens, strips one inflection, and sorts', () => {
  assert.deepEqual(tokenize('Add the CSV exports for 2026 invoices'), [
    'csv',
    'export',
    'invoic',
  ]);
  assert.deepEqual(tokenize('Exported, exporting; EXPORT!'), ['export']);
  // Inflections meet their base form.
  for (const [a, b] of [
    ['invoice', 'invoices'],
    ['migrate', 'migrating'],
    ['create', 'created'],
    ['box', 'boxes'],
    ['class', 'classes'],
    ['status', 'statuses'],
  ] as const) {
    assert.deepEqual(tokenize(a), tokenize(b), `${a} / ${b}`);
  }
  // A stop word stays one in every inflection.
  assert.deepEqual(tokenize('updating added fixes'), []);
  // Unicode-aware: Cyrillic is tokenised, not stemmed.
  assert.deepEqual(tokenize('Експорт на фактури'), ['на', 'експорт', 'фактури'].sort());
});

test('jaccard is shared over union and zero for two empty lists', () => {
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a'], ['a']), 1);
});

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

test('[CC-1432] a child of an unswept parent hangs under a stub, filed under the parent project', () => {
  const issues = [
    row('A-1', { summary: 'Epic one', type: 'Epic' }),
    row('A-2', { summary: 'Story', parent: 'A-1' }),
    row('A-3', { summary: 'Sub', parent: 'A-2', subtask: true }),
    row('B-1', { summary: 'Orphan', parent: 'C-9' }),
    row('B-2', { summary: 'Cross child', parent: 'A-1' }),
  ].map(normaliseIssue);
  const tree = buildHierarchy(issues);
  assert.deepEqual(
    tree.map((p) => [p.project, p.issueCount, p.roots.map((r) => r.key)]),
    [
      ['A', 3, ['A-1']],
      ['B', 2, []],
      ['C', 0, ['C-9']],
    ],
  );
  const epic = tree[0]?.roots[0];
  assert.deepEqual(
    epic?.children.map((c) => c.key),
    ['A-2', 'B-2'],
  );
  assert.deepEqual(
    epic?.children[0]?.children.map((c) => c.key),
    ['A-3'],
  );
  const stub = tree[2]?.roots[0];
  assert.equal(stub?.issue, undefined);
  assert.deepEqual(
    stub?.children.map((c) => c.key),
    ['B-1'],
  );
});

test('[CC-1432] a parent cycle surfaces every member exactly once', () => {
  const issues = [
    row('A-1', { summary: 'One', parent: 'A-2' }),
    row('A-2', { summary: 'Two', parent: 'A-1' }),
    row('A-3', { summary: 'Self', parent: 'A-3' }),
  ].map(normaliseIssue);
  const tree = buildHierarchy(issues);
  const seen: string[] = [];
  const walk = (
    nodes: readonly { key: string; children: readonly unknown[] }[],
  ): void => {
    for (const node of nodes) {
      seen.push(node.key);
      walk(node.children as typeof nodes);
    }
  };
  walk(tree.flatMap((p) => p.roots));
  assert.deepEqual(seen.sort(), ['A-1', 'A-2', 'A-3']);
});

// ---------------------------------------------------------------------------
// Pair findings
// ---------------------------------------------------------------------------

test('[CC-1433] open pairs across projects are duplicates or overlaps by threshold', () => {
  const analysis = analysePortfolio([
    row('WEB-1', { summary: 'Export invoices to CSV' }),
    row('MOB-1', { summary: 'Export invoices to CSV file' }),
    row('API-1', { summary: 'Export invoices as PDF' }),
  ]);
  assert.deepEqual(
    analysis.duplicates.map((f) => [f.kind, f.score, f.a.key, f.b.key, f.sharedTerms]),
    [
      // Shared terms are words from the summaries, not stems.
      ['duplicate', 0.75, 'MOB-1', 'WEB-1', ['csv', 'export', 'invoices']],
      ['overlap', 0.5, 'API-1', 'WEB-1', ['export', 'invoices']],
    ],
  );
  assert.deepEqual(analysis.reuse, []);
  assert.deepEqual(analysis.thresholds, { similarity: 0.5, duplicate: 0.75 });
});

test('[CC-1433] an open issue like finished work elsewhere is a reuse candidate; two done issues are not a finding', () => {
  const analysis = analysePortfolio([
    row('WEB-1', { summary: 'Single sign on with Okta', done: true }),
    row('MOB-1', { summary: 'Single sign on with Okta' }),
    row('API-1', { summary: 'Single sign on with Okta', done: true }),
  ]);
  assert.deepEqual(analysis.duplicates, []);
  assert.deepEqual(
    analysis.reuse.map((f) => [f.existing.key, f.candidate.key, f.score]),
    [
      ['API-1', 'MOB-1', 1],
      ['WEB-1', 'MOB-1', 1],
    ],
  );
});

test('[CC-1433] same-project pairs only on request; epics never pair with stories; links are reported', () => {
  const rows = [
    row('WEB-1', {
      summary: 'Payment retry queue',
      issuelinks: [{ type: { name: 'Duplicate' }, outwardIssue: { key: 'WEB-2' } }],
    }),
    row('WEB-2', { summary: 'Payment retry queue' }),
    row('MOB-1', { summary: 'Payment retry queue', type: 'Epic' }),
  ];
  assert.deepEqual(analysePortfolio(rows).duplicates, []);
  const same = analysePortfolio(rows, { includeSameProject: true }).duplicates;
  assert.deepEqual(
    same.map((f) => [f.a.key, f.b.key, f.linkedAs]),
    [['WEB-1', 'WEB-2', 'Duplicate']],
  );
});

test('[CC-1433] a summary under MIN_TOKENS terms is never paired, and the duplicate threshold never sits below the loose one', () => {
  const analysis = analysePortfolio(
    [row('A-1', { summary: 'Login' }), row('B-1', { summary: 'Login' })],
    { similarity: 0.9, duplicateSimilarity: 0.2 },
  );
  assert.deepEqual(analysis.duplicates, []);
  assert.deepEqual(analysis.thresholds, { similarity: 0.9, duplicate: 0.9 });
});

// ---------------------------------------------------------------------------
// Dependencies and hotspots
// ---------------------------------------------------------------------------

test('[CC-1434] a cross-project block is reported once, from the waiting side', () => {
  const analysis = analysePortfolio([
    row('WEB-1', {
      summary: 'Checkout page',
      issuelinks: [{ type: BLOCKS, inwardIssue: { key: 'API-1' } }],
    }),
    row('API-1', {
      summary: 'Checkout endpoint',
      issuelinks: [{ type: BLOCKS, outwardIssue: { key: 'WEB-1' } }],
    }),
    // Blocker outside the sweep, finished.
    row('WEB-2', {
      summary: 'Promo banner',
      issuelinks: [
        {
          type: BLOCKS,
          inwardIssue: {
            key: 'CMS-4',
            fields: { status: { statusCategory: { key: 'done' } } },
          },
        },
      ],
    }),
    // Same-project blocks are not a cross-board dependency.
    row('WEB-3', {
      summary: 'Cart',
      issuelinks: [{ type: BLOCKS, inwardIssue: { key: 'WEB-1' } }],
    }),
    // A finished waiting side no longer waits.
    row('API-2', {
      summary: 'Old',
      issuelinks: [
        {
          type: BLOCKS,
          outwardIssue: {
            key: 'WEB-9',
            fields: { status: { statusCategory: { key: 'done' } } },
          },
        },
      ],
    }),
  ]);
  assert.deepEqual(analysis.dependencies, [
    {
      blocked: 'WEB-1',
      blockedProject: 'WEB',
      blocker: 'API-1',
      blockerProject: 'API',
      linkType: 'Blocks',
      blockerDone: false,
    },
    {
      blocked: 'WEB-2',
      blockedProject: 'WEB',
      blocker: 'CMS-4',
      blockerProject: 'CMS',
      linkType: 'Blocks',
      blockerDone: true,
    },
  ]);
});

test('[CC-1435] hotspots are case-folded, open-only and need two projects', () => {
  const analysis = analysePortfolio([
    row('WEB-1', { summary: 'a b', components: ['Payments'], labels: ['solo'] }),
    row('MOB-1', { summary: 'c d', components: ['payments'] }),
    row('API-1', { summary: 'e f', components: ['PAYMENTS'], done: true }),
    row('API-2', { summary: 'g h', labels: ['solo'], done: true }),
  ]);
  assert.deepEqual(analysis.hotspots, [
    // The first spelling in key order names the area: MOB-1 before WEB-1.
    {
      area: 'component',
      name: 'payments',
      projects: ['MOB', 'WEB'],
      issues: { MOB: ['MOB-1'], WEB: ['WEB-1'] },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Determinism and caps
// ---------------------------------------------------------------------------

test('[CC-1436] row order and repeated rows do not change the result', () => {
  const rows = [
    row('WEB-10', { summary: 'Export invoices to CSV', components: ['Billing'] }),
    row('WEB-2', { summary: 'Import invoices from CSV', done: true }),
    row('MOB-1', { summary: 'Export invoices to CSV file', components: ['billing'] }),
    row('API-3', { summary: 'Invoice CSV export endpoint', parent: 'API-1' }),
  ];
  const forward = analysePortfolio(rows);
  const backward = analysePortfolio([...rows].reverse().concat(rows));
  assert.deepEqual(backward, forward);
  assert.equal(forward.issueCount, 4);
  assert.equal(forward.openCount, 3);
  // Natural key order: WEB-2 before WEB-10.
  const web = forward.hierarchy.find((p) => p.project === 'WEB');
  assert.deepEqual(
    web?.roots.map((r) => r.key),
    ['WEB-2', 'WEB-10'],
  );
});

test('[CC-1436] pair findings are capped and the cap is reported', () => {
  // 15 × 15 identical cross-project summaries are 225 duplicate pairs.
  const rows: SearchIssue[] = [];
  for (let i = 0; i < 15; i += 1) {
    rows.push(row(`A-${String(i + 1)}`, { summary: 'alpha beta gamma' }));
    rows.push(row(`B-${String(i + 1)}`, { summary: 'alpha beta gamma' }));
  }
  // On their own, 30 issues all sharing every token trip the common-token
  // cut-off (a token in over 25% of 20+ issues is not evidence), so nothing pairs.
  assert.equal(analysePortfolio(rows).duplicates.length, 0);

  // Diluted by 100 unrelated issues the terms are uncommon again: 225 pairs, capped.
  const wide: SearchIssue[] = [];
  for (let i = 0; i < 15; i += 1) {
    wide.push(row(`A-${String(i + 1)}`, { summary: 'alpha beta gamma' }));
    wide.push(row(`B-${String(i + 1)}`, { summary: 'alpha beta gamma' }));
  }
  for (let i = 0; i < 100; i += 1) {
    wide.push(
      row(`C-${String(i + 1)}`, { summary: `filler${String(i)} noise${String(i)}` }),
    );
  }
  const analysis = analysePortfolio(wide);
  assert.equal(analysis.duplicates.length, MAX_PAIR_FINDINGS);
  assert.equal(analysis.findingsCapped, true);
});
