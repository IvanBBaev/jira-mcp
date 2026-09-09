// Tests for api/bulk.ts — the bulk-operations surface (WP-120, D103).
//
// Contract tier (TESTING.md §Mocking tiers): every case drives the module
// through `fakeJiraRequest`, so no socket is involved and the assertions are
// about what this ring promises — the request it builds, the allowlist it
// narrows the response to, and the refusals it produces BEFORE a request exists.
//
// Bodies are inline plain objects marked `// synthetic`, shaped field-for-field
// like the documented `BulkOperationProgress` / `SubmittedBulkOperation`
// responses and using the placeholder vocabulary the fixture PII lint enforces.
//
// Three groups of cases are load-bearing rather than incidental:
//
//  * the WHOLE-BODY deepEqual cases on both submits, because the edit payload
//    is a translation layer (semantic args → `labelsFields`/`selectedActions`
//    wire vocabulary, CC-130) and a translator is exactly the code that drifts
//    one key at a time;
//  * the `sendBulkNotification` triple (absent/true/false), because CC-131's
//    claim is about a key's PRESENCE, which a truthiness-minded refactor would
//    silently break;
//  * the `safe`-flag absence cases: a replayed submit enqueues a SECOND task
//    over the same issues, so the retry matrix must read these POSTs as
//    unsafe (CC-12/13) — absent, not `false`, because presence is what it reads.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createJiraError } from '../core/errors.js';
import {
  createFakeClock,
  createFakeJiraRequest,
  jiraErr,
  jiraOk,
} from '../core/fakes/index.js';
import { JiraError } from '../core/types.js';
import {
  BULK_DELETE_PATH,
  BULK_EDIT_FIELDS_PATH,
  BULK_QUEUE_PATH_TEMPLATE,
  getBulkStatus,
  submitBulkDelete,
  submitBulkDeleteRequest,
  submitBulkEdit,
  submitBulkEditRequest,
} from './bulk.js';

const ACCOUNT_ID = '5b10a2844c20165700ede21g';

/** The receipt both submits answer with. // synthetic */
const SUBMITTED = jiraOk({ taskId: '10000' }, { status: 201 });

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to reject');
}

function asJiraError(error: unknown): JiraError {
  assert.ok(error instanceof JiraError, `expected a JiraError, got ${String(error)}`);
  return error;
}

// ---------------------------------------------------------------------------
// The delete submit
// ---------------------------------------------------------------------------

test('submitBulkDeleteRequest builds the bare spec the plan shows', () => {
  // Whole-spec deepEqual: a builder that stamped a signal, a deadline or a
  // `safe` flag here would be doing the executor's job.
  assert.deepEqual(submitBulkDeleteRequest({ issues: ['SAN-1', '10002'] }), {
    method: 'POST',
    path: BULK_DELETE_PATH,
    body: { selectedIssueIdsOrKeys: ['SAN-1', '10002'] },
  });
  assert.deepEqual(
    submitBulkDeleteRequest({ issues: ['SAN-1'], sendBulkNotification: false }),
    {
      method: 'POST',
      path: BULK_DELETE_PATH,
      body: { selectedIssueIdsOrKeys: ['SAN-1'], sendBulkNotification: false },
    },
  );
});

test('submitBulkDelete posts the issue list and returns the task handle', async () => {
  const jira = createFakeJiraRequest().enqueue(SUBMITTED);

  const receipt = await submitBulkDelete({ jira: jira.fn, issues: ['SAN-1', 'SAN-2'] });

  const spec = jira.lastRequest();
  assert.deepEqual(jira.routes(), ['POST /rest/api/3/bulk/issues/delete']);
  assert.deepEqual(spec?.body, { selectedIssueIdsOrKeys: ['SAN-1', 'SAN-2'] });
  // CC-12/13: an unsafe write is never replayed, so `safe` must be absent —
  // not `false`, absent: the retry matrix reads the property's presence.
  assert.equal(spec?.safe, undefined);
  assert.equal(Object.hasOwn(spec ?? {}, 'safe'), false);
  // CC-127: the receipt is a handle to poll, nothing else.
  assert.deepEqual(receipt, { taskId: '10000' });
});

