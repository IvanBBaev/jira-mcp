// ---------------------------------------------------------------------------
// Portfolio analysis — the pure half of package `portfolio` (TOOLS.md §Package
// `portfolio`, D126).
//
// Given the raw issue rows of a bounded search sweep, this module builds the
// local hierarchy (project → parent → child) and the cross-project findings:
//
//   * duplicates — two OPEN issues in different projects whose summaries say
//     the same thing (`duplicate` at or above the strict threshold, `overlap`
//     above the loose one);
//   * reuse — an OPEN issue that resembles a DONE one in another project, so
//     the finished work can be reused instead of rebuilt;
//   * dependencies — open issues linked by a blocking link across projects,
//     where one board's plan waits on another's;
//   * hotspots — a component or label carried by open work in two or more
//     projects at once, where parallel changes can collide.
//
// NOTHING HERE TOUCHES JIRA, THE CLOCK OR THE DISK. The handler in
// `portfolio.ts` does the sweep and hands this module plain rows; the report
// renderer (`portfolio-render.ts`) turns the result into Markdown. Keeping the
// analysis pure is what lets every rule be tested on literal rows.
//
// SIMILARITY IS LEXICAL, ON PURPOSE. Summaries are tokenised (Unicode letters
// and digits, lower case, a short English stop list, a light plural/tense
// strip) and compared with the Jaccard index. A model is far better at
// judging meaning, but it cannot compare 500 summaries pairwise within one
// result budget — this narrows 125,000 pairs to the few dozen worth a look,
// and every finding carries the shared terms so the reader can see why it was
// raised. The findings are candidates, never verdicts.
//
// The rows are RAW Jira fields, read defensively: a field the tenant hid or
// the sweep did not request is simply absent from the normalised issue.
// ---------------------------------------------------------------------------

import type { SearchIssue } from '../api/search.js';

// ---------------------------------------------------------------------------
// 1. Vocabulary
// ---------------------------------------------------------------------------

/** The fields a portfolio sweep requests. Everything below reads only these. */
export const PORTFOLIO_FIELDS = Object.freeze([
  'summary',
  'status',
  'issuetype',
  'project',
  'parent',
  'labels',
  'components',
  'fixVersions',
  'issuelinks',
  'assignee',
  'updated',
] as const);

/** Default loose threshold: at or above it a pair is reported at all. */
export const DEFAULT_SIMILARITY = 0.5;

/** Default strict threshold: at or above it two open issues are a `duplicate`. */
export const DEFAULT_DUPLICATE_SIMILARITY = 0.75;

/**
 * Most pairs per finding list. A sweep of 1,000 near-identical summaries
 * would otherwise yield half a million pairs; the strongest are kept.
 */
export const MAX_PAIR_FINDINGS = 200;

/** Fewest meaningful tokens a summary needs before it is compared at all. */
export const MIN_TOKENS = 2;

/**
 * A token carried by more than this share of the swept issues is ignored for
 * candidate generation — "api", "page" or a product name on every summary says
 * nothing about which two issues are alike.
 */
const COMMON_TOKEN_SHARE = 0.25;

/** Below this many issues the common-token rule is off: a share of 3 is noise. */
const COMMON_TOKEN_MIN_ISSUES = 20;

/**
 * English filler. Short on purpose: every word added here is a word two
 * genuinely similar summaries can no longer share.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'when',
  'should',
  'can',
  'not',
  'new',
  'add',
  'update',
  'fix',
  'issue',
  'story',
  'task',
  'bug',
]);

/** Jira's three status categories, as the `statusCategory.key` field spells them. */
export type StatusCategory = 'new' | 'indeterminate' | 'done';

/** Where an issue sits in the hierarchy. */
export type IssueLevel = 'epic' | 'standard' | 'subtask';

/** One issue link as the analysis needs it. */
export interface PortfolioLink {
  /** The link type's name — `Blocks`, `Duplicate`, `Relates`. */
  readonly type: string;
  /** The phrase from this issue's side — `blocks`, `is blocked by`. */
  readonly relation: string;
  readonly direction: 'inward' | 'outward';
  readonly key: string;
  /** The other issue's status category, when Jira sent it. */
  readonly statusCategory?: StatusCategory;
}

