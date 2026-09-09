// ---------------------------------------------------------------------------
// api/bulk.ts — the bulk-operations surface (WP-120, D103).
//
// Three routes that change or watch MANY issues per request instead of one:
//
//   * delete — `POST /bulk/issues/delete` (up to 1000 issues, subtasks count)
//   * edit   — `POST /bulk/issues/fields` (four field families of the wire's
//              23-family union: labels, priority, assignee, fixVersions)
//   * queue  — `GET /bulk/queue/{taskId}` (progress of either submit)
//
// The submits are ASYNCHRONOUS: Jira answers 201 with a task id, and the work
// happens later on Atlassian's side. That one fact shapes every rule here:
//
//  1. **A 201 is a receipt for a QUEUED task, not a result** (CC-127). The only
//     thing worth returning is the `taskId`; whether the issues actually
//     changed is answered by {@link getBulkStatus}, never assumed.
//  2. **The submits are unsafe POSTs and are never replayed** (CC-12/13): a
//     replayed submit enqueues a SECOND task over the same issues. Neither
//     spec carries a `safe` flag — the retry matrix reads the property's
//     presence. The queue read is an ordinary GET and retries normally.
//  3. **The wire vocabulary stays below this line** (CC-130). Callers say
//     `labels` / `priorityId` / `assignee` / `fixVersions`; this module alone
//     spells `labelsFields`, `bulkEditMultiSelectFieldOption`,
//     `singleSelectClearableUserPickerFields` and derives `selectedActions`
//     from the families that are present — `selectedActions` is never
//     caller-supplied, so it cannot disagree with the payload next to it.
//  4. **An absent `sendBulkNotification` stays ABSENT** (CC-131). Jira defaults
//     it to true server-side; the client invents no default, so an omitted
//     argument is an omitted body field, not `false`.
//  5. **Mappers are allowlists** (D41): the progress record arrives with a
//     `submittedBy` user bag and per-issue error maps, and the result rebuilds
//     only the fields this server promises. `status` passes through as a
//     STRING so a status Atlassian adds tomorrow degrades to text a model can
//     read, not to `unexpected_shape`.
//  6. **Wire data enters as `unknown`** and is narrowed by hand-rolled guards
//     (ARCHITECTURE.md §Typing strategy). One wire quirk is absorbed here: the
//     OpenAPI document declares `created`/`started`/`updated` as ISO date-time
//     strings, but the endpoint's own documented example answers epoch
//     milliseconds — the numbers are what live tenants send, so numbers are
//     what the result carries, and a string in one of those slots is dropped
//     rather than fatal.
//
// Permissions follow the CC-34 pattern of `asCollabError` in `api/collab.ts`:
// every route needs the GLOBAL "Make bulk changes" permission, which even
// project admins frequently lack, and the submits additionally need Browse
// plus Delete/Edit issues in every project the selected issues belong to. A
// 403/404 therefore gets the permission appended to its remediation by name.
// ---------------------------------------------------------------------------

import { createJiraError } from '../core/errors.js';
import { encodeSegment } from '../core/http-util.js';
import {
  JiraError,
  type JiraRequestFn,
  type JiraRequestSpec,
  type JiraResponse,
} from '../core/types.js';
import type { BudgetGuard } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Endpoints and closed vocabularies
// ---------------------------------------------------------------------------

/** The bulk delete submit. A LITERAL path — the issues travel in the body. */
export const BULK_DELETE_PATH = '/bulk/issues/delete';

/**
 * The bulk EDIT submit. The path really is `fields` — there is NO
 * `/bulk/issues/edit` anywhere in the API (CC-130), and the sibling routes
 * that do exist under `/bulk/issues/` (move, transition, watch) are parked,
 * not exposed.
 */
export const BULK_EDIT_FIELDS_PATH = '/bulk/issues/fields';

/** `pathTemplate` for the queue read — logs and errors show this, never a task id. */
export const BULK_QUEUE_PATH_TEMPLATE = '/bulk/queue/{taskId}';

/** How a multi-select family (labels, fixVersions) is changed. */
export const BULK_EDIT_ACTIONS = ['ADD', 'REMOVE', 'REPLACE', 'REMOVE_ALL'] as const;