test('CC-131: sendBulkNotification passes through and absent stays ABSENT', async () => {
  const jira = createFakeJiraRequest()
    .enqueue(SUBMITTED)
    .enqueue(SUBMITTED)
    .enqueue(SUBMITTED);

  // Absent: the KEY is absent, so Jira's own default (notify) applies.
  await submitBulkDelete({ jira: jira.fn, issues: ['SAN-1'] });
  assert.equal(
    Object.hasOwn(jira.lastRequest()?.body ?? {}, 'sendBulkNotification'),
    false,
  );

  // Explicit values travel verbatim — `false` is a real choice, not a default.
  await submitBulkDelete({
    jira: jira.fn,
    issues: ['SAN-1'],
    sendBulkNotification: true,
  });
  assert.deepEqual(jira.lastRequest()?.body, {
    selectedIssueIdsOrKeys: ['SAN-1'],
    sendBulkNotification: true,
  });
  await submitBulkDelete({
    jira: jira.fn,
    issues: ['SAN-1'],
    sendBulkNotification: false,
  });
  assert.deepEqual(jira.lastRequest()?.body, {
    selectedIssueIdsOrKeys: ['SAN-1'],
    sendBulkNotification: false,
  });
});

test('the delete refuses an empty or blank issue list before any request exists', async () => {
  const jira = createFakeJiraRequest();

  const empty = asJiraError(
    await caught(() => submitBulkDelete({ jira: jira.fn, issues: [] })),
  );
  assert.equal(empty.kind, 'validation');
  assert.match(empty.message, /at least one issue/);
  assert.match(empty.message, /Nothing was sent/);

  const blank = asJiraError(
    await caught(() => submitBulkDelete({ jira: jira.fn, issues: ['SAN-1', '  '] })),
  );
  assert.equal(blank.kind, 'validation');
  assert.match(blank.message, /issue key or id/);

  assert.deepEqual(jira.routes(), []);
});

// ---------------------------------------------------------------------------
// The edit submit — the vocabulary translation (CC-130)
// ---------------------------------------------------------------------------

test('CC-130: the edit posts to /bulk/issues/fields and derives selectedActions', async () => {
  const jira = createFakeJiraRequest().enqueue(SUBMITTED);

  const receipt = await submitBulkEdit({
    jira: jira.fn,
    issues: ['SAN-1', 'SAN-2'],
    labels: { action: 'ADD', values: ['triage', 'backend'] },
    priorityId: '3',
    assignee: { accountId: ACCOUNT_ID },
    fixVersions: { action: 'REPLACE', versionIds: ['10201'] },
    sendBulkNotification: false,
  });

  const spec = jira.lastRequest();
  // NOT /bulk/issues/edit — that path does not exist in the API.
  assert.deepEqual(jira.routes(), ['POST /rest/api/3/bulk/issues/fields']);
  // Whole-body deepEqual: the payload and the derived `selectedActions` must
  // agree, and nothing the caller never said may ride along.
  assert.deepEqual(spec?.body, {
    editedFieldsInput: {
      labelsFields: [
        {
          fieldId: 'labels',
          bulkEditMultiSelectFieldOption: 'ADD',
          labels: [{ name: 'triage' }, { name: 'backend' }],
        },
      ],
      priority: { priorityId: '3' },
      singleSelectClearableUserPickerFields: [
        { fieldId: 'assignee', user: { accountId: ACCOUNT_ID } },
      ],
      multipleVersionPickerFields: [
        {
          fieldId: 'fixVersions',
          bulkEditMultiSelectFieldOption: 'REPLACE',
          versions: [{ versionId: '10201' }],
        },
      ],
    },
    selectedActions: ['labels', 'priority', 'assignee', 'fixVersions'],
    selectedIssueIdsOrKeys: ['SAN-1', 'SAN-2'],
    sendBulkNotification: false,
  });
  assert.equal(spec?.safe, undefined);
  assert.equal(Object.hasOwn(spec ?? {}, 'safe'), false);
  assert.deepEqual(receipt, { taskId: '10000' });
});

test('submitBulkEditRequest builds the bare spec the plan shows', () => {
  assert.deepEqual(submitBulkEditRequest({ issues: ['SAN-1'], priorityId: '2' }), {
    method: 'POST',
    path: BULK_EDIT_FIELDS_PATH,
    body: {
      editedFieldsInput: { priority: { priorityId: '2' } },
      selectedActions: ['priority'],
      selectedIssueIdsOrKeys: ['SAN-1'],
    },
  });
});

