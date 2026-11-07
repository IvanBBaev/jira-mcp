// ---------------------------------------------------------------------------
// Paging documentation (V3-64, MCP-R6, CC-5360–5369).
//
// Paging is still spelled several ways across the 1.x surface (`data.` vs
// `paging.`, `nextStartAt` vs `nextPageToken`), and the page caps differ by
// tool. Until 2.0 moves continuation to one shape (V3-24), every paged tool's
// own description says both facts in one sentence — "One page per call, max N
// rows" plus the field to continue with — so a model never has to guess either.
//
// The table below names every tool that takes `maxResults`. A new paged tool
// fails here until it has an entry, and an entry whose cap or continuation the
// description no longer names fails too. The cap is read back from the
// argument's own description (`1…N`, D508), so the prose cannot drift from the
// value the handler clamps to.
//
// This lives in `src/tools`, not `src/mcp`: the mcp zone may not import the
// manifest (same placement as the abort contract, V3-58).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AnyToolSpec } from '../mcp/types.js';

import { PACKAGES } from './index.js';

interface PagingDoc {
  /** The page cap the handler clamps to; `null` when Jira alone sets it. */
  readonly cap: number | null;
  /** Every field the description must name for continuing a partial read. */
  readonly continuation: readonly string[];
}

const PAGING_DOCS: Readonly<Record<string, PagingDoc>> = {
  jira_search: { cap: 100, continuation: ['data.nextPageToken'] },
  jira_list_filters: {
    cap: null,
    continuation: ['paging.partial', 'paging.nextStartAt'],
  },
  jira_get_comments: { cap: 100, continuation: ['data.partial', 'data.nextStartAt'] },
  jira_get_changelog: { cap: 100, continuation: ['data.nextStartAt'] },
  jira_get_changelogs_bulk: {
    cap: 1000,
    continuation: ['data.hasMore', 'data.nextPageToken'],
  },
  jira_get_worklogs: { cap: 100, continuation: ['data.partial', 'data.nextStartAt'] },
  jira_list_components: {
    cap: 50,
    continuation: ['paging.partial', 'paging.nextStartAt'],
  },
  jira_list_versions: { cap: 50, continuation: ['paging.partial', 'paging.nextStartAt'] },
  jira_search_users: { cap: 100, continuation: ['paging.partial', 'paging.nextStartAt'] },
  jira_list_boards: { cap: 50, continuation: ['paging.partial', 'paging.nextStartAt'] },
  jira_list_sprints: { cap: 50, continuation: ['paging.partial', 'paging.nextStartAt'] },
  jira_get_sprint_issues: {
    cap: 50,
    continuation: ['paging.partial', 'paging.nextPageToken', 'paging.nextStartAt'],
  },
  jira_get_backlog: { cap: 50, continuation: ['paging.partial', 'paging.nextPageToken'] },
};

const ALL_TOOLS: readonly AnyToolSpec[] = PACKAGES.flatMap((pkg) => pkg.tools);

/** The description of a tool's `maxResults` argument, when it takes one. */
function maxResultsDescription(spec: AnyToolSpec): string | undefined {
  const shape = (spec.input as { shape?: Record<string, { description?: string }> })
    .shape;
  const arg = shape?.['maxResults'];
  return arg === undefined ? undefined : (arg.description ?? '');
}

const PAGED_TOOLS = ALL_TOOLS.filter((spec) => maxResultsDescription(spec) !== undefined);

/** The cap in the shared argument's prose (`Rows per page, 1…N`, D508). */
function argCap(spec: AnyToolSpec): number | null {
  const match = /1…(\d+)/u.exec(maxResultsDescription(spec) ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Every `max N rows` the tool description states. */
function describedCaps(spec: AnyToolSpec): number[] {
  return [...spec.description.matchAll(/max (\d+) rows/gu)].map((m) => Number(m[1]));
}

function docOf(spec: AnyToolSpec): PagingDoc {
  const doc = PAGING_DOCS[spec.name];
  assert.ok(doc, `${spec.name} takes maxResults but has no PAGING_DOCS entry`);
  return doc;
}

test('CC-5360: the table names every tool that takes maxResults, and only those', () => {
  assert.deepEqual(
    PAGED_TOOLS.map((spec) => spec.name).sort(),
    Object.keys(PAGING_DOCS).sort(),
  );
});

test('CC-5361: every capped paged description names its cap, matching the argument', () => {
  for (const spec of PAGED_TOOLS) {
    const doc = docOf(spec);
    if (doc.cap === null) continue;
    assert.equal(argCap(spec), doc.cap, `${spec.name}: maxResults argument cap`);
    assert.deepEqual(describedCaps(spec), [doc.cap], `${spec.name}: description cap`);
    assert.match(spec.description, /One page per call, max \d+ rows/iu, spec.name);
  }
});

test('CC-5362: an uncapped paged description says Jira sets the max', () => {
  const uncapped = PAGED_TOOLS.filter((spec) => docOf(spec).cap === null);
  assert.deepEqual(
    uncapped.map((spec) => spec.name),
    ['jira_list_filters'],
  );
  for (const spec of uncapped) {
    assert.equal(argCap(spec), null, spec.name);
    assert.deepEqual(describedCaps(spec), [], spec.name);
    assert.match(
      spec.description,
      /One page per call, \d+ rows by default \(Jira sets the max\)/u,
    );
    assert.match(maxResultsDescription(spec) ?? '', /Jira sets the max/u);
  }
});

test('CC-5363: every paged description names its continuation field', () => {
  for (const spec of PAGED_TOOLS) {
    for (const field of docOf(spec).continuation) {
      assert.ok(
        spec.description.includes(field),
        `${spec.name}: description does not name ${field}`,
      );
    }
  }
});
