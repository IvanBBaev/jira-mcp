// api/issues/shape.ts — read shaping for fields, comments, worklogs,
// transitions and changelog entries (D517).

import type { JiraDeployment } from '../../core/types.js';
import { adfToMarkdown, adfToText, isAdfDoc } from '../adf.js';
import { asRecord, isRecord } from '../guards.js';
import { shapeDataCenterUser, shapeUser, type ShapedUser } from '../users.js';
import { wikiToText } from '../wiki.js';
import { isUnknownArray, requireString } from './errors.js';
import { MAX_SHAPE_DEPTH } from './paths.js';
import type {
  ChangelogEntry,
  GetIssueBase,
  IssueChangelog,
  IssueComment,
  IssueLink,
  IssueRecord,
  IssueTransition,
  IssueWorklog,
  JiraVisibility,
  LinkedIssueRef,
} from './types.js';

// ---------------------------------------------------------------------------
// 9. Read shaping
// ---------------------------------------------------------------------------

/**
 * Shape a whole `fields` bag. Keys survive exactly as Jira sent them — a
 * requested field is never renamed, reordered or dropped (TOOLS.md §Read
 * shaping) — and only VALUES are projected.
 *
 * Exported because it is THE issue read-shaper: `api/search.ts` and
 * `api/agile.ts` return raw `fields` bags by design, so `tools/search.ts` and
 * `tools/agile.ts` apply this same projection at the tool ring — one shaper,
 * identical output everywhere an issue row appears (TOOLS.md §Read shaping).
 *
 * `format` picks the renderer for the documents this walk finds; it changes
 * nothing about WHICH values are rendered, so a markdown read and a text read
 * differ only where a document had structure to keep. It is meaningless under
 * `raw`, which hands the documents back untouched.
 */
export function shapeIssueFields(
  value: unknown,
  raw: boolean,
  format?: 'text' | 'markdown',
  deployment?: JiraDeployment,
): Record<string, unknown> {
  const fields = asRecord(value);
  if (fields === undefined) return {};
  const render = raw ? undefined : format === 'markdown' ? adfToMarkdown : adfToText;
  const user = userProjection(deployment);
  const wiki = deployment === 'datacenter' && render !== undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(fields)) {
    // Data Center rich text is a wiki-markup STRING, which nothing about the
    // value marks as rich text (an ADF document marks itself). Only the system
    // fields known to carry it are flattened; any other string passes as sent.
    if (wiki && typeof entry === 'string' && WIKI_TEXT_FIELDS.has(key)) {
      out[key] = wikiToText(entry);
    } else if (key === 'issuelinks') out[key] = shapeIssueLinks(entry, render, user);
    else if (key === 'parent') out[key] = shapeLinkedIssue(entry) ?? null;
    else if (wiki && Object.hasOwn(EMBEDDED_WIKI_PAGES, key)) {
      out[key] = shapeValue(flattenEmbeddedWiki(entry, key), render, 0, user);
    } else out[key] = shapeValue(entry, render, 0, user);
  }
  return out;
}

/**
 * The embedded pages a default issue read carries on Data Center, and the
 * wiki-markup text field of each row: `fields.comment.comments[].body` and
 * `fields.worklog.worklogs[].comment` (CC-298). The standalone reads flatten
 * the same fields (CC-274); without this the same comment read through
 * `jira_get_issue` came back as raw markup.
 */
const EMBEDDED_WIKI_PAGES: Readonly<Record<string, readonly [string, string]>> = {
  comment: ['comments', 'body'],
  worklog: ['worklogs', 'comment'],
};

function flattenEmbeddedWiki(entry: unknown, key: string): unknown {
  const [list, text] = EMBEDDED_WIKI_PAGES[key] ?? ['', ''];
  const page = asRecord(entry);
  const rows = page?.[list];
  if (page === undefined || !Array.isArray(rows)) return entry;
  return {
    ...page,
    [list]: rows.map((row: unknown) => {
      const record = asRecord(row);
      return record !== undefined && typeof record[text] === 'string'
        ? { ...record, [text]: wikiToText(record[text]) }
        : row;
    }),
  };
}

/**
 * The system fields whose Data Center value is wiki markup (D106, 13.3b). A
 * custom multi-line text field carries it too, but its id says nothing about
 * that, so it is returned as sent rather than guessed at.
 */
const WIKI_TEXT_FIELDS: ReadonlySet<string> = new Set(['description', 'environment']);

/** Recognises and narrows a user object; `undefined` when the record is not one. */
type UserProjection = (value: unknown) => ShapedUser | undefined;

/** The user projection for a dialect: `accountId` on Cloud, `name`/`key` on DC. */
function userProjection(deployment: JiraDeployment | undefined): UserProjection {
  return deployment === 'datacenter' ? shapeDataCenterUser : shapeUser;
}