test('every labels action travels, REMOVE_ALL with the empty list the wire requires', async () => {
  const jira = createFakeJiraRequest();

  for (const action of ['ADD', 'REMOVE', 'REPLACE'] as const) {
    jira.enqueue(SUBMITTED);
    await submitBulkEdit({
      jira: jira.fn,
      issues: ['SAN-1'],
      labels: { action, values: ['triage'] },
    });
    assert.deepEqual(jira.lastRequest()?.body, {
      editedFieldsInput: {
        labelsFields: [
          {
            fieldId: 'labels',
            bulkEditMultiSelectFieldOption: action,
            labels: [{ name: 'triage' }],
          },
        ],
      },
      selectedActions: ['labels'],
      selectedIssueIdsOrKeys: ['SAN-1'],
    });
  }

  // REMOVE_ALL: no values — but the `labels` key still travels, empty, because
  // the wire schema requires it even when the action ignores it.
  jira.enqueue(SUBMITTED);
  await submitBulkEdit({
    jira: jira.fn,
    issues: ['SAN-1'],
    labels: { action: 'REMOVE_ALL', values: [] },
  });
  assert.deepEqual(jira.lastRequest()?.body, {
    editedFieldsInput: {
      labelsFields: [
        { fieldId: 'labels', bulkEditMultiSelectFieldOption: 'REMOVE_ALL', labels: [] },
      ],
    },
    selectedActions: ['labels'],
    selectedIssueIdsOrKeys: ['SAN-1'],
  });
});

test('a null assignee becomes user: null — the documented unassign spelling', async () => {
  const jira = createFakeJiraRequest().enqueue(SUBMITTED);

  await submitBulkEdit({
    jira: jira.fn,
    issues: ['SAN-1'],
    assignee: { accountId: null },
  });

  assert.deepEqual(jira.lastRequest()?.body, {
    editedFieldsInput: {
      singleSelectClearableUserPickerFields: [{ fieldId: 'assignee', user: null }],
    },
    selectedActions: ['assignee'],
    selectedIssueIdsOrKeys: ['SAN-1'],
  });
});

test('a single fixVersions family travels alone', async () => {
  const jira = createFakeJiraRequest().enqueue(SUBMITTED);

  await submitBulkEdit({
    jira: jira.fn,
    issues: ['10001'],
    fixVersions: { action: 'REMOVE', versionIds: ['10201', '10202'] },
  });

  assert.deepEqual(jira.lastRequest()?.body, {
    editedFieldsInput: {
      multipleVersionPickerFields: [
        {
          fieldId: 'fixVersions',
          bulkEditMultiSelectFieldOption: 'REMOVE',
          versions: [{ versionId: '10201' }, { versionId: '10202' }],
        },
      ],
    },
    selectedActions: ['fixVersions'],
    selectedIssueIdsOrKeys: ['10001'],
  });
});

test('CC-133: a mispaired multi-select edit is refused, nothing sent', async () => {
  const jira = createFakeJiraRequest();

  // REMOVE_ALL clears the field — passing values with it is ambiguous intent.
  const removeAll = asJiraError(
    await caught(() =>
      submitBulkEdit({
        jira: jira.fn,
        issues: ['SAN-1'],
        labels: { action: 'REMOVE_ALL', values: ['triage'] },
      }),
    ),
  );
  assert.equal(removeAll.kind, 'validation');
  assert.match(removeAll.message, /REMOVE_ALL/);
  assert.match(removeAll.message, /Nothing was sent/);

  // Every other action without values would be a no-op dressed as a change.
  const emptyAdd = asJiraError(
    await caught(() =>
      submitBulkEdit({
        jira: jira.fn,
        issues: ['SAN-1'],
        labels: { action: 'ADD', values: [] },
      }),
    ),
  );
  assert.equal(emptyAdd.kind, 'validation');
  assert.match(emptyAdd.message, /labels ADD needs at least one value/);

  const emptyReplace = asJiraError(
    await caught(() =>
      submitBulkEdit({
        jira: jira.fn,
        issues: ['SAN-1'],
        fixVersions: { action: 'REPLACE', versionIds: [] },
      }),
    ),
  );
  assert.equal(emptyReplace.kind, 'validation');
  assert.match(emptyReplace.message, /fixVersions REPLACE needs at least one value/);

  assert.deepEqual(jira.routes(), []);
});

test('an edit that names no field family is refused, nothing sent', async () => {
  const jira = createFakeJiraRequest();

  const error = asJiraError(
    await caught(() => submitBulkEdit({ jira: jira.fn, issues: ['SAN-1'] })),
  );

  assert.equal(error.kind, 'validation');
  assert.match(error.message, /at least one field family/);
  assert.match(error.message, /Nothing was sent/);
  assert.deepEqual(jira.routes(), []);
});