/** One value of {@link BULK_EDIT_ACTIONS}. */
export type BulkEditAction = (typeof BULK_EDIT_ACTIONS)[number];

/**
 * The task statuses the wire documents today. The KNOWN vocabulary, exported
 * for tool descriptions — {@link BulkStatusResult.status} deliberately stays a
 * plain string (module header rule 5).
 */
export const BULK_TASK_STATUSES = [
  'ENQUEUED',
  'RUNNING',
  'COMPLETE',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'DEAD',
] as const;

/** Jira ids in the edit families are positive integers, without exception. */
const POSITIVE_INT = /^[1-9][0-9]*$/;

const ISSUE_LIST_REMEDIATION =
  'Pass issue keys ("ABC-1") or numeric issue ids — at least one; the endpoint ' +
  'accepts at most 1000 per submit, subtasks included.';

const PRIORITY_REMEDIATION =
  'Pass the priority ID (a numeric string such as "3"), never the priority name.';

const ASSIGNEE_REMEDIATION =
  'Pass the accountId of the new assignee, or null to unassign — never a ' +
  'username or an email address (CC-19).';

const VERSION_REMEDIATION =
  'Pass numeric version ids from the project version list, never version names.';

const LABEL_REMEDIATION = 'Pass the label text itself; an empty string is not a label.';

const MULTI_SELECT_REMEDIATION =
  'Pass REMOVE_ALL with an empty values list to clear the field, or ' +
  'ADD/REMOVE/REPLACE with at least one value to change it.';

const TASK_ID_REMEDIATION =
  'Pass the taskId a bulk submit returned; the Jira UI shows the same id on ' +
  'its bulk-operation progress page.';

/** Appended to a refused delete submit (CC-34 pattern — see module header). */
const BULK_DELETE_HINT =
  'Bulk submits also need the global "Make bulk changes" permission, plus ' +
  'Browse projects and Delete issues in every project the selected issues ' +
  'belong to.';

/** Appended to a refused edit submit. */
const BULK_EDIT_HINT =
  'Bulk submits also need the global "Make bulk changes" permission, plus ' +
  'Browse projects and Edit issues in every project the selected issues ' +
  'belong to.';

/** Appended to a refused queue read. */
const BULK_QUEUE_HINT =
  'Reading bulk task progress needs the global "Make bulk changes" ' +
  'permission, and progress is kept for about 14 days after completion — an ' +
  'expired or foreign taskId reads as not found.';

// ---------------------------------------------------------------------------
// 2. Option shapes
// ---------------------------------------------------------------------------

/** What every call here needs: the injected wire seam and a cancellation. */
export interface BulkBase {
  /** The only way to reach Jira (`core/types.ts` §Wire). */
  readonly jira: JiraRequestFn;
  /** Cancellation from the MCP request; stamped onto every request issued. */
  readonly signal?: AbortSignal;
}

/** Options for a single-request bulk call. */
export type BulkOptions = BulkBase & BudgetGuard;

/**
 * Input of {@link submitBulkDeleteRequest} — the pure builder half of the
 * issues.ts §13 split, so the plan/apply gate shows exactly what it sends.
 */
export interface SubmitBulkDeleteInput {
  /** Issue keys (`ABC-1`) or numeric ids — `selectedIssueIdsOrKeys` on the wire. */
  readonly issues: readonly string[];
  /**
   * Omitted, the FIELD is omitted and Jira's own default (notify) applies —
   * the client invents no default (CC-131).
   */
  readonly sendBulkNotification?: boolean;
}

/** Options for {@link submitBulkDelete}. */
export type SubmitBulkDeleteOptions = BulkOptions & SubmitBulkDeleteInput;

/** One multi-select family change: what to do, and the values to do it with. */
export interface BulkMultiSelectEdit {
  readonly action: BulkEditAction;
  /** Empty EXACTLY when `action` is `REMOVE_ALL`; non-empty for every other action. */
  readonly values: readonly string[];
}

/**
 * Input of {@link submitBulkEditRequest}. At least one of the four field
 * families must be present — an edit that names no field would enqueue a task
 * that changes nothing, so it is refused before any request exists (D22).
 */