/**
 * The generic value projection: ADF documents go through `render` (or survive
 * as trees when it is `undefined`, which is what `raw` means), user objects
 * collapse to `{ accountId, displayName?, active? }`, and every other structure
 * is preserved node for node — `fixVersions`, `components`, `versions` and
 * custom fields keep their shape rather than being stringified.
 */
function shapeValue(
  value: unknown,
  render: ((node: unknown) => string) | undefined,
  depth: number,
  projectUser: UserProjection,
): unknown {
  if (depth >= MAX_SHAPE_DEPTH) return value;
  if (isUnknownArray(value)) {
    return value.map((entry) => shapeValue(entry, render, depth + 1, projectUser));
  }
  if (!isRecord(value)) return value;
  if (isAdfDoc(value)) return render === undefined ? value : render(value);
  const user = projectUser(value);
  if (user !== undefined) return user;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = shapeValue(entry, render, depth + 1, projectUser);
  }
  return out;
}

export function shapeVisibility(value: unknown): JiraVisibility | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return {
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.value === 'string' ? { value: record.value } : {}),
    ...(typeof record.identifier === 'string' ? { identifier: record.identifier } : {}),
  };
}

function shapeIssueLinks(
  value: unknown,
  render: ((node: unknown) => string) | undefined,
  projectUser: UserProjection,
): unknown {
  if (!isUnknownArray(value)) return shapeValue(value, render, 0, projectUser);
  const links: IssueLink[] = [];
  for (const entry of value) {
    const link = shapeIssueLink(entry);
    if (link !== undefined) links.push(link);
  }
  return links;
}

function shapeIssueLink(value: unknown): IssueLink | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;

  const type = asRecord(record.type) ?? {};
  const outward = shapeLinkedIssue(record.outwardIssue);
  const inward = shapeLinkedIssue(record.inwardIssue);
  const issue = outward ?? inward;
  if (issue === undefined) return undefined;

  const direction: 'inward' | 'outward' = outward === undefined ? 'inward' : 'outward';
  const relation = direction === 'outward' ? type.outward : type.inward;

  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    type: {
      ...(typeof type.id === 'string' ? { id: type.id } : {}),
      ...(typeof type.name === 'string' ? { name: type.name } : {}),
      ...(typeof type.inward === 'string' ? { inward: type.inward } : {}),
      ...(typeof type.outward === 'string' ? { outward: type.outward } : {}),
    },
    direction,
    ...(typeof relation === 'string' ? { relation } : {}),
    issue,
  };
}

/** A `parent` / `inwardIssue` / `outwardIssue` reference, flattened one level. */
export function shapeLinkedIssue(value: unknown): LinkedIssueRef | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.key !== 'string') return undefined;
  const fields = asRecord(record.fields) ?? {};
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    key: record.key,
    ...(typeof fields.summary === 'string' ? { summary: fields.summary } : {}),
    ...(namedOf(fields.status) === undefined ? {} : { status: namedOf(fields.status) }),
    ...(namedOf(fields.issuetype) === undefined
      ? {}
      : { issueType: namedOf(fields.issuetype) }),
    ...(namedOf(fields.priority) === undefined
      ? {}
      : { priority: namedOf(fields.priority) }),
  };
}

/** The `name` of a `{ id, name, ... }` reference object, when it has one. */
function namedOf(value: unknown): string | undefined {
  const record = asRecord(value);
  return record !== undefined && typeof record.name === 'string'
    ? record.name
    : undefined;
}

export function shapeComment(
  value: unknown,
  format?: 'text' | 'markdown',
  deployment?: JiraDeployment,
): IssueComment | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== 'string') return undefined;
  const projectUser = userProjection(deployment);
  const author = projectUser(record.author);
  const updateAuthor = projectUser(record.updateAuthor);
  const visibility = shapeVisibility(record.visibility);
  const render = format === 'markdown' ? adfToMarkdown : adfToText;
  return {
    id: record.id,
    ...(author === undefined ? {} : { author }),
    ...(updateAuthor === undefined ? {} : { updateAuthor }),
    body: deployment === 'datacenter' ? wikiToText(record.body) : render(record.body),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(typeof record.updated === 'string' ? { updated: record.updated } : {}),
    ...(visibility === undefined ? {} : { visibility }),
    ...(typeof record.jsdPublic === 'boolean' ? { jsdPublic: record.jsdPublic } : {}),
  };
}