test('the edit refuses malformed values before any request exists', async () => {
  const jira = createFakeJiraRequest();

  // A NAME where a numeric id belongs is the classic mistake (D22).
  const badPriority = asJiraError(
    await caught(() =>
      submitBulkEdit({ jira: jira.fn, issues: ['SAN-1'], priorityId: 'Highest' }),
    ),
  );
  assert.equal(badPriority.kind, 'validation');
  assert.match(badPriority.message, /priorityId must be a positive integer/);

  const badVersion = asJiraError(
    await caught(() =>
      submitBulkEdit({
        jira: jira.fn,
        issues: ['SAN-1'],
        fixVersions: { action: 'ADD', versionIds: ['v2.0'] },
      }),
    ),
  );
  assert.equal(badVersion.kind, 'validation');
  assert.match(badVersion.message, /versionId must be a positive integer/);

  const badAssignee = asJiraError(
    await caught(() =>
      submitBulkEdit({ jira: jira.fn, issues: ['SAN-1'], assignee: { accountId: '' } }),
    ),
  );
  assert.equal(badAssignee.kind, 'validation');
  assert.match(badAssignee.message, /assignee accountId/);

  const badLabel = asJiraError(
    await caught(() =>
      submitBulkEdit({
        jira: jira.fn,
        issues: ['SAN-1'],
        labels: { action: 'ADD', values: ['  '] },
      }),
    ),
  );
  assert.equal(badLabel.kind, 'validation');
  assert.match(badLabel.message, /label/);

  assert.deepEqual(jira.routes(), []);
});

// ---------------------------------------------------------------------------
// The queue read
// ---------------------------------------------------------------------------

test('getBulkStatus narrows the progress record to counts a model can poll', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({
      // synthetic — shaped like the endpoint's documented 200
      taskId: '10000',
      status: 'COMPLETE',
      progressPercent: 100,
      totalIssueCount: 3,
      processedAccessibleIssues: [10001, 10002],
      failedAccessibleIssues: {
        '10003': ['Issue does not exist or you do not have permission to see it.'],
      },
      invalidOrInaccessibleIssueCount: 0,
      created: 1704110400000,
      started: 1704110460000,
      updated: 1704110520000,
      // Must never reach a caller (allowlist, D41).
      submittedBy: { accountId: ACCOUNT_ID },
    }),
  );

  const progress = await getBulkStatus({ jira: jira.fn, taskId: '10000' });

  assert.deepEqual(jira.routes(), ['GET /rest/api/3/bulk/queue/10000']);
  assert.equal(jira.lastRequest()?.pathTemplate, BULK_QUEUE_PATH_TEMPLATE);
  // Whole-object deepEqual: the id-level collections are folded into COUNTS
  // and the user bag is dropped — a field Atlassian adds tomorrow must not
  // reach a model by default.
  assert.deepEqual(progress, {
    taskId: '10000',
    status: 'COMPLETE',
    progressPercent: 100,
    totalIssueCount: 3,
    processedCount: 2,
    failedCount: 1,
    invalidOrInaccessibleIssueCount: 0,
    created: 1704110400000,
    started: 1704110460000,
    updated: 1704110520000,
  });
});

test('a terse ENQUEUED body maps without invented fields', async () => {
  const jira = createFakeJiraRequest().enqueue(
    // synthetic — a task read back the moment after submit
    jiraOk({ taskId: '10000', status: 'ENQUEUED' }),
  );

  const progress = await getBulkStatus({ jira: jira.fn, taskId: '10000' });

  // Absent upstream means ABSENT here — `processedCount: undefined` would
  // read as "zero-ish" through JSON.stringify's eyes and it must not exist.
  assert.deepEqual(progress, { taskId: '10000', status: 'ENQUEUED' });
  assert.equal(Object.hasOwn(progress, 'processedCount'), false);
  assert.equal(Object.hasOwn(progress, 'failedCount'), false);
  assert.equal(Object.hasOwn(progress, 'created'), false);
});

test('malformed optional slots are dropped, and an unknown status passes through', async () => {
  const jira = createFakeJiraRequest().enqueue(
    jiraOk({
      // synthetic — the shapes the OpenAPI document CLAIMS for the timestamps
      // (date-time strings) plus corrupted collections; only taskId and status
      // are load-bearing, everything else degrades to absence.
      taskId: '10000',
      status: 'HALF_COMPLETED',
      created: '2024-01-01T12:00:00.000Z',
      processedAccessibleIssues: 'not-an-array',
      failedAccessibleIssues: ['not-a-map'],
      progressPercent: 'fifty',
    }),
  );

  const progress = await getBulkStatus({ jira: jira.fn, taskId: '10000' });

  // Pass-through status (module header rule 5): a vocabulary Atlassian grows
  // tomorrow degrades to text a model can read, not to `unexpected_shape`.
  assert.deepEqual(progress, { taskId: '10000', status: 'HALF_COMPLETED' });
});