export interface SubmitBulkEditInput {
  /** Issue keys (`ABC-1`) or numeric ids — `selectedIssueIdsOrKeys` on the wire. */
  readonly issues: readonly string[];
  /** Label changes; `values` are the label strings. */
  readonly labels?: BulkMultiSelectEdit;
  /** The NUMERIC priority id. Single-select: the new value, no action needed. */
  readonly priorityId?: string;
  /** The new assignee's accountId, or `null` to unassign (CC-19). */
  readonly assignee?: { readonly accountId: string | null };
  /** Fix-version changes; `values` are NUMERIC version ids. */
  readonly fixVersions?: {
    readonly action: BulkEditAction;
    readonly versionIds: readonly string[];
  };
  /** Same pass-through as on the delete (CC-131). */
  readonly sendBulkNotification?: boolean;
}

/** Options for {@link submitBulkEdit}. */
export type SubmitBulkEditOptions = BulkOptions & SubmitBulkEditInput;

/** Options for {@link getBulkStatus}. */
export type GetBulkStatusOptions = BulkOptions & {
  /** The id a submit returned; also visible in the Jira UI. */
  readonly taskId: string;
};

// ---------------------------------------------------------------------------
// 3. Result shapes — the allowlists, in type form
// ---------------------------------------------------------------------------

/**
 * What a submit is worth: the handle to poll. Everything else about the
 * operation is future tense until {@link getBulkStatus} says otherwise
 * (CC-127).
 */
export interface BulkSubmitResult {
  readonly taskId: string;
}

/** Progress of one bulk task, narrowed from the wire's `BulkOperationProgress`. */
export interface BulkStatusResult {
  readonly taskId: string;
  /**
   * The wire enum passed through as text — {@link BULK_TASK_STATUSES} is the
   * vocabulary documented today (module header rule 5).
   */
  readonly status: string;
  readonly progressPercent?: number;
  readonly totalIssueCount?: number;
  /** How many issues the task has processed — `processedAccessibleIssues.length`. */
  readonly processedCount?: number;
  /** How many issues FAILED — the size of the wire's per-issue error map. */
  readonly failedCount?: number;
  /**
   * Issues the submit named that the task will never touch: unknown ids and
   * issues the account cannot see, folded into one count by Jira on purpose
   * (existence is not leaked to an account without Browse).
   */
  readonly invalidOrInaccessibleIssueCount?: number;
  /** Epoch milliseconds, passed through as numbers (module header rule 6). */
  readonly created?: number;
  readonly started?: number;
  readonly updated?: number;
}

// ---------------------------------------------------------------------------
// 4. The submits (builder + executor per route, the issues.ts §13 split)
// ---------------------------------------------------------------------------

/**
 * Build the spec of a bulk delete — `POST /bulk/issues/delete` with the issue
 * list in the body. Subtasks of a selected parent are deleted WITH it and
 * count against the 1000-issue cap (the cap itself is enforced in the tool
 * input schema, CC-128 — this layer refuses only what would be garbage on the
 * wire).
 *
 * Pure builder (issues.ts §13): the plan/apply gate calls it twice — once to
 * SHOW the request, once to send it — so it validates and builds but never
 * touches the wire, and the spec carries no signal/deadline (the executor
 * stamps those).
 */
export function submitBulkDeleteRequest(input: SubmitBulkDeleteInput): JiraRequestSpec {
  return {
    method: 'POST',
    path: BULK_DELETE_PATH,
    body: {
      selectedIssueIdsOrKeys: requireIssues(input.issues),
      // Absent means ABSENT (CC-131): Jira's own default applies, and
      // `sendBulkNotification: undefined` would not survive JSON anyway —
      // better that it never exists than that a serializer decides.
      ...(input.sendBulkNotification === undefined
        ? {}
        : { sendBulkNotification: input.sendBulkNotification }),
    },
  };
}

/**
 * Enqueue a bulk delete. Jira answers 201 with a task id — the deletion has
 * NOT happened yet (CC-127); poll {@link getBulkStatus}. No `safe` flag on the
 * spec: an unsafe write is never replayed on an ambiguous failure, because the
 * replay would enqueue a second task (CC-12/13).
 */
export async function submitBulkDelete(
  options: SubmitBulkDeleteOptions,
): Promise<BulkSubmitResult> {
  const response = await bulkCall(BULK_DELETE_HINT, () =>
    options.jira({ ...submitBulkDeleteRequest(options), ...writeControls(options) }),
  );
  return mapSubmitted(response.data);
}

