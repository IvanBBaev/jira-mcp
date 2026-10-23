// ---------------------------------------------------------------------------
// Package `portfolio` — cross-board work analysis (TOOLS.md §Package
// `portfolio`, D126).
//
// Two reads over one sweep of issues from several projects (or one JQL):
//
//   - `jira_portfolio_analyze` returns the analysis as data — the hierarchy per
//     project, duplicate and overlapping work across boards, reuse candidates
//     (open work resembling something already finished elsewhere), cross-project
//     blockers and shared component/label hotspots.
//   - `jira_portfolio_report` renders the same analysis as a Markdown document
//     with Mermaid diagrams and tables and writes it into `JIRA_REPORT_DIR`,
//     returning the path and the counts. The document never passes through the
//     conversation, which is the point: a 300-issue hierarchy is a file to open,
//     not context to spend.
//
// Neither tool changes Jira. The analysis itself is pure and lives in
// `portfolio-analysis.ts`; the rendering in `portfolio-render.ts`. This module
// owns the sweep, the board lookup and the one local file write.
//
// THE FILE WRITE follows the media store's rules (`attachments.ts`): the
// directory is resolved once, the name is generated here (never from Jira or the
// caller), the file is created with `wx` so nothing is ever overwritten, mode
// 0600, and a failed write removes its partial file. Like `JIRA_MEDIA_DIR`, an
// unset `JIRA_REPORT_DIR` refuses the report tool with `kind: 'config'` and
// leaves the analyze tool working.
//
// Layering: tools are a composition root. The network is reached only through
// `ctx.api`, time only through `ctx.clock`.
// ---------------------------------------------------------------------------

import { open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MAX_SEARCH_RESULTS } from '../api/search.js';
import { createJiraError, isJiraError } from '../core/errors.js';
import { defineTool, toolInput, z } from '../mcp/define.js';
import { ok } from '../mcp/result.js';
import { READ_ANNOTATIONS, callBase, guarded } from '../mcp/tool-helpers.js';
import type {
  PackageSpec,
  ToolAnnotations,
  ToolCtx,
  ToolResult,
  ToolSpec,
} from '../mcp/types.js';
import {
  DEFAULT_DUPLICATE_SIMILARITY,
  DEFAULT_SIMILARITY,
  PORTFOLIO_FIELDS,
  analysePortfolio,
  type PortfolioAnalysis,
} from './portfolio-analysis.js';
import { renderPortfolioReport, type ReportMeta } from './portfolio-render.js';

// ---------------------------------------------------------------------------
// 1. Inputs
// ---------------------------------------------------------------------------

/** Most projects one sweep names. Each one costs a board lookup. */
export const MAX_PORTFOLIO_PROJECTS = 10;

/** Default and ceiling of the sweep size. */
export const DEFAULT_PORTFOLIO_ISSUES = 300;
export const MAX_PORTFOLIO_ISSUES = 1000;

/** File mode of a written report — the same as every file this server creates. */
export const REPORT_FILE_MODE = 0o600;

/** Distinct names tried when two reports land in the same second. */
const MAX_REPORT_NAME_ATTEMPTS = 100;

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/u;

