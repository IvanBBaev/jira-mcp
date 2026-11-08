// ---------------------------------------------------------------------------
// api/datacenter/users.ts — `/myself`, the user search and mention resolution on Jira
// Data Center (D106, D112): users are `name` + `key`, never an accountId.
//
// Moved out of `api/users.ts` by V3-13 (D518) with no change in
// behaviour; the Cloud module re-exports these names. The Cloud helpers used
// here stay in the Cloud module. UNVERIFIED against a live host, like the
// rest of the adapter (D104, D106).
// ---------------------------------------------------------------------------

import { createJiraError } from '../../core/errors.js';
import type { MentionTarget } from '../adf.js';
import { isRecord } from '../guards.js';
import { budgetOf } from '../shared.js';
import {
  type DataCenterSelf,
  type DataCenterUser,
  type GetMyselfOptions,
  type MentionDirectory,
  MYSELF_PATH,
  type MyselfResult,
  optionalString,
  type ResolveMentionNamesOptions,
  resolveMentionsIn,
  runUserSearch,
  type SearchUsersOptions,
  type SearchUsersResult,
  shapeDataCenterUser,
} from '../users.js';
import { isWikiMentionUsername } from '../wiki-writer.js';
import { responseShapeError } from '../wire.js';

/**
 * `/myself` on Jira Data Center — `GET /rest/api/2/myself` (D106).
 *
 * Not cached, unlike {@link getMyself}: the Data Center adapter serves no write
 * that reads the identity on every call, so there is nothing to amortise. The
 * identity is `name` + `key`; a body with neither is not a Data Center user and
 * is reported as `unexpected_shape` rather than returned half-empty.
 */
export async function getMyselfDataCenter(
  options: GetMyselfOptions,
): Promise<MyselfResult> {
  const response = await options.jira({
    method: 'GET',
    root: 'v2',
    path: MYSELF_PATH,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
  const row = response.data;
  const what = `${MYSELF_PATH} response`;
  if (!isRecord(row)) throw responseShapeError('user', `${what} is not a JSON object`);
  const name =
    typeof row['name'] === 'string' && row['name'] !== '' ? row['name'] : undefined;
  const key =
    typeof row['key'] === 'string' && row['key'] !== '' ? row['key'] : undefined;
  if (name === undefined && key === undefined) {
    throw responseShapeError(
      'user',
      `${what} has neither a string "name" nor a string "key"`,
    );
  }
  const user: DataCenterSelf = {
    ...(name === undefined ? {} : { name }),
    ...(key === undefined ? {} : { key }),
    ...optionalString(row, 'displayName'),
    ...(typeof row['active'] === 'boolean' ? { active: row['active'] } : {}),
    ...optionalString(row, 'emailAddress'),
    ...optionalString(row, 'timeZone'),
    ...optionalString(row, 'locale'),
  };
  return { user, emailHidden: user.emailAddress === undefined };
}

/**
 * The user search on Jira Data Center (D110) — `GET /rest/api/2/user/search`
 * and `GET /rest/api/2/user/assignable/search`. UNVERIFIED, like the rest of
 * the adapter.
 *
 * Same inputs, windows and caps as {@link searchUsers}; three differences:
 *
 *  - the lookup parameter is `username` (it matches the username, the display
 *    name and the email address) — Data Center has no `query` parameter;
 *  - the rows are Data Center users (`name` + `key`, no `accountId`), narrowed
 *    by {@link shapeDataCenterUser}, so no email, avatar or time zone survives;
 *  - `includeEmail: true` is refused before anything is sent, because the
 *    allowlist keeps no email to include.
 */
export async function searchUsersDataCenter(
  options: SearchUsersOptions,
): Promise<SearchUsersResult<DataCenterUser>> {
  if (options.includeEmail === true) {
    throw createJiraError({
      kind: 'validation',
      reason:
        'includeEmail is not available on Jira Data Center in this version of the server: its user rows carry name, key, displayName and active only.',
      remediation: 'Omit includeEmail and identify the user by name.',
    });
  }
  return runUserSearch(options, {
    root: 'v2',
    queryParam: 'username',
    toUser: (row, what) => {
      const user = shapeDataCenterUser(row);
      if (user === undefined) {
        throw responseShapeError(
          'user',
          `${what} is not a Data Center user (a string "displayName" with a "name" or "key", and no "accountId")`,
        );
      }
      return {
        user,
        emailHidden:
          !isRecord(row) ||
          typeof row['emailAddress'] !== 'string' ||
          row['emailAddress'] === '',
      };
    },
  });
}

/**
 * D112 — {@link resolveMentionNames} on Jira Data Center: the same rules, caps
 * and refusals (CC-106, CC-107, CC-112, CC-113), over
 * {@link searchUsersDataCenter} (`GET /rest/api/2/user/search?username=`), and
 * each target's `id` is the user's `name` — the username `[~name]` takes —
 * rather than an accountId. Data Center has no app accounts, so every row is a
 * human candidate. A chosen user with no `name`, or with a name that
 * {@link isWikiMentionUsername} refuses, is a `validation` error: it cannot be
 * mentioned by wiki markup, and a rewritten name would mention someone else
 * (CC-324).
 */
export async function resolveMentionNamesDataCenter(
  options: ResolveMentionNamesOptions,
): Promise<ReadonlyMap<string, MentionTarget>> {
  return resolveMentionsIn(options, DATA_CENTER_DIRECTORY);
}

const DATA_CENTER_DIRECTORY: MentionDirectory<DataCenterUser> = {
  search: (options, name) =>
    searchUsersDataCenter({
      jira: options.jira,
      query: name,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...budgetOf(options),
    }),
  isApp: () => false,
  label: (user) => user.name ?? user.key ?? '(no username)',
  target: (user, name) => {
    const username = user.name;
    if (username === undefined || !isWikiMentionUsername(username)) {
      throw createJiraError({
        kind: 'validation',
        reason:
          username === undefined
            ? `The mention @[${name}] matched a Jira Data Center user with no username, and a wiki mention needs one.`
            : `The mention @[${name}] matched the Jira Data Center user ${JSON.stringify(username)}, whose username cannot be written as a wiki mention safely (only letters, digits and . _ - @ + are).`,
        remediation: 'Write the name as plain text instead of an @[...] mention.',
      });
    }
    return {
      id: username,
      ...(user.displayName === undefined ? {} : { text: `@${user.displayName}` }),
    };
  },
};