/**
 * Build the spec of a bulk edit — `POST /bulk/issues/fields`, the only edit
 * path the API has (CC-130). This builder is where the semantic arguments
 * become the wire's vocabulary:
 *
 *   * `labels`      → `labelsFields: [{ fieldId, bulkEditMultiSelectFieldOption, labels: [{name}] }]`
 *   * `priorityId`  → `priority: { priorityId }` (single-select — no action)
 *   * `assignee`    → `singleSelectClearableUserPickerFields: [{ fieldId, user }]`,
 *                     where a `null` accountId becomes `user: null` — the
 *                     documented "unassign" spelling
 *   * `fixVersions` → `multipleVersionPickerFields: [{ fieldId, bulkEditMultiSelectFieldOption, versions: [{versionId}] }]`
 *
 * `selectedActions` is DERIVED from the families that are present, so the
 * field list and the payload cannot disagree (CC-130). The multi-select
 * pairing rule is enforced per family (CC-133): `REMOVE_ALL` takes no values
 * and every other action requires at least one — and for `REMOVE_ALL` the
 * empty array IS sent, because the wire requires the values key even when the
 * action ignores it.
 */
export function submitBulkEditRequest(input: SubmitBulkEditInput): JiraRequestSpec {
  const selectedIssueIdsOrKeys = requireIssues(input.issues);
  const editedFieldsInput: Record<string, unknown> = {};
  const selectedActions: string[] = [];

  if (input.labels !== undefined) {
    editedFieldsInput.labelsFields = [
      {
        fieldId: 'labels',
        bulkEditMultiSelectFieldOption: input.labels.action,
        labels: multiSelectValues(input.labels.action, input.labels.values, 'labels').map(
          (value) => ({ name: requireText(value, 'label', LABEL_REMEDIATION) }),
        ),
      },
    ];
    selectedActions.push('labels');
  }
  if (input.priorityId !== undefined) {
    editedFieldsInput.priority = {
      priorityId: positiveId(input.priorityId, 'priorityId', PRIORITY_REMEDIATION),
    };
    selectedActions.push('priority');
  }
  if (input.assignee !== undefined) {
    editedFieldsInput.singleSelectClearableUserPickerFields = [
      {
        fieldId: 'assignee',
        user:
          input.assignee.accountId === null
            ? null
            : {
                accountId: requireText(
                  input.assignee.accountId,
                  'assignee accountId',
                  ASSIGNEE_REMEDIATION,
                ),
              },
      },
    ];
    selectedActions.push('assignee');
  }
  if (input.fixVersions !== undefined) {
    editedFieldsInput.multipleVersionPickerFields = [
      {
        fieldId: 'fixVersions',
        bulkEditMultiSelectFieldOption: input.fixVersions.action,
        versions: multiSelectValues(
          input.fixVersions.action,
          input.fixVersions.versionIds,
          'fixVersions',
        ).map((value) => ({
          versionId: positiveId(value, 'fixVersions versionId', VERSION_REMEDIATION),
        })),
      },
    ];
    selectedActions.push('fixVersions');
  }

  if (selectedActions.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'A bulk edit needs at least one field family (labels, priorityId, ' +
        'assignee or fixVersions). Nothing was sent.',
      remediation:
        'Name the fields to change — an edit with no fields would enqueue a ' +
        'task that changes nothing.',
    });
  }

  return {
    method: 'POST',
    path: BULK_EDIT_FIELDS_PATH,
    body: {
      editedFieldsInput,
      selectedActions,
      selectedIssueIdsOrKeys,
      ...(input.sendBulkNotification === undefined
        ? {}
        : { sendBulkNotification: input.sendBulkNotification }),
    },
  };
}

/**
 * Enqueue a bulk edit. The same asynchronous contract as
 * {@link submitBulkDelete}: 201 means ENQUEUED (CC-127), no `safe` flag, never
 * replayed (CC-12/13).
 */
export async function submitBulkEdit(
  options: SubmitBulkEditOptions,
): Promise<BulkSubmitResult> {
  const response = await bulkCall(BULK_EDIT_HINT, () =>
    options.jira({ ...submitBulkEditRequest(options), ...writeControls(options) }),
  );
  return mapSubmitted(response.data);
}