const portfolioShape = {
  projects: z
    .array(
      z
        .string()
        .trim()
        .regex(
          PROJECT_KEY,
          'A project key: letters, digits and underscores, starting with a letter.',
        ),
    )
    .min(2)
    .max(MAX_PORTFOLIO_PROJECTS)
    .optional()
    .describe(
      `Project keys to compare, 2–${String(MAX_PORTFOLIO_PROJECTS)} (one per board or team). ` +
        'Pass this or jql, not both.',
    ),
  jql: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Your own scope instead of projects, e.g. a filter spanning several boards.',
    ),
  includeDone: z
    .boolean()
    .optional()
    .describe(
      'Include finished issues (default true). Reuse candidates need them; set false ' +
        'for a smaller sweep that only looks at open work.',
    ),
  updatedWithinDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe('With projects only: skip issues not updated in this many days.'),
  maxIssues: z
    .number()
    .int()
    .min(1)
    .max(MAX_PORTFOLIO_ISSUES)
    .optional()
    .describe(
      `Most issues to read (default ${String(DEFAULT_PORTFOLIO_ISSUES)}). A larger ` +
        'sweep stops at the page cap and says so in scope.partial.',
    ),
  similarity: z
    .number()
    .min(0.1)
    .max(1)
    .optional()
    .describe(
      `Least summary similarity (Jaccard, 0–1) reported as overlap or reuse; default ${String(DEFAULT_SIMILARITY)}.`,
    ),
  duplicateSimilarity: z
    .number()
    .min(0.1)
    .max(1)
    .optional()
    .describe(
      `Least similarity at which two open issues count as duplicates; default ${String(DEFAULT_DUPLICATE_SIMILARITY)}.`,
    ),
  includeSameProject: z
    .boolean()
    .optional()
    .describe(
      'Also compare issues within one project (default false: across boards only).',
    ),
  includeBoards: z
    .boolean()
    .optional()
    .describe(
      'Look up the board names of each project (default true; one call per project).',
    ),
};

const analyzeInput = toolInput(portfolioShape);

const reportInput = toolInput({
  ...portfolioShape,
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Heading of the report. Default: "Portfolio analysis".'),
});

type AnalyzeArgs = z.infer<typeof analyzeInput>;

// ---------------------------------------------------------------------------
// 2. The sweep
// ---------------------------------------------------------------------------

/** How the issue set was chosen and whether all of it was read. */
export interface PortfolioScope {
  readonly jql: string;
  readonly issuesRead: number;
  /** The sweep stopped before Jira ran out of matching issues. */
  readonly partial: boolean;
  readonly stopReason: string;
  /** A cursor expired mid-sweep and the search restarted (rows de-duplicated). */
  readonly restarted: boolean;
  readonly note?: string;
}

/** Board names per project, plus why some are missing. */
export interface PortfolioBoards {
  readonly byProject: Readonly<Record<string, readonly string[]>>;
  readonly note?: string;
}