/** A swept issue, normalised from raw fields. */
export interface PortfolioIssue {
  readonly key: string;
  readonly project: string;
  readonly summary: string;
  readonly type?: string;
  readonly level: IssueLevel;
  readonly status?: string;
  readonly statusCategory?: StatusCategory;
  readonly parentKey?: string;
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly fixVersions: readonly string[];
  readonly links: readonly PortfolioLink[];
  readonly assignee?: string;
  readonly updated?: string;
}

// ---------------------------------------------------------------------------
// 2. Normalisation
// ---------------------------------------------------------------------------

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function categoryOf(status: unknown): StatusCategory | undefined {
  const key = text(record(record(status)?.statusCategory)?.key);
  return key === 'new' || key === 'indeterminate' || key === 'done' ? key : undefined;
}

/** Names of a `[{ name }]` list — components and versions. */
function names(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const name = text(record(entry)?.name);
    if (name !== undefined) out.push(name);
  }
  return out;
}

function labelsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((label) => {
    const name = text(label);
    return name === undefined ? [] : [name];
  });
}

function levelOf(issueType: Readonly<Record<string, unknown>> | undefined): IssueLevel {
  if (issueType === undefined) return 'standard';
  if (issueType.subtask === true) return 'subtask';
  const hierarchyLevel = issueType.hierarchyLevel;
  if (typeof hierarchyLevel === 'number') {
    if (hierarchyLevel < 0) return 'subtask';
    if (hierarchyLevel >= 1) return 'epic';
    return 'standard';
  }
  return text(issueType.name)?.toLowerCase() === 'epic' ? 'epic' : 'standard';
}

function linksOf(value: unknown): readonly PortfolioLink[] {
  if (!Array.isArray(value)) return [];
  const out: PortfolioLink[] = [];
  for (const entry of value) {
    const link = record(entry);
    const type = record(link?.type);
    const typeName = text(type?.name);
    if (link === undefined || typeName === undefined) continue;
    const outward = record(link.outwardIssue);
    const inward = record(link.inwardIssue);
    const other = outward ?? inward;
    const key = text(other?.key);
    if (key === undefined) continue;
    const direction = outward === undefined ? 'inward' : 'outward';
    const relation =
      text(direction === 'outward' ? type?.outward : type?.inward) ?? typeName;
    const statusCategory = categoryOf(record(other?.fields)?.status);
    out.push({
      type: typeName,
      relation,
      direction,
      key,
      ...(statusCategory === undefined ? {} : { statusCategory }),
    });
  }
  return out;
}

/** The project key of `ABC-12` — the fallback when `project` was not sent. */
function projectOfKey(key: string): string {
  const dash = key.lastIndexOf('-');
  return dash > 0 ? key.slice(0, dash) : key;
}

/** Normalise one raw search row. */
export function normaliseIssue(issue: SearchIssue): PortfolioIssue {
  const fields = issue.fields;
  const issueType = record(fields.issuetype);
  const status = record(fields.status);
  const project = text(record(fields.project)?.key) ?? projectOfKey(issue.key);
  const type = text(issueType?.name);
  const statusName = text(status?.name);
  const statusCategory = categoryOf(status);
  const parentKey = text(record(fields.parent)?.key);
  const assignee = text(record(fields.assignee)?.displayName);
  const updated = text(fields.updated);
  return {
    key: issue.key,
    project,
    summary: text(fields.summary) ?? '',
    ...(type === undefined ? {} : { type }),
    level: levelOf(issueType),
    ...(statusName === undefined ? {} : { status: statusName }),
    ...(statusCategory === undefined ? {} : { statusCategory }),
    ...(parentKey === undefined ? {} : { parentKey }),
    labels: labelsOf(fields.labels),
    components: names(fields.components),
    fixVersions: names(fields.fixVersions),
    links: linksOf(fields.issuelinks),
    ...(assignee === undefined ? {} : { assignee }),
    ...(updated === undefined ? {} : { updated }),
  };
}

/** An issue still being worked on — anything not in the `done` category. */
export function isOpen(issue: { readonly statusCategory?: StatusCategory }): boolean {
  return issue.statusCategory !== 'done';
}

// ---------------------------------------------------------------------------
// 3. Tokens and similarity
// ---------------------------------------------------------------------------

/**
 * Strip one common English inflection and a trailing `e`, so `exports`,
 * `exported` and `export` meet, and so do `invoices`/`invoice` and
 * `updating`/`update`. Deliberately small: a lexical hint, not a stemmer.
 */
