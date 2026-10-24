// ---------------------------------------------------------------------------
// Plan context for issue writes (D132).
//
// A plan used to show the REQUEST a write would send — `PUT /issue/PROJ-1`
// with a body — but not what that body would overwrite. A model approving
// "set priority to High" could not see that the issue was already Highest, or
// that the description it was about to replace held a table. `planContext`
// reads the touched fields once, and the gate puts the result in the plan as
// `data.diff`: one `{ field, from, to }` row per field the write sets.
//
// The same read carries the issue's `updated` stamp. The gate binds it to the
// plan_id and re-reads it on apply: if anyone changed the issue in between,
// the apply is refused as `stale` instead of overwriting a value the human
// never saw.
//
// Values are COMPACTED for display, not reproduced: a user becomes its
// accountId and display name, an option or priority its name, rich text a
// truncated line of plain text. The diff is an approval surface; the full
// value is one jira_get_issue away.
// ---------------------------------------------------------------------------

import { callBase } from '../mcp/tool-helpers.js';
import type { PlanContext, PlanFieldChange, ToolCtx } from '../mcp/types.js';

/** Longest string a diff cell shows before it is cut. */
export const DIFF_TEXT_CHARS = 200;

/** Most array entries a diff cell shows before it is cut. */
export const DIFF_LIST_ITEMS = 20;

/** The field every issue context reads besides the touched ones. */
const VERSION_FIELD = 'updated';

function truncate(text: string): string {
  return text.length <= DIFF_TEXT_CHARS ? text : `${text.slice(0, DIFF_TEXT_CHARS)}…`;
}

/**
 * The text leaves of an ADF document, space-joined. Deliberately not the api
 * ring's renderer: rich text is a wire format a tool reaches only through the
 * port (D106), and a display cell needs the words, not the structure.
 */
function adfWords(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) adfWords(child, out);
  } else if (isRecord(node)) {
    if (typeof node['text'] === 'string') out.push(node['text']);
    adfWords(node['content'], out);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One value as a diff cell shows it. Jira's field values are a zoo — users,
 * options, priorities, ADF documents, nested arrays of all of them — so the
 * reduction picks the one key a human recognises the value by.
 */
export function compactValue(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, DIFF_LIST_ITEMS).map((v) => compactValue(v, depth + 1));
    return value.length > DIFF_LIST_ITEMS
      ? [...items, `… ${String(value.length - DIFF_LIST_ITEMS)} more`]
      : items;
  }
  // Nothing else survives JSON: functions, symbols and bigints cannot arrive.
  if (!isRecord(value)) return null;
  if (value['type'] === 'doc') return truncate(adfWords(value).join(' '));
  if (typeof value['accountId'] === 'string') {
    return typeof value['displayName'] === 'string'
      ? { accountId: value['accountId'], displayName: value['displayName'] }
      : { accountId: value['accountId'] };
  }
  for (const key of ['name', 'key', 'value', 'id'] as const) {
    const named = value[key];
    if (typeof named === 'string' || typeof named === 'number') return named;
  }
  return depth > 0 ? '{…}' : truncate(JSON.stringify(value));
}

/** One row, both sides compacted. */
export function fieldChange(field: string, from: unknown, to: unknown): PlanFieldChange {
  return { field, from: compactValue(from), to: compactValue(to) };
}

/** The live values of `fields` plus the `updated` stamp, through the port. */
export async function readIssueFields(
  ctx: ToolCtx,
  issue: string,
  fields: readonly string[],
): Promise<{ readonly fields: Readonly<Record<string, unknown>>; version?: string }> {
  const detail = await ctx.api.getIssue({
    ...callBase(ctx),
    issue,
    fields: [...new Set([...fields, VERSION_FIELD])],
  });
  const stamp = detail.fields[VERSION_FIELD];
  return {
    fields: detail.fields,
    ...(typeof stamp === 'string' ? { version: stamp } : {}),
  };
}

/** A context from rows and a read: the stamp rides along when Jira sent one. */
export function issueContext(
  diff: readonly PlanFieldChange[],
  read: { readonly version?: string },
): PlanContext {
  return read.version === undefined ? { diff } : { diff, version: read.version };
}