function quoteJql(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/**
 * The JQL the sweep runs. Exactly one of `projects` and `jql` is required; the
 * check lives here rather than in the schema because a zod refinement would
 * make the input non-strict-object and the example parser reject it.
 */
export function portfolioJql(args: AnalyzeArgs): string {
  if ((args.projects === undefined) === (args.jql === undefined)) {
    throw createJiraError({
      kind: 'validation',
      reason:
        args.projects === undefined
          ? 'Neither projects nor jql was given, so there is nothing to analyse.'
          : 'Both projects and jql were given; the scope must come from one of them.',
      remediation:
        'Pass projects (2–10 project keys) to compare boards, or jql for your own scope. Nothing was sent.',
    });
  }
  if (args.jql !== undefined) {
    if (args.updatedWithinDays !== undefined) {
      throw createJiraError({
        kind: 'validation',
        reason: 'updatedWithinDays only applies with projects.',
        remediation:
          'Put the date condition into the jql itself (updated >= -30d). Nothing was sent.',
      });
    }
    return args.includeDone === false
      ? `(${args.jql.replace(/\s+ORDER\s+BY\s+.*$/isu, '')}) AND statusCategory != Done`
      : args.jql;
  }
  const keys = [...new Set((args.projects ?? []).map((key) => key.toUpperCase()))];
  const clauses = [`project in (${keys.map(quoteJql).join(', ')})`];
  if (args.includeDone === false) clauses.push('statusCategory != Done');
  if (args.updatedWithinDays !== undefined) {
    clauses.push(`updated >= -${String(args.updatedWithinDays)}d`);
  }
  return `${clauses.join(' AND ')} ORDER BY key ASC`;
}

interface Sweep {
  readonly analysis: PortfolioAnalysis;
  readonly scope: PortfolioScope;
  readonly boards?: PortfolioBoards;
}

function stopNote(stopReason: string, maxIssues: number): string | undefined {
  if (stopReason === 'max_pages') {
    return `Only the first ${String(maxIssues)} issues were read; raise maxIssues or narrow the scope.`;
  }
  if (stopReason === 'budget') {
    return 'The call ran out of time before every issue was read; narrow the scope.';
  }
  if (stopReason === 'aborted')
    return 'The call was cancelled before every issue was read.';
  return undefined;
}

/** Board lookups that answer "no boards here" rather than "the call failed". */
const SOFT_BOARD_ERRORS = new Set(['unsupported', 'not_found', 'permission']);

async function boardsOf(
  ctx: ToolCtx,
  projects: readonly string[],
): Promise<PortfolioBoards> {
  const byProject: Record<string, string[]> = {};
  const notes: string[] = [];
  for (const project of projects.slice(0, MAX_PORTFOLIO_PROJECTS)) {
    try {
      const loop = await ctx.api.listBoards({
        ...callBase(ctx),
        projectKeyOrId: project,
        maxPages: 1,
      });
      byProject[project] = loop.items.map((board) => board.name).sort();
    } catch (error) {
      if (!isJiraError(error) || !SOFT_BOARD_ERRORS.has(error.kind)) throw error;
      if (error.kind === 'unsupported') {
        notes.push('Board names are unavailable: this site has no Jira Software.');
        break;
      }
      notes.push(`Boards of ${project} could not be read (${error.kind}).`);
    }
  }
  if (projects.length > MAX_PORTFOLIO_PROJECTS) {
    notes.push(
      `Boards were looked up for the first ${String(MAX_PORTFOLIO_PROJECTS)} projects only.`,
    );
  }
  return notes.length === 0 ? { byProject } : { byProject, note: notes.join(' ') };
}

async function sweep(args: AnalyzeArgs, ctx: ToolCtx): Promise<Sweep> {
  const jql = portfolioJql(args);
  const maxIssues = args.maxIssues ?? DEFAULT_PORTFOLIO_ISSUES;
  const pageSize = Math.min(MAX_SEARCH_RESULTS, maxIssues);
  const maxPages = Math.max(
    1,
    Math.min(Math.ceil(maxIssues / pageSize), ctx.limits.maxPages),
  );
  const result = await ctx.api.searchIssues({
    ...callBase(ctx),
    jql,
    fields: [...PORTFOLIO_FIELDS],
    maxResults: pageSize,
    maxPages,
  });
  const read = result.issues.slice(0, maxIssues);
  const cut = result.issues.length > maxIssues;
  const partial = result.partial || cut;
  const stopReason = cut ? 'max_pages' : result.stopReason;
  const capped = Math.min(maxIssues, maxPages * pageSize);
  const note = partial ? stopNote(stopReason, capped) : undefined;
  const analysis = analysePortfolio(read, {
    similarity: args.similarity,
    duplicateSimilarity: args.duplicateSimilarity,
    includeSameProject: args.includeSameProject,
  });
  const scope: PortfolioScope = {
    jql,
    issuesRead: analysis.issueCount,
    partial,
    stopReason,
    restarted: result.restarted,
    ...(note === undefined ? {} : { note }),
  };
  if (args.includeBoards === false) return { analysis, scope };
  return { analysis, scope, boards: await boardsOf(ctx, analysis.projects) };
}

// ---------------------------------------------------------------------------
// 3. `jira_portfolio_analyze`
// ---------------------------------------------------------------------------

/** Result of {@link analyzePortfolioTool}. */
export interface PortfolioAnalyzeData {
  readonly scope: PortfolioScope;
  readonly boards?: PortfolioBoards;
  readonly analysis: PortfolioAnalysis;
}

export const analyzePortfolioTool = defineTool<AnalyzeArgs, PortfolioAnalyzeData>({
  name: 'jira_portfolio_analyze',
  title: 'Analyze portfolio',
  description:
    'Compares the work of several projects or boards in one sweep: the epic/story/' +
    'subtask hierarchy per project, likely duplicate and overlapping open work across ' +
    'boards, open issues that resemble finished work elsewhere (reuse candidates), ' +
    'cross-project blockers and components or labels several projects are changing. ' +
    'Similarity is lexical over summaries: every finding lists its shared terms. ' +
    'Pass projects or jql. Changes nothing.',
  package: 'portfolio',
  annotations: READ_ANNOTATIONS,
  input: analyzeInput,
  example: {
    summary: 'Find overlapping and reusable work across three boards',
    arguments: { projects: ['WEB', 'MOBILE', 'API'] },
  },
  handler: (args, ctx): Promise<ToolResult<PortfolioAnalyzeData>> =>
    guarded(async () => {
      const { analysis, scope, boards } = await sweep(args, ctx);
      // Summaries, statuses, labels and component names are Jira free text.
      return ok<PortfolioAnalyzeData>(
        { scope, ...(boards === undefined ? {} : { boards }), analysis },
        { untrusted: true },
      );
    }),
});

// ---------------------------------------------------------------------------
// 4. `jira_portfolio_report`
// ---------------------------------------------------------------------------

/**
 * Not idempotent: every call writes a NEW file. Read-only toward Jira, which is
 * what `readOnlyHint` describes — the same reading `jira_download_attachment`
 * takes for its local write.
 */
const REPORT_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

/** Where a report goes. Tests inject their own. */
export interface ReportStore {
  readonly dir: string;
  /** Create `name` with `text`, never overwriting; returns the name actually used. */
  write(
    name: string,
    text: string,
  ): Promise<{ readonly name: string; readonly path: string; readonly bytes: number }>;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function reportWriteFailure(error: unknown, root: string): Error {
  if (isJiraError(error)) return error;
  const code = codeOf(error);
  const reason =
    code === 'ENOENT' || code === 'ENOTDIR'
      ? `The report directory ${root} does not exist.`
      : code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
        ? `The report directory ${root} is not writable by this server.`
        : `Writing the report into ${root} failed${code === undefined ? '' : ` (${code})`}.`;
  return createJiraError({
    kind: 'config',
    reason,
    remediation:
      'Point JIRA_REPORT_DIR at an existing directory this server can write, and restart it.',
    cause: error,
  });
}

/** The `node:fs` report store, rooted at one directory resolved once. */
export function createNodeReportStore(dir: string): ReportStore {
  const root = resolve(dir);
  return {
    dir: root,
    async write(name, text) {
      const bytes = new TextEncoder().encode(text);
      const dot = name.lastIndexOf('.');
      for (let attempt = 0; attempt < MAX_REPORT_NAME_ATTEMPTS; attempt += 1) {
        const candidate =
          attempt === 0
            ? name
            : `${name.slice(0, dot)}-${String(attempt)}${name.slice(dot)}`;
        const path = join(root, candidate);
        try {
          const handle = await open(path, 'wx', REPORT_FILE_MODE);
          try {
            const { bytesWritten } = await handle.write(bytes);
            if (bytesWritten !== bytes.byteLength) {
              throw createJiraError({
                kind: 'config',
                reason: `Only ${String(bytesWritten)} of ${String(bytes.byteLength)} bytes of the report reached ${root}; the filesystem is most likely full.`,
                remediation: 'Free space in JIRA_REPORT_DIR and run the report again.',
              });
            }
          } finally {
            await handle.close();
          }
          return { name: candidate, path, bytes: bytes.byteLength };
        } catch (error) {
          if (codeOf(error) === 'EEXIST') continue;
          await rm(path, { force: true }).catch(() => undefined);
          throw reportWriteFailure(error, root);
        }
      }
      throw createJiraError({
        kind: 'validation',
        reason: `${String(MAX_REPORT_NAME_ATTEMPTS)} reports named like "${name}" already exist in ${root}.`,
        remediation:
          'Clear out old reports in JIRA_REPORT_DIR; this server never overwrites one.',
      });
    },
  };
}

/** `portfolio-20261024T101500Z.md` — from the injected clock, never from input. */
export function reportFileName(epochMs: number): string {
  const stamp = new Date(epochMs)
    .toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d+Z$/u, 'Z');
  return `portfolio-${stamp}.md`;
}

/** Result of the report tool: where the file is and what it holds — keys only. */
export interface PortfolioReportData {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  readonly scope: PortfolioScope;
  readonly projects: readonly string[];
  readonly counts: {
    readonly issues: number;
    readonly open: number;
    readonly duplicates: number;
    readonly overlaps: number;
    readonly reuse: number;
    readonly dependencies: number;
    readonly hotspots: number;
  };
}

function noReportDir(): never {
  throw createJiraError({
    kind: 'config',
    reason: 'JIRA_REPORT_DIR is not set, so there is nowhere to write the report.',
    remediation:
      'Set JIRA_REPORT_DIR to a directory this server can write and restart it, or call ' +
      'jira_portfolio_analyze to get the same analysis as data. Nothing was sent.',
  });
}

function reportTool(
  store: ReportStore | undefined,
): ToolSpec<z.infer<typeof reportInput>, PortfolioReportData> {
  return defineTool<z.infer<typeof reportInput>, PortfolioReportData>({
    name: 'jira_portfolio_report',
    title: 'Write portfolio report',
    description:
      'Runs the jira_portfolio_analyze sweep and writes the result as a Markdown file ' +
      'into JIRA_REPORT_DIR: per-project tables, Mermaid hierarchy and findings ' +
      'diagrams, and tables of duplicate, overlapping and reusable work, blockers and ' +
      'shared hotspots. Returns the file path and counts, not the document. Needs ' +
      'JIRA_REPORT_DIR; never overwrites a file. Changes nothing in Jira.',
    package: 'portfolio',
    annotations: REPORT_ANNOTATIONS,
    input: reportInput,
    example: {
      summary: 'Write a Markdown report comparing two boards',
      arguments: { projects: ['WEB', 'MOBILE'], title: 'Q4 overlap review' },
    },
    handler: (args, ctx): Promise<ToolResult<PortfolioReportData>> =>
      guarded(async () => {
        // Refused before the sweep: no Jira call is spent on a report that has
        // nowhere to go. The scope check runs first so a bad scope says so.
        portfolioJql(args);
        if (store === undefined) noReportDir();
        const { analysis, scope, boards } = await sweep(args, ctx);
        const now = ctx.clock.now();
        const meta: ReportMeta = {
          title: args.title ?? 'Portfolio analysis',
          generatedAt: new Date(now).toISOString(),
          jql: scope.jql,
          partial: scope.partial,
          ...(scope.note === undefined ? {} : { partialNote: scope.note }),
          ...(boards === undefined ? {} : { boards: boards.byProject }),
          ...(boards?.note === undefined ? {} : { boardsNote: boards.note }),
        };
        const written = await store.write(
          reportFileName(now),
          renderPortfolioReport(analysis, meta),
        );
        return ok<PortfolioReportData>({
          path: written.path,
          name: written.name,
          bytes: written.bytes,
          scope,
          projects: analysis.projects,
          counts: {
            issues: analysis.issueCount,
            open: analysis.openCount,
            duplicates: analysis.duplicates.filter((f) => f.kind === 'duplicate').length,
            overlaps: analysis.duplicates.filter((f) => f.kind === 'overlap').length,
            reuse: analysis.reuse.length,
            dependencies: analysis.dependencies.length,
            hotspots: analysis.hotspots.length,
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 5. The package
// ---------------------------------------------------------------------------

/** What the composition root injects into {@link createPortfolioPackage}. */
export interface PortfolioDeps {
  /** `JIRA_REPORT_DIR`. Absent ⇒ the report tool refuses with `kind: 'config'`. */
  readonly reportDir?: string;
  /** Overrides {@link reportDir} — tests use it. */
  readonly store?: ReportStore;
}

export function createPortfolioPackage(deps: PortfolioDeps = {}): PackageSpec {
  const store =
    deps.store ??
    (deps.reportDir === undefined || deps.reportDir.trim() === ''
      ? undefined
      : createNodeReportStore(deps.reportDir));
  return {
    id: 'portfolio',
    title: 'Portfolio',
    description:
      'Cross-board analysis: hierarchy per project, duplicate and overlapping work, ' +
      'reuse candidates, cross-project blockers and shared hotspots — as data, or as a ' +
      'Markdown report with Mermaid diagrams written into JIRA_REPORT_DIR.',
    tools: [analyzePortfolioTool, reportTool(store)],
  };
}

/** The package with no report directory — the structural constant. */
export const portfolioPackage: PackageSpec = createPortfolioPackage();