function stem(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/u.test(token)) return token;
  let out = token;
  if (out.endsWith('ing') && out.length >= 6) out = out.slice(0, -3);
  else if (out.endsWith('ed') && out.length >= 5) out = out.slice(0, -2);
  else if (/(?:s|x|z|ch|sh)es$/u.test(out) && out.length >= 5) out = out.slice(0, -2);
  else if (out.endsWith('s') && !/(?:ss|us|is)$/u.test(out)) out = out.slice(0, -1);
  return out.length >= 5 && out.endsWith('e') ? out.slice(0, -1) : out;
}

/** The stop list in stem form, so `updating` is as empty as `update`. */
const STOP_STEMS: ReadonlySet<string> = new Set([...STOP_WORDS].map(stem));

/** Stem → the first word of the summary that produced it. */
function termsOf(summary: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const raw of summary
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || /^\d+$/u.test(raw)) continue;
    const key = stem(raw);
    if (STOP_STEMS.has(key)) continue;
    if (!out.has(key)) out.set(key, raw);
  }
  return out;
}

/**
 * The meaningful terms of a summary, as sorted stems. Unicode-aware, so
 * Cyrillic or accented summaries tokenise as well as English ones; the stop
 * list and the inflection strip apply to ASCII words only.
 */
export function tokenize(summary: string): readonly string[] {
  return [...termsOf(summary).keys()].sort();
}

/** |A ∩ B| / |A ∪ B| over two sorted, de-duplicated token lists. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  return sharedTerms(a, b).length / new Set([...a, ...b]).size;
}

function sharedTerms(a: readonly string[], b: readonly string[]): readonly string[] {
  const other = new Set(b);
  return a.filter((token) => other.has(token));
}

// ---------------------------------------------------------------------------
// 4. Hierarchy
// ---------------------------------------------------------------------------

/** A node of the local hierarchy. */
export interface HierarchyNode {
  readonly key: string;
  /** Absent for a parent that was referenced but not swept. */
  readonly issue?: PortfolioIssue;
  readonly children: readonly HierarchyNode[];
}

/** One project's slice of the hierarchy. */
export interface ProjectHierarchy {
  readonly project: string;
  readonly issueCount: number;
  readonly openCount: number;
  readonly roots: readonly HierarchyNode[];
}