test('the taskId is validated as one path segment before any request exists', async () => {
  const jira = createFakeJiraRequest();

  const empty = asJiraError(
    await caught(() => getBulkStatus({ jira: jira.fn, taskId: '   ' })),
  );
  assert.equal(empty.kind, 'validation');
  assert.match(empty.message, /taskId/);

  const traversal = asJiraError(
    await caught(() => getBulkStatus({ jira: jira.fn, taskId: '..' })),
  );
  assert.equal(traversal.kind, 'validation');

  assert.deepEqual(jira.routes(), []);
});

// ---------------------------------------------------------------------------
// Shape guards, error hints, and the controls
// ---------------------------------------------------------------------------

test('an unexpected response shape fails the house way, never silently', async () => {
  // A submit that answers a non-object.
  const textBody = createFakeJiraRequest().enqueue(jiraOk('Accepted', { status: 201 }));
  const nonObject = asJiraError(
    await caught(() => submitBulkDelete({ jira: textBody.fn, issues: ['SAN-1'] })),
  );
  assert.equal(nonObject.kind, 'unexpected_shape');

  // A 201 without a taskId is a handle to nothing, not a success.
  const noTask = createFakeJiraRequest().enqueue(jiraOk({}, { status: 201 })); // synthetic
  const missingTask = asJiraError(
    await caught(() =>
      submitBulkEdit({ jira: noTask.fn, issues: ['SAN-1'], priorityId: '3' }),
    ),
  );
  assert.equal(missingTask.kind, 'unexpected_shape');
  assert.match(missingTask.message, /taskId/);

  // A progress record without a status cannot be polled meaningfully.
  const noStatus = createFakeJiraRequest().enqueue(jiraOk({ taskId: '10000' })); // synthetic
  const missingStatus = asJiraError(
    await caught(() => getBulkStatus({ jira: noStatus.fn, taskId: '10000' })),
  );
  assert.equal(missingStatus.kind, 'unexpected_shape');
  assert.match(missingStatus.message, /status/);
});

test('a refused call names the Make bulk changes permission (CC-34 pattern)', async () => {
  const denied = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'permission',
        reason: 'Jira refused the request (403).',
        httpStatus: 403,
      }),
    ),
  );
  const error = asJiraError(
    await caught(() => submitBulkDelete({ jira: denied.fn, issues: ['SAN-1'] })),
  );
  assert.equal(error.kind, 'permission');
  assert.match(error.message, /Make bulk changes/);
  assert.match(error.message, /Delete issues/);
  // The cause sentence rides through first-class — once, not re-composed twice.
  assert.equal(error.reason, 'Jira refused the request (403).');
  assert.ok(error.message.startsWith('Jira refused the request (403). '));
  assert.ok(!error.message.slice('Jira refused'.length).includes('Jira refused'));

  // A vanished task: expired (14-day retention) or someone else's.
  const gone = createFakeJiraRequest().enqueue(
    jiraErr(
      createJiraError({
        kind: 'not_found',
        reason: 'Jira could not find task 10000.',
        httpStatus: 404,
      }),
    ),
  );
  const notFound = asJiraError(
    await caught(() => getBulkStatus({ jira: gone.fn, taskId: '10000' })),
  );
  assert.equal(notFound.kind, 'not_found');
  assert.match(notFound.message, /14 days/);

  // An `auth` 403 is that token's problem, not this permission's — untouched.
  const expired = createJiraError({
    kind: 'auth',
    reason: 'The token was rejected.',
    httpStatus: 403,
  });
  const badToken = createFakeJiraRequest().enqueue(jiraErr(expired));
  const passedThrough = asJiraError(
    await caught(() => submitBulkDelete({ jira: badToken.fn, issues: ['SAN-1'] })),
  );
  assert.equal(passedThrough, expired);
});

test('the calls carry the caller signal and deadline onto the wire', async () => {
  const controller = new AbortController();
  const jira = createFakeJiraRequest()
    .enqueue(SUBMITTED)
    .enqueue(jiraOk({ taskId: '10000', status: 'RUNNING' })); // synthetic

  await submitBulkEdit({
    jira: jira.fn,
    issues: ['SAN-1'],
    priorityId: '3',
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });
  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);

  await getBulkStatus({
    jira: jira.fn,
    taskId: '10000',
    signal: controller.signal,
    clock: createFakeClock(0),
    deadlineAt: 5_000,
  });
  assert.equal(jira.lastRequest()?.signal, controller.signal);
  assert.equal(jira.lastRequest()?.deadlineAt, 5_000);
});
