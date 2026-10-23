// Tests for the Markdown/Mermaid report renderer (D126).
//
// What these tests pin down:
//   * CC-1437 — Jira text cannot break out of its sink: a quote, pipe, angle
//     bracket, backtick, bracket or newline in a summary is escaped for the
//     Mermaid label and the table cell it lands in;
//   * CC-1438 — every section renders, an empty finding list says so, an
//     incomplete sweep is flagged at the top, and an oversized hierarchy
//     diagram stops at MAX_DIAGRAM_NODES with a note.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SearchIssue } from '../api/search.js';
import { analysePortfolio } from './portfolio-analysis.js';
import {
  MAX_DIAGRAM_NODES,
  cell,
  mermaidId,
  mermaidText,
  renderPortfolioReport,
  type ReportMeta,
} from './portfolio-render.js';

function row(
  key: string,
  summary: string,
  extra: Record<string, unknown> = {},
): SearchIssue {
  return {
    id: key,
    key,
    fields: {
      summary,
      project: { key: key.slice(0, key.lastIndexOf('-')) },
      issuetype: { name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      ...extra,
    },
  };
}

const META: ReportMeta = {
  title: 'Q4 review',
  generatedAt: '2026-10-24T10:15:00.000Z',
  jql: 'project in ("WEB", "MOB") ORDER BY key ASC',
  partial: false,
};

test('[CC-1437] mermaidText neutralises every character that ends or reshapes a label', () => {
  assert.equal(
    mermaidText('Fix "login" | <b>bold</b> `code` [x] {y} (z) #1\nnext'),
    'Fix #quot;login#quot; #lt;b#gt;bold#lt;/b#gt; #96;code#96; x y z #35;1 next',
  );
  assert.equal(mermaidId('WEB-12'), 'n_WEB_12');
  assert.equal(mermaidId('a.b c'), 'n_a_b_c');
});

test('[CC-1437] cell keeps a summary inside its table cell', () => {
  assert.equal(cell('a | b\\c <x> `y`\n z'), "a \\| b\\\\c &lt;x&gt; 'y' z");
});

test('[CC-1437] a hostile summary cannot open a new line, cell or diagram in the report', () => {
  const hostile = 'Export invoices "] --> X\n```\n| injected | row |';
  const analysis = analysePortfolio([
    row('WEB-1', hostile),
    row('MOB-1', 'Export invoices "] --> X'),
  ]);
  const report = renderPortfolioReport(analysis, META);
  // Fences: only the ones the renderer opened and closed — every diagram is balanced.
  const fences = report.split('\n').filter((line) => line.startsWith('```'));
  assert.equal(fences.length % 2, 0);
  assert.ok(fences.every((line) => line === '```' || line === '```mermaid'));
  assert.ok(!report.includes('\n| injected'));
  assert.ok(!report.includes('"] -->'));
  assert.ok(report.endsWith('\n') && !report.endsWith('\n\n'));
});

test('[CC-1438] every section renders and empty findings say so', () => {
  const report = renderPortfolioReport(
    analysePortfolio([row('WEB-1', 'Alpha beta'), row('MOB-1', 'Gamma delta')]),
    { ...META, boards: { WEB: ['Web board'], MOB: [] } },
  );
  for (const heading of [
    '# Q4 review',
    '## Summary',
    '## Duplicate and overlapping work',
    '## Hierarchy',
    '### MOB',
    '### WEB',
  ]) {
    assert.ok(
      report.includes(`\n${heading}\n`) || report.startsWith(`${heading}\n`),
      heading,
    );
  }
  assert.ok(report.includes('| **WEB** | Web board | 1 | 1 | 0 |'));
  assert.ok(report.includes('| **MOB** | (none) | 1 | 1 | 0 |'));
  assert.ok(report.includes('_None found._'));
  assert.ok(!report.includes('## Findings map'), 'no edges, no map');
  assert.ok(!report.includes('Incomplete sweep'));
  assert.ok(report.includes('third-party content'));
});

test('[CC-1438] findings fill the map and the tables; an incomplete sweep is flagged', () => {
  const analysis = analysePortfolio([
    row('WEB-1', 'Export invoices to CSV', {
      issuelinks: [
        {
          type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
          inwardIssue: { key: 'API-1' },
        },
      ],
    }),
    row('MOB-1', 'Export invoices to CSV'),
    row('API-1', 'Export invoices to CSV', {
      status: { name: 'Done', statusCategory: { key: 'done' } },
    }),
  ]);
  const report = renderPortfolioReport(analysis, {
    ...META,
    partial: true,
    partialNote: 'Only the first 300 issues were read.',
  });
  assert.ok(
    report.includes('> **Incomplete sweep.** Only the first 300 issues were read.'),
  );
  assert.ok(report.includes('## Findings map'));
  assert.ok(report.includes('n_MOB_1 -.-|"duplicate 1"| n_WEB_1'));
  assert.ok(report.includes('n_API_1 ==>|"reuse 1"| n_MOB_1'));
  assert.ok(report.includes('n_API_1 -->|blocks| n_WEB_1'));
  assert.ok(report.includes('subgraph n_p_API["API"]'));
});

test('[CC-1438] a hierarchy diagram stops at MAX_DIAGRAM_NODES and says how many were left out', () => {
  const rows: SearchIssue[] = [];
  const total = MAX_DIAGRAM_NODES + 5;
  for (let i = 1; i <= total; i += 1)
    rows.push(row(`WEB-${String(i)}`, `Item ${String(i)}`));
  const report = renderPortfolioReport(analysePortfolio(rows), META);
  const nodeLines = report.split('\n').filter((line) => /^ {2}n_WEB_\d+\[/.test(line));
  assert.equal(nodeLines.length, MAX_DIAGRAM_NODES);
  assert.ok(
    report.includes('_5 more issues of this project are in the outline but not shown'),
  );
  // The outline still lists every issue.
  assert.equal(
    report.split('\n').filter((line) => line.startsWith('- **WEB-')).length,
    total,
  );
});