// ---------------------------------------------------------------------------
// 5. The queue read
// ---------------------------------------------------------------------------

/**
 * Read one bulk task's progress — `GET /bulk/queue/{taskId}`. Works for any
 * task the account may see, UI-submitted ones included (CC-132), for about 14
 * days after completion. An ordinary safe GET: no flag needed, retried
 * normally.
 */
export async function getBulkStatus(
  options: GetBulkStatusOptions,
): Promise<BulkStatusResult> {
  const taskId = pathSegment(options.taskId, 'taskId', TASK_ID_REMEDIATION);
  const response = await bulkCall(BULK_QUEUE_HINT, () =>
    sendOne(options, {
      method: 'GET',
      path: `/bulk/queue/${taskId}`,
      pathTemplate: BULK_QUEUE_PATH_TEMPLATE,
    }),
  );
  return mapProgress(requireRecord(response.data, 'bulk task progress'));
}

// ---------------------------------------------------------------------------
// 6. Response mappers (allowlists — module header rule 5)
// ---------------------------------------------------------------------------

/**
 * A submit receipt is one field. The wire schema marks `taskId` optional, but
 * a 201 without one is a handle to nothing — this server treats it as the
 * shape mismatch it is rather than returning an unpollable success.
 */
function mapSubmitted(data: unknown): BulkSubmitResult {
  const body = requireRecord(data, 'bulk submit receipt');
  return {
    taskId: requireField(readString(body, 'taskId'), 'taskId', 'bulk submit receipt'),
  };
}

function mapProgress(body: Record<string, unknown>): BulkStatusResult {
  // The two id-level collections are folded into COUNTS: a model polling a
  // task needs "2 of 3, 1 failed", and the per-issue detail (which ids, which
  // error strings) is on the Jira UI's progress page the tool description
  // points at. Tolerant reads throughout — a slot that is not the expected
  // shape is dropped, not fatal (only `taskId` and `status` are load-bearing).
  const processed = body.processedAccessibleIssues;
  const failed = asRecord(body.failedAccessibleIssues);
  return compact({
    taskId: requireField(readString(body, 'taskId'), 'taskId', 'bulk task progress'),
    status: requireField(readString(body, 'status'), 'status', 'bulk task progress'),
    progressPercent: readNumber(body, 'progressPercent'),
    totalIssueCount: readNumber(body, 'totalIssueCount'),
    processedCount: Array.isArray(processed) ? processed.length : undefined,
    failedCount: failed === undefined ? undefined : Object.keys(failed).length,
    invalidOrInaccessibleIssueCount: readNumber(body, 'invalidOrInaccessibleIssueCount'),
    // Epoch millis per the documented example; the schema's date-time claim is
    // wrong on live tenants (module header rule 6), so a string is dropped.
    created: readNumber(body, 'created'),
    started: readNumber(body, 'started'),
    updated: readNumber(body, 'updated'),
  });
}

// ---------------------------------------------------------------------------
// 7. Wire plumbing and validation (D22 — every refusal names the field)
// ---------------------------------------------------------------------------

/** Forward exactly one request, stamping the caller's signal and deadline. */
function sendOne(
  options: BulkOptions,
  spec: JiraRequestSpec,
): Promise<JiraResponse<unknown>> {
  return options.jira({
    ...spec,
    signal: spec.signal ?? options.signal,
    deadlineAt: spec.deadlineAt ?? options.deadlineAt,
  });
}

/**
 * The executor's half of the issues.ts §13 split: the controls the pure
 * builders must not stamp. Spread AFTER the builder's spec.
 */
function writeControls(
  options: BulkOptions,
): Pick<JiraRequestSpec, 'signal' | 'deadlineAt'> {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  };
}

/** Run one call, appending the bulk permission hint to a refusal (CC-34 pattern). */
async function bulkCall<T>(hint: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asBulkError(error, hint);
  }
}

/**
 * Append the "Make bulk changes" hint to a 403/404 the client already read as
 * a permission or existence problem. The kind is kept — the ids really may be
 * wrong — and every other failure passes through untouched (an `auth` 403 is
 * that token's problem, not this permission's).
 */