function compareKeys(a: string, b: string): number {
  const [projectA, numberA] = [projectOfKey(a), Number(a.slice(a.lastIndexOf('-') + 1))];
  const [projectB, numberB] = [projectOfKey(b), Number(b.slice(b.lastIndexOf('-') + 1))];
  if (projectA !== projectB) return projectA < projectB ? -1 : 1;
  if (Number.isFinite(numberA) && Number.isFinite(numberB) && numberA !== numberB) {
    return numberA - numberB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build project → parent → child trees. An issue whose parent was not swept
 * hangs under a stub node for that parent (no `issue`), so the shape of the
 * work stays visible even when the epic lives outside the scope. Each tree is
 * filed under the project of its ROOT: a story of project B under an epic of
 * project A appears in A's tree, which is exactly the cross-board coupling a
 * reader wants to see.
 */
export function buildHierarchy(
  issues: readonly PortfolioIssue[],
): readonly ProjectHierarchy[] {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const childrenOf = new Map<string, PortfolioIssue[]>();
  const stubParents = new Set<string>();
  for (const issue of issues) {
    if (issue.parentKey === undefined || issue.parentKey === issue.key) continue;
    const list = childrenOf.get(issue.parentKey) ?? [];
    list.push(issue);
    childrenOf.set(issue.parentKey, list);
    if (!byKey.has(issue.parentKey)) stubParents.add(issue.parentKey);
  }

  const visited = new Set<string>();
  const nodeOf = (key: string): HierarchyNode => {
    visited.add(key);
    const issue = byKey.get(key);
    const children = (childrenOf.get(key) ?? [])
      .filter((child) => !visited.has(child.key))
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((child) => nodeOf(child.key));
    return issue === undefined ? { key, children } : { key, issue, children };
  };

  const rootKeys = [
    ...issues
      .filter((issue) => issue.parentKey === undefined || issue.parentKey === issue.key)
      .map((issue) => issue.key),
    ...stubParents,
  ].sort(compareKeys);

  const projects = new Map<string, HierarchyNode[]>();
  const fileRoot = (key: string): void => {
    const project = byKey.get(key)?.project ?? projectOfKey(key);
    const list = projects.get(project) ?? [];
    list.push(nodeOf(key));
    projects.set(project, list);
  };
  for (const key of rootKeys) fileRoot(key);
  // A parent cycle (A under B under A) has no root; surface its members anyway.
  for (const issue of [...issues].sort((a, b) => compareKeys(a.key, b.key))) {
    if (!visited.has(issue.key)) fileRoot(issue.key);
  }

  const counts = new Map<string, { issues: number; open: number }>();
  for (const issue of issues) {
    const count = counts.get(issue.project) ?? { issues: 0, open: 0 };
    count.issues += 1;
    if (isOpen(issue)) count.open += 1;
    counts.set(issue.project, count);
  }

  const names = new Set([...projects.keys(), ...counts.keys()]);
  return [...names].sort().map((project) => ({
    project,
    issueCount: counts.get(project)?.issues ?? 0,
    openCount: counts.get(project)?.open ?? 0,
    roots: projects.get(project) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// 5. Findings
// ---------------------------------------------------------------------------

/** A reference to an issue inside a finding. */
export interface IssueRef {
  readonly key: string;
  readonly project: string;
  readonly summary: string;
  readonly level: IssueLevel;
  readonly status?: string;
}

/** Two open issues that look like the same work. */
export interface DuplicateFinding {
  readonly kind: 'duplicate' | 'overlap';
  readonly score: number;
  readonly a: IssueRef;
  readonly b: IssueRef;
  readonly sharedTerms: readonly string[];
  /** The link type already joining them, when one does — the overlap is known. */
  readonly linkedAs?: string;
}

/** An open issue that resembles finished work in another project. */
export interface ReuseFinding {
  readonly score: number;
  /** The finished issue whose result can be reused. */
  readonly existing: IssueRef;
  /** The open issue that might not need building from scratch. */
  readonly candidate: IssueRef;
  readonly sharedTerms: readonly string[];
  readonly linkedAs?: string;
}

/** An open issue blocked across a project boundary. */
export interface DependencyFinding {
  /** The issue that waits. */
  readonly blocked: string;
  readonly blockedProject: string;
  /** The issue it waits on. */
  readonly blocker: string;
  readonly blockerProject: string;
  readonly linkType: string;
  /** Whether the blocker is finished — `false` is the live risk. */
  readonly blockerDone?: boolean;
}

/** One area touched by open work in several projects. */
export interface HotspotFinding {
  readonly area: 'component' | 'label';
  readonly name: string;
  readonly projects: readonly string[];
  /** Open issue keys per project. */
  readonly issues: Readonly<Record<string, readonly string[]>>;
}

/** Options of {@link analysePortfolio}. */
export interface AnalysisOptions {
  /** Loose threshold, 0…1. Default {@link DEFAULT_SIMILARITY}. */
  readonly similarity?: number;
  /** Strict threshold, 0…1. Default {@link DEFAULT_DUPLICATE_SIMILARITY}. */
  readonly duplicateSimilarity?: number;
  /** Also pair issues of the SAME project. Default false: cross-board only. */
  readonly includeSameProject?: boolean;
}

/** Everything {@link analysePortfolio} found. */
export interface PortfolioAnalysis {
  readonly projects: readonly string[];
  readonly issueCount: number;
  readonly openCount: number;
  readonly hierarchy: readonly ProjectHierarchy[];
  readonly duplicates: readonly DuplicateFinding[];
  readonly reuse: readonly ReuseFinding[];
  readonly dependencies: readonly DependencyFinding[];
  readonly hotspots: readonly HotspotFinding[];
  /** Pair lists were cut at {@link MAX_PAIR_FINDINGS}. */
  readonly findingsCapped: boolean;
  readonly thresholds: { readonly similarity: number; readonly duplicate: number };
}

function refOf(issue: PortfolioIssue): IssueRef {
  return {
    key: issue.key,
    project: issue.project,
    summary: issue.summary,
    level: issue.level,
    ...(issue.status === undefined ? {} : { status: issue.status }),
  };
}

/** The level classes that are compared with each other: an epic is not a sub-task. */
function comparable(a: PortfolioIssue, b: PortfolioIssue): boolean {
  return (a.level === 'epic') === (b.level === 'epic');
}

function linkBetween(a: PortfolioIssue, b: PortfolioIssue): string | undefined {
  return (
    a.links.find((link) => link.key === b.key)?.type ??
    b.links.find((link) => link.key === a.key)?.type
  );
}

function round(score: number): number {
  return Math.round(score * 100) / 100;
}

interface ScoredPair {
  readonly a: PortfolioIssue;
  readonly b: PortfolioIssue;
  readonly score: number;
  readonly shared: readonly string[];
}

/**
 * Candidate pairs through an inverted index: only issues that share at least
 * one uncommon token are ever compared, which keeps a 1,000-issue sweep far
 * from its million naive comparisons.
 */
function similarPairs(
  issues: readonly PortfolioIssue[],
  threshold: number,
  includeSameProject: boolean,
): readonly ScoredPair[] {
  const tokens = issues.map((issue) => tokenize(issue.summary));
  // Shared terms are reported in a word the reader wrote, not as a stem.
  const surface = (index: number): ReadonlyMap<string, string> =>
    termsOf((issues[index] as PortfolioIssue).summary);
  const postings = new Map<string, number[]>();
  tokens.forEach((list, index) => {
    if (list.length < MIN_TOKENS) return;
    for (const token of list) {
      const posting = postings.get(token) ?? [];
      posting.push(index);
      postings.set(token, posting);
    }
  });

  const commonLimit =
    issues.length >= COMMON_TOKEN_MIN_ISSUES
      ? Math.max(2, Math.floor(issues.length * COMMON_TOKEN_SHARE))
      : Number.POSITIVE_INFINITY;

  const seen = new Set<string>();
  const pairs: ScoredPair[] = [];
  for (const posting of postings.values()) {
    if (posting.length < 2 || posting.length > commonLimit) continue;
    for (let i = 0; i < posting.length; i += 1) {
      for (let j = i + 1; j < posting.length; j += 1) {
        const left = posting[i] as number;
        const right = posting[j] as number;
        const id = `${String(left)}:${String(right)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const a = issues[left] as PortfolioIssue;
        const b = issues[right] as PortfolioIssue;
        if (!includeSameProject && a.project === b.project) continue;
        if (!comparable(a, b)) continue;
        const ta = tokens[left] as readonly string[];
        const tb = tokens[right] as readonly string[];
        const score = jaccard(ta, tb);
        if (score < threshold) continue;
        const words = surface(left);
        pairs.push({
          a,
          b,
          score,
          shared: sharedTerms(ta, tb)
            .map((term) => words.get(term) ?? term)
            .sort(),
        });
      }
    }
  }
  return pairs.sort(
    (x, y) =>
      y.score - x.score || compareKeys(x.a.key, y.a.key) || compareKeys(x.b.key, y.b.key),
  );
}

function dependenciesOf(issues: readonly PortfolioIssue[]): readonly DependencyFinding[] {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  const categoryOfKey = (
    key: string,
    fallback?: StatusCategory,
  ): StatusCategory | undefined => byKey.get(key)?.statusCategory ?? fallback;
  const found = new Map<string, DependencyFinding>();
  for (const issue of issues) {
    if (!isOpen(issue)) continue;
    for (const link of issue.links) {
      if (!/block/i.test(link.type)) continue;
      const otherProject = byKey.get(link.key)?.project ?? projectOfKey(link.key);
      if (otherProject === issue.project) continue;
      // Jira's convention: the INWARD side of a Blocks link ("is blocked by")
      // is the issue that waits; the outward side ("blocks") is the blocker.
      const waits = link.direction === 'inward';
      const blocked = waits ? issue.key : link.key;
      const blocker = waits ? link.key : issue.key;
      const blockedCategory = waits
        ? issue.statusCategory
        : categoryOfKey(blocked, link.statusCategory);
      // A finished waiting side no longer waits on anything.
      if (blockedCategory === 'done') continue;
      const blockerCategory = waits
        ? categoryOfKey(blocker, link.statusCategory)
        : issue.statusCategory;
      const id = `${blocked}<${blocker}`;
      if (found.has(id)) continue;
      found.set(id, {
        blocked,
        blockedProject: byKey.get(blocked)?.project ?? projectOfKey(blocked),
        blocker,
        blockerProject: byKey.get(blocker)?.project ?? projectOfKey(blocker),
        linkType: link.type,
        ...(blockerCategory === undefined
          ? {}
          : { blockerDone: blockerCategory === 'done' }),
      });
    }
  }
  return [...found.values()].sort(
    (x, y) => compareKeys(x.blocked, y.blocked) || compareKeys(x.blocker, y.blocker),
  );
}

function hotspotsOf(issues: readonly PortfolioIssue[]): readonly HotspotFinding[] {
  const areas = new Map<string, Map<string, string[]>>();
  // The first spelling seen names the area in the report.
  const displayName = new Map<string, string>();
  const add = (
    area: 'component' | 'label',
    name: string,
    issue: PortfolioIssue,
  ): void => {
    // Case-folded so `Payments` and `payments` in two projects are one area.
    const id = `${area}\u0000${name.toLowerCase()}`;
    if (!displayName.has(id)) displayName.set(id, name);
    const byProject = areas.get(id) ?? new Map<string, string[]>();
    const keys = byProject.get(issue.project) ?? [];
    keys.push(issue.key);
    byProject.set(issue.project, keys);
    areas.set(id, byProject);
  };
  for (const issue of issues) {
    if (!isOpen(issue)) continue;
    for (const name of issue.components) add('component', name, issue);
    for (const name of issue.labels) add('label', name, issue);
  }
  const out: HotspotFinding[] = [];
  for (const [id, byProject] of areas) {
    if (byProject.size < 2) continue;
    const area = id.startsWith('component\u0000') ? 'component' : 'label';
    const projects = [...byProject.keys()].sort();
    const issuesByProject: Record<string, readonly string[]> = {};
    for (const project of projects) {
      issuesByProject[project] = [...(byProject.get(project) ?? [])].sort(compareKeys);
    }
    out.push({
      area,
      name: displayName.get(id) ?? id,
      projects,
      issues: issuesByProject,
    });
  }
  const weight = (finding: HotspotFinding): number =>
    Object.values(finding.issues).reduce((sum, keys) => sum + keys.length, 0);
  return out.sort(
    (x, y) =>
      y.projects.length - x.projects.length ||
      weight(y) - weight(x) ||
      (x.area < y.area ? -1 : x.area > y.area ? 1 : 0) ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  );
}

/**
 * Analyse a swept set of issues. Pure and deterministic: the same rows in any
 * order give the same result.
 */
export function analysePortfolio(
  rows: readonly SearchIssue[],
  options: AnalysisOptions = {},
): PortfolioAnalysis {
  const similarity = options.similarity ?? DEFAULT_SIMILARITY;
  const duplicate = Math.max(
    similarity,
    options.duplicateSimilarity ?? DEFAULT_DUPLICATE_SIMILARITY,
  );
  // De-duplicated by key and sorted, so row order never changes the outcome.
  const unique = new Map<string, PortfolioIssue>();
  for (const row of rows) {
    if (!unique.has(row.key)) unique.set(row.key, normaliseIssue(row));
  }
  const issues = [...unique.values()].sort((a, b) => compareKeys(a.key, b.key));

  const duplicates: DuplicateFinding[] = [];
  const reuse: ReuseFinding[] = [];
  for (const pair of similarPairs(
    issues,
    similarity,
    options.includeSameProject === true,
  )) {
    const openA = isOpen(pair.a);
    const openB = isOpen(pair.b);
    if (!openA && !openB) continue; // two finished issues are history, not a finding
    const linkedAs = linkBetween(pair.a, pair.b);
    const score = round(pair.score);
    if (openA && openB) {
      duplicates.push({
        kind: pair.score >= duplicate ? 'duplicate' : 'overlap',
        score,
        a: refOf(pair.a),
        b: refOf(pair.b),
        sharedTerms: pair.shared,
        ...(linkedAs === undefined ? {} : { linkedAs }),
      });
    } else {
      const [existing, candidate] = openA ? [pair.b, pair.a] : [pair.a, pair.b];
      reuse.push({
        score,
        existing: refOf(existing),
        candidate: refOf(candidate),
        sharedTerms: pair.shared,
        ...(linkedAs === undefined ? {} : { linkedAs }),
      });
    }
  }

  const projects = [...new Set(issues.map((issue) => issue.project))].sort();
  return {
    projects,
    issueCount: issues.length,
    openCount: issues.filter(isOpen).length,
    hierarchy: buildHierarchy(issues),
    duplicates: duplicates.slice(0, MAX_PAIR_FINDINGS),
    reuse: reuse.slice(0, MAX_PAIR_FINDINGS),
    dependencies: dependenciesOf(issues),
    hotspots: hotspotsOf(issues),
    findingsCapped:
      duplicates.length > MAX_PAIR_FINDINGS || reuse.length > MAX_PAIR_FINDINGS,
    thresholds: { similarity, duplicate },
  };
}