export function shapeWorklog(
  value: unknown,
  deployment?: JiraDeployment,
): IssueWorklog | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== 'string') return undefined;
  const projectUser = userProjection(deployment);
  const author = projectUser(record.author);
  const updateAuthor = projectUser(record.updateAuthor);
  const visibility = shapeVisibility(record.visibility);
  const comment =
    record.comment === undefined
      ? undefined
      : deployment === 'datacenter'
        ? wikiToText(record.comment)
        : adfToText(record.comment);
  return {
    id: record.id,
    ...(typeof record.issueId === 'string' ? { issueId: record.issueId } : {}),
    ...(author === undefined ? {} : { author }),
    ...(updateAuthor === undefined ? {} : { updateAuthor }),
    ...(comment === undefined ? {} : { comment }),
    ...(typeof record.started === 'string' ? { started: record.started } : {}),
    ...(typeof record.timeSpent === 'string' ? { timeSpent: record.timeSpent } : {}),
    ...(typeof record.timeSpentSeconds === 'number'
      ? { timeSpentSeconds: record.timeSpentSeconds }
      : {}),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(typeof record.updated === 'string' ? { updated: record.updated } : {}),
    ...(visibility === undefined ? {} : { visibility }),
  };
}

export function shapeTransition(value: unknown): IssueTransition | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  // Jira reports the id as a string; a number is tolerated because some older
  // builds sent one and the id is only ever echoed back on the POST.
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.id === 'number'
        ? String(record.id)
        : undefined;
  if (id === undefined) return undefined;

  const to = asRecord(record.to);
  const category = asRecord(to?.statusCategory);
  const fields = asRecord(record.fields);

  return {
    id,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(to === undefined
      ? {}
      : {
          to: {
            ...(typeof to.id === 'string' ? { id: to.id } : {}),
            ...(typeof to.name === 'string' ? { name: to.name } : {}),
            ...(category === undefined
              ? {}
              : {
                  statusCategory: {
                    ...(typeof category.key === 'string' ? { key: category.key } : {}),
                    ...(typeof category.name === 'string' ? { name: category.name } : {}),
                  },
                }),
          },
        }),
    ...boolField(record, 'hasScreen'),
    ...boolField(record, 'isAvailable'),
    ...boolField(record, 'isGlobal'),
    ...boolField(record, 'isInitial'),
    ...boolField(record, 'isConditional'),
    ...boolField(record, 'looped'),
    ...(fields === undefined ? {} : { fields }),
  };
}

function boolField(
  record: Record<string, unknown>,
  key: string,
): Record<string, boolean> {
  const value = record[key];
  return typeof value === 'boolean' ? { [key]: value } : {};
}

export function shapeChangelogEntry(
  value: unknown,
  deployment?: JiraDeployment,
): ChangelogEntry | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const author = userProjection(deployment)(record.author);
  const items: Readonly<Record<string, unknown>>[] = isUnknownArray(record.items)
    ? record.items.filter(isRecord)
    : [];
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.created === 'string' ? { created: record.created } : {}),
    ...(author === undefined ? {} : { author }),
    items,
  };
}

/** The `changelog` block `expand=changelog` embeds in an issue read. */
function shapeChangelogBlock(
  value: unknown,
  deployment?: JiraDeployment,
): IssueChangelog | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const rows = isUnknownArray(record.histories) ? record.histories : [];
  const histories: ChangelogEntry[] = [];
  for (const row of rows) {
    const entry = shapeChangelogEntry(row, deployment);
    if (entry !== undefined) histories.push(entry);
  }
  return {
    histories,
    ...(typeof record.startAt === 'number' ? { startAt: record.startAt } : {}),
    ...(typeof record.maxResults === 'number' ? { maxResults: record.maxResults } : {}),
    ...(typeof record.total === 'number' ? { total: record.total } : {}),
  };
}

/** The keys of an issue read that {@link getIssue} restates itself. */
const ISSUE_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'key',
  'self',
  'expand',
  'fields',
  'changelog',
  'properties',
]);

/** The shaped body of one issue bean — shared by the single and bulk reads. */
export function shapeIssueRecord(
  data: Record<string, unknown>,
  what: string,
  raw: boolean,
  options: Pick<GetIssueBase, 'format' | 'deployment'>,
): IssueRecord {
  const id = requireString(data.id, `${what}.id`);
  const key = requireString(data.key, `${what}.key`);
  const changelog = shapeChangelogBlock(data.changelog, options.deployment);
  const props = asRecord(data.properties);
  const extras: Record<string, unknown> = {};
  for (const [section, value] of Object.entries(data)) {
    if (!ISSUE_ENVELOPE_KEYS.has(section)) extras[section] = value;
  }
  const expanded = shapeIssueFields(extras, raw, options.format, options.deployment);

  return {
    id,
    key,
    ...(typeof data.self === 'string' ? { self: data.self } : {}),
    fields: shapeIssueFields(data.fields, raw, options.format, options.deployment),
    ...(changelog === undefined ? {} : { changelog }),
    ...(props === undefined ? {} : { properties: props }),
    ...(Object.keys(expanded).length === 0 ? {} : { expanded }),
  };
}