function asBulkError(error: unknown, hint: string): unknown {
  if (!(error instanceof JiraError)) return error;
  const status = error.httpStatus;
  if (status !== 403 && status !== 404) return error;
  if (error.kind !== 'permission' && error.kind !== 'not_found') return error;

  // The cause sentence without its remediation — first-class on every error
  // `createJiraError` builds, never re-parsed out of the composed message. The
  // fallback keeps the whole message; it is unreachable from this path, since
  // a 403/404 read as permission/not_found was made by `responseError`.
  const reason = error.reason ?? error.message;

  return createJiraError({
    kind: error.kind,
    reason,
    httpStatus: status,
    ...(error.jiraMessages === undefined ? {} : { jiraMessages: error.jiraMessages }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    remediation: error.remediation === undefined ? hint : `${error.remediation} ${hint}`,
    cause: error,
  });
}

/**
 * The issue list both submits share: at least one entry, none blank. The
 * 1000-issue cap is the input schema's job (CC-128); Jira validates it again
 * server-side, so an over-cap list that somehow got here fails loudly there.
 */
function requireIssues(issues: readonly string[]): string[] {
  if (issues.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason: 'A bulk submit needs at least one issue key or id. Nothing was sent.',
      remediation: ISSUE_LIST_REMEDIATION,
    });
  }
  return issues.map((issue) =>
    requireText(issue, 'issue key or id', ISSUE_LIST_REMEDIATION),
  );
}

/**
 * The CC-133 pairing rule, enforced where the payload is built: `REMOVE_ALL`
 * clears the field and takes NO values (the empty array still travels — the
 * wire requires the key); every other action without values would be a no-op
 * dressed as a change, so it is refused instead of sent.
 */
function multiSelectValues(
  action: BulkEditAction,
  values: readonly string[],
  field: string,
): readonly string[] {
  if (action === 'REMOVE_ALL') {
    if (values.length > 0) {
      throw createJiraError({
        kind: 'validation',
        reason:
          `${field} REMOVE_ALL clears the whole field and takes no values, ` +
          `but ${String(values.length)} were passed. Nothing was sent.`,
        remediation: MULTI_SELECT_REMEDIATION,
      });
    }
    return values;
  }
  if (values.length === 0) {
    throw createJiraError({
      kind: 'validation',
      reason: `${field} ${action} needs at least one value. Nothing was sent.`,
      remediation: MULTI_SELECT_REMEDIATION,
    });
  }
  return values;
}

/** Validate-and-encode ONE path segment (see `api/collab.ts` for the why). */
function pathSegment(value: string, what: string, remediation: string): string {
  return encodeSegment(requireText(value, what, remediation), what);
}

/**
 * Validate a positive-integer id. Priority and version ids are always
 * positive integers, so anything else is a caller mistake — most often a NAME
 * where an id belongs (D22 — refuse with the field's name, send nothing).
 */
function positiveId(value: string, what: string, remediation: string): string {
  const text = value.trim();
  if (!POSITIVE_INT.test(text)) {
    throw createJiraError({
      kind: 'validation',
      reason: `${what} must be a positive integer Jira id, received ${JSON.stringify(value)}. Nothing was sent.`,
      remediation,
    });
  }
  return text;
}

/** A required non-empty string, trimmed (D22 — the refusal names the field). */
function requireText(value: string, what: string, remediation: string): string {
  const clean = value.trim();
  if (clean === '') {
    throw createJiraError({
      kind: 'validation',
      reason: `A ${what} is required and must not be empty. Nothing was sent.`,
      remediation,
    });
  }
  return clean;
}

const SHAPE_REMEDIATION =
  'Re-run the call; a persistent mismatch means the Jira API changed (see docs/JIRA-API.md).';

function shapeError(message: string): JiraError {
  return createJiraError({
    kind: 'unexpected_shape',
    reason: message,
    remediation: SHAPE_REMEDIATION,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) {
    throw shapeError(`Jira returned a ${what} that is not a JSON object.`);
  }
  return record;
}

function requireField(value: string | undefined, field: string, what: string): string {
  if (value === undefined) {
    throw shapeError(`Jira returned a ${what} without a usable "${field}".`);
  }
  return value;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Drop `undefined`-valued keys so optional result fields are ABSENT, not `undefined`. */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}
