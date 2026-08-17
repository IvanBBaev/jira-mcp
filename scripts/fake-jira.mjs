#!/usr/bin/env node
/**
 * fake-jira — a loopback stand-in for Jira Cloud, for rehearsing Gate C.
 *
 * WHAT THIS IS. `scripts/verify-live.mjs` is the Gate C driver: it spawns the
 * built server and drives 26 named claims through it. Gate C itself — the owner
 * provisioning a scratch Jira site and running the driver against it — is slow,
 * manual and scarce, so every bug the driver still contains costs a round trip.
 * This file lets the driver be rehearsed end to end beforehand, against a server
 * that answers Jira's wire shapes on loopback.
 *
 * WHAT THIS IS NOT. It proves the DRIVER, never Jira. Everything here was
 * written from docs/JIRA-API.md and the response literals in `src/api/*.test.ts`,
 * so at best it proves the driver and the client agree with our reading of the
 * documentation. Where the documentation is exactly what Gate C exists to
 * settle — the bare-string watcher body, the numeric `projectId`, the real
 * `nextPageToken` semantics — a green rehearsal proves nothing at all, and the
 * routes below say so at the point where it matters.
 *
 * DESIGN RULES.
 *   - No dependencies: `node:https` and the standard library only.
 *   - Nothing here is imported by `src/`, and `src/` is not modified to
 *     accommodate it. The server reaches this fake through its ordinary
 *     supported configuration (an allowlisted host in JIRA_ALLOWED_HOSTS),
 *     never through a test-only back door. See docs/ai/gate-c.md.
 *   - TLS, because `core/host.ts` forces `https:` on every site. The
 *     certificate is generated per run into a temp directory and trusted by the
 *     child through NODE_EXTRA_CA_CERTS.
 *   - Stateful: an issue this server creates can afterwards be read, commented
 *     on, watched and deleted, which is what the write and delete phases need.
 *   - Every request is recorded (without credential values) so a rehearsal can
 *     assert on what actually went on the wire — that the media hop carried no
 *     Authorization, that an unsafe write was not replayed.
 *
 * Standalone use, for poking at it by hand:
 *   node scripts/fake-jira.mjs --port 8443
 *   curl --cacert <dir>/fake-jira-cert.pem -u a@b.c:tok https://localhost:8443/...
 */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// TLS material
// ---------------------------------------------------------------------------

/** The names the fake answers to. Neither is on `core/http-util.ts`'s blocklist. */
export const API_HOST = 'jira.rehearsal.test';
export const MEDIA_HOST = 'media.rehearsal.test';

/**
 * Generate (once per directory) a self-signed certificate covering both names.
 *
 * Node can create key pairs but not X.509 certificates, so this shells out to
 * openssl. It is the only external tool the rehearsal needs, and it ships with
 * macOS and every mainstream Linux.
 */
export function ensureCertificate(dir) {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, 'fake-jira-key.pem');
  const certFile = join(dir, 'fake-jira-cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    return {
      keyFile,
      certFile,
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    };
  }

  const configFile = join(dir, 'fake-jira-openssl.cnf');
  writeFileSync(
    configFile,
    [
      '[req]',
      'distinguished_name = dn',
      'x509_extensions = ext',
      'prompt = no',
      '',
      '[dn]',
      `CN = ${API_HOST}`,
      '',
      '[ext]',
      'basicConstraints = critical, CA:TRUE',
      'keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign',
      'extendedKeyUsage = serverAuth',
      `subjectAltName = DNS:${API_HOST}, DNS:${MEDIA_HOST}`,
      '',
    ].join('\n'),
  );

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-config',
        configFile,
      ],
      { stdio: 'pipe' },
    );
  } catch (error) {
    throw new Error(
      'fake-jira: could not generate a TLS certificate with openssl. The ' +
        'rehearsal needs it because core/host.ts forces https: on every site.\n' +
        String(error),
    );
  }
  return { keyFile, certFile, key: readFileSync(keyFile), cert: readFileSync(certFile) };
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SELF_ACCOUNT = '5b10a2844c20165700ede21g';
const OTHER_ACCOUNT = '712020:2f0c1e6d-9a4b-4f1d-8f7a-6d3b0c9a1e22';

function adf(...content) {
  return { type: 'doc', version: 1, content };
}

function paragraph(...content) {
  return { type: 'paragraph', content };
}

function text(value, marks) {
  return marks === undefined
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks };
}

/**
 * A description that exercises the flattener rather than a single paragraph:
 * headings, marks, a link, a mention, an emoji, both list kinds, a code block,
 * a panel, a quote, a rule, a table and a media node.
 */
function richDescription() {
  return adf(
    { type: 'heading', attrs: { level: 2 }, content: [text('Rehearsal sample')] },
    paragraph(
      text('Plain, '),
      text('bold', [{ type: 'strong' }]),
      text(', '),
      text('italic', [{ type: 'em' }]),
      text(', '),
      text('code', [{ type: 'code' }]),
      text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.invalid/spec' } }]),
      text('.'),
    ),
    paragraph(
      { type: 'mention', attrs: { id: OTHER_ACCOUNT, text: '@User Two' } },
      text(' please review '),
      { type: 'emoji', attrs: { shortName: ':thumbsup:', text: '👍' } },
    ),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('first bullet'))] },
        { type: 'listItem', content: [paragraph(text('second bullet'))] },
      ],
    },
    {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [paragraph(text('step one'))] }],
    },
    {
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [text('const answer = 42;')],
    },
    {
      type: 'panel',
      attrs: { panelType: 'warning' },
      content: [paragraph(text('Do not run this against production.'))],
    },
    { type: 'blockquote', content: [paragraph(text('Quoted line.'))] },
    { type: 'rule' },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: {}, content: [paragraph(text('Key'))] },
            { type: 'tableHeader', attrs: {}, content: [paragraph(text('Value'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: {}, content: [paragraph(text('retries'))] },
            { type: 'tableCell', attrs: {}, content: [paragraph(text('3'))] },
          ],
        },
      ],
    },
    {
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [
        {
          type: 'media',
          attrs: {
            id: 'b2c3d4e5-0000-4000-8000-000000000001',
            type: 'file',
            collection: 'rehearsal',
          },
        },
      ],
    },
    paragraph(text('Line one'), { type: 'hardBreak' }, text('line two')),
  );
}

const ATTACHMENT_BYTES = Buffer.from(
  'Gate C rehearsal attachment.\nThis file stands in for a real Jira attachment.\n',
  'utf8',
);

function seedState(config) {
  const users = [
    {
      accountId: SELF_ACCOUNT,
      accountType: 'atlassian',
      displayName: 'User One',
      emailAddress: config.email,
      active: true,
      timeZone: 'UTC',
      locale: 'en_US',
    },
    {
      accountId: OTHER_ACCOUNT,
      accountType: 'atlassian',
      displayName: 'User Two',
      emailAddress: 'user-2@example.invalid',
      active: true,
      timeZone: 'UTC',
      locale: 'en_US',
    },
  ];

  const projects = [
    {
      id: '10000',
      key: config.projectKey,
      name: 'Scratch',
      description: 'Team-managed scratch project for the Gate C rehearsal.',
      projectTypeKey: 'software',
      simplified: true,
      style: 'next-gen',
      isPrivate: false,
      leadAccountId: SELF_ACCOUNT,
    },
    {
      id: '10001',
      key: config.project2Key,
      name: 'Legacy',
      description: 'Company-managed project, for the read comparison.',
      projectTypeKey: 'software',
      simplified: false,
      style: 'classic',
      isPrivate: false,
      leadAccountId: SELF_ACCOUNT,
    },
  ];

  const state = {
    users,
    projects,
    issues: new Map(),
    components: new Map(),
    versions: new Map(),
    boards: [
      {
        id: 1,
        name: 'Scratch board',
        type: 'scrum',
        location: {
          projectId: 10000,
          projectKey: config.projectKey,
          projectName: 'Scratch',
          displayName: `Scratch (${config.projectKey})`,
          projectTypeKey: 'software',
        },
      },
    ],
    sprints: [
      {
        id: 101,
        state: 'active',
        name: 'Rehearsal sprint 1',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-15T00:00:00.000Z',
        originBoardId: 1,
        goal: 'Rehearse Gate C',
      },
    ],
    filters: [
      {
        id: '10000',
        name: 'My open issues',
        description: 'Everything assigned to me that is not done.',
        jql: 'assignee = currentUser() AND statusCategory != Done',
        ownerAccountId: SELF_ACCOUNT,
        favourite: true,
      },
    ],
    attachments: new Map(),
    /** Monotonic id source, so nothing ever collides with the seeded ids. */
    nextId: 20000,
  };

  const created = [
    '2026-08-01T09:00:00.000+0000',
    '2026-08-02T09:00:00.000+0000',
    '2026-08-03T09:00:00.000+0000',
    '2026-08-04T09:00:00.000+0000',
    '2026-08-05T09:00:00.000+0000',
  ];
  // Five issues: C05 pages them two at a time and needs at least three to see a
  // second page that does not overlap the first.
  created.forEach((stamp, index) => {
    const number = index + 1;
    const key = `${config.projectKey}-${String(number)}`;
    const issue = {
      id: String(10100 + number),
      key,
      projectKey: config.projectKey,
      created: stamp,
      updated: stamp,
      summary: `Rehearsal issue ${String(number)}`,
      description:
        index === 0 ? richDescription() : adf(paragraph(text('Nothing special.'))),
      issueType: { id: '10001', name: 'Task', subtask: false, hierarchyLevel: 0 },
      status: {
        id: '3',
        name: 'In Progress',
        statusCategory: { id: 4, key: 'indeterminate', name: 'In Progress' },
      },
      priority: { id: '3', name: 'Medium' },
      assigneeAccountId: index % 2 === 0 ? SELF_ACCOUNT : OTHER_ACCOUNT,
      reporterAccountId: SELF_ACCOUNT,
      labels: index === 0 ? ['rehearsal'] : [],
      comments: [],
      worklogs: [],
      changelog: [
        {
          id: String(30000 + number),
          authorAccountId: SELF_ACCOUNT,
          created: stamp,
          items: [
            {
              field: 'status',
              fieldtype: 'jira',
              from: '1',
              fromString: 'To Do',
              to: '3',
              toString: 'In Progress',
            },
          ],
        },
      ],
      attachmentIds: [],
      watchers: [SELF_ACCOUNT],
      votes: [],
      sprintId: number <= 2 ? 101 : undefined,
      deleted: false,
    };
    if (index === 0) {
      issue.comments.push({
        id: '50001',
        authorAccountId: SELF_ACCOUNT,
        body: adf(paragraph(text('A seeded comment, so the read claim sees one.'))),
        created: stamp,
        updated: stamp,
        jsdPublic: true,
      });
      issue.worklogs.push({
        id: '40001',
        issueId: issue.id,
        authorAccountId: SELF_ACCOUNT,
        comment: adf(paragraph(text('Seeded work.'))),
        created: stamp,
        updated: stamp,
        started: stamp,
        timeSpent: '1h',
        timeSpentSeconds: 3600,
      });
      // C13 needs an attachment on the sample issue.
      const attachment = {
        id: '60001',
        filename: 'rehearsal-sample.txt',
        authorAccountId: SELF_ACCOUNT,
        created: stamp,
        size: ATTACHMENT_BYTES.length,
        mimeType: 'text/plain',
        bytes: ATTACHMENT_BYTES,
      };
      state.attachments.set(attachment.id, attachment);
      issue.attachmentIds.push(attachment.id);
    }
    state.issues.set(key, issue);
  });

  state.components.set('10200', {
    id: '10200',
    name: 'api',
    description: 'API surface',
    projectKey: config.projectKey,
  });
  state.versions.set('10300', {
    id: '10300',
    name: '1.0',
    description: 'First release',
    projectId: 10000,
    released: true,
    archived: false,
    releaseDate: '2026-01-15',
  });

  return state;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(status, body, headers = {}) {
  return { status, json: body, headers };
}

function noContent() {
  return { status: 204 };
}

/** Jira's standard error envelope. */
function jiraError(status, errorMessages, errors = {}) {
  return json(status, { errorMessages, errors });
}

function notFound(what) {
  return jiraError(404, [
    `${what} does not exist or you do not have permission to see it.`,
  ]);
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

function parseBasicAuth(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Pull the parts out of a multipart/form-data body.
 *
 * Deliberately minimal — enough to see the field name, the filename and the
 * bytes, which is all the upload claim is about.
 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (match === null) return [];
  const boundary = `--${match[1] ?? match[2]}`.trim();
  const parts = [];
  let index = buffer.indexOf(boundary);
  while (index >= 0) {
    const start = index + boundary.length;
    if (buffer.slice(start, start + 2).toString('latin1') === '--') break;
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const rawHeaders = buffer.slice(start, headerEnd).toString('utf8');
    const next = buffer.indexOf(boundary, headerEnd);
    if (next < 0) break;
    // The bytes end two characters before the next boundary marker (\r\n).
    const bytes = buffer.slice(headerEnd + 4, next - 2);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(rawHeaders)?.[1] ?? '';
    parts.push({
      field: /name="([^"]*)"/i.exec(disposition)?.[1],
      filename: /filename="([^"]*)"/i.exec(disposition)?.[1],
      contentType: /content-type:\s*([^\r\n]*)/i.exec(rawHeaders)?.[1]?.trim(),
      bytes,
    });
    index = next;
  }
  return parts;
}

/** `project = ABC ORDER BY created ASC` → `ABC`. Deliberately crude. */
function projectFromJql(jql) {
  const match = /\bproject\s*=\s*"?([A-Za-z][A-Za-z0-9_]*)"?/i.exec(String(jql ?? ''));
  return match?.[1];
}

function encodeToken(offset) {
  return Buffer.from(`rehearsal:${String(offset)}`, 'utf8').toString('base64url');
}

function decodeToken(token) {
  const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
  const match = /^rehearsal:(\d+)$/.exec(decoded);
  return match === null ? undefined : Number(match[1]);
}

// ---------------------------------------------------------------------------
// Wire projections — the raw JSON Jira would send
// ---------------------------------------------------------------------------

function wireUser(state, accountId, origin) {
  const user = state.users.find((candidate) => candidate.accountId === accountId);
  if (user === undefined) return undefined;
  return {
    self: `${origin}/rest/api/3/user?accountId=${encodeURIComponent(user.accountId)}`,
    accountId: user.accountId,
    accountType: user.accountType,
    emailAddress: user.emailAddress,
    avatarUrls: { '48x48': `${origin}/secure/useravatar?size=large` },
    displayName: user.displayName,
    active: user.active,
    timeZone: user.timeZone,
    locale: user.locale,
  };
}

function wireProject(state, project, origin, expand) {
  const body = {
    self: `${origin}/rest/api/3/project/${project.id}`,
    id: project.id,
    key: project.key,
    name: project.name,
    projectTypeKey: project.projectTypeKey,
    simplified: project.simplified,
    style: project.style,
    isPrivate: project.isPrivate,
    avatarUrls: { '48x48': `${origin}/secure/projectavatar?pid=${project.id}` },
  };
  const wants = (name) => expand === undefined || expand.includes(name);
  if (wants('description')) body.description = project.description;
  if (wants('lead')) body.lead = wireUser(state, project.leadAccountId, origin);
  if (wants('issueTypes')) {
    body.issueTypes = [
      {
        self: `${origin}/rest/api/3/issuetype/10001`,
        id: '10001',
        name: 'Task',
        description: 'A small, distinct piece of work.',
        subtask: false,
        hierarchyLevel: 0,
      },
      {
        self: `${origin}/rest/api/3/issuetype/10003`,
        id: '10003',
        name: 'Sub-task',
        description: 'A small piece of a larger task.',
        subtask: true,
        hierarchyLevel: -1,
      },
    ];
  }
  body.components = [...state.components.values()]
    .filter((component) => component.projectKey === project.key)
    .map((component) => wireComponent(component, origin));
  body.versions = [...state.versions.values()]
    .filter((version) => String(version.projectId) === project.id)
    .map((version) => wireVersion(version, origin));
  return body;
}

function wireComponent(component, origin) {
  return {
    self: `${origin}/rest/api/3/component/${component.id}`,
    id: component.id,
    name: component.name,
    description: component.description,
    project: component.projectKey,
    isAssigneeTypeValid: false,
  };
}

function wireVersion(version, origin) {
  const body = {
    self: `${origin}/rest/api/3/version/${version.id}`,
    id: version.id,
    name: version.name,
    archived: version.archived,
    released: version.released,
    projectId: version.projectId,
  };
  if (version.description !== undefined) body.description = version.description;
  if (version.startDate !== undefined) body.startDate = version.startDate;
  if (version.releaseDate !== undefined) body.releaseDate = version.releaseDate;
  return body;
}

function wireAttachment(state, attachment, origin) {
  return {
    self: `${origin}/rest/api/3/attachment/${attachment.id}`,
    id: attachment.id,
    filename: attachment.filename,
    author: wireUser(state, attachment.authorAccountId, origin),
    created: attachment.created,
    size: attachment.size,
    mimeType: attachment.mimeType,
    content: `${origin}/rest/api/3/attachment/content/${attachment.id}`,
  };
}

function wireComment(state, issue, comment, origin) {
  return {
    self: `${origin}/rest/api/3/issue/${issue.id}/comment/${comment.id}`,
    id: comment.id,
    author: wireUser(state, comment.authorAccountId, origin),
    body: comment.body,
    updateAuthor: wireUser(state, comment.authorAccountId, origin),
    created: comment.created,
    updated: comment.updated,
    jsdPublic: comment.jsdPublic ?? true,
  };
}

function wireWorklog(state, issue, worklog, origin) {
  const body = {
    self: `${origin}/rest/api/3/issue/${issue.id}/worklog/${worklog.id}`,
    id: worklog.id,
    issueId: issue.id,
    author: wireUser(state, worklog.authorAccountId, origin),
    created: worklog.created,
    updated: worklog.updated,
    started: worklog.started,
    timeSpent: worklog.timeSpent,
    timeSpentSeconds: worklog.timeSpentSeconds,
  };
  if (worklog.comment !== undefined) body.comment = worklog.comment;
  return body;
}

/** The `fields` bag, honouring the `fields` query the client sent. */
function wireIssueFields(state, issue, origin, requested) {
  const all = {
    summary: issue.summary,
    description: issue.description,
    issuetype: {
      id: issue.issueType.id,
      name: issue.issueType.name,
      subtask: issue.issueType.subtask,
    },
    status: issue.status,
    priority: issue.priority,
    assignee: wireUser(state, issue.assigneeAccountId, origin),
    reporter: wireUser(state, issue.reporterAccountId, origin),
    created: issue.created,
    updated: issue.updated,
    labels: issue.labels,
    project: {
      id: state.projects.find((project) => project.key === issue.projectKey)?.id,
      key: issue.projectKey,
    },
    attachment: issue.attachmentIds.map((id) =>
      wireAttachment(state, state.attachments.get(id), origin),
    ),
    issuelinks: [],
    fixVersions: [],
    components: [],
    worklog: {
      startAt: 0,
      maxResults: 20,
      total: issue.worklogs.length,
      worklogs: issue.worklogs.map((worklog) =>
        wireWorklog(state, issue, worklog, origin),
      ),
    },
  };
  if (requested === undefined || requested.includes('*all')) return all;
  const bag = {};
  for (const name of requested) {
    if (name === '*navigable') continue;
    if (Object.hasOwn(all, name)) bag[name] = all[name];
  }
  return bag;
}

function wireIssue(state, issue, origin, options = {}) {
  const body = {
    id: issue.id,
    key: issue.key,
    self: `${origin}/rest/api/3/issue/${issue.id}`,
    fields: wireIssueFields(state, issue, origin, options.fields),
  };
  if (options.expand?.includes('changelog') === true) {
    body.changelog = {
      startAt: 0,
      maxResults: issue.changelog.length,
      total: issue.changelog.length,
      histories: issue.changelog.map((entry) => wireChangelogEntry(state, entry, origin)),
    };
  }
  if (options.expand?.includes('renderedFields') === true) {
    body.renderedFields = { description: '<p>rendered</p>' };
  }
  return body;
}

function wireChangelogEntry(state, entry, origin) {
  return {
    id: entry.id,
    author: wireUser(state, entry.authorAccountId, origin),
    created: entry.created,
    items: entry.items,
  };
}

// ---------------------------------------------------------------------------
// Static metadata
// ---------------------------------------------------------------------------

function wireFields() {
  return [
    {
      id: 'summary',
      key: 'summary',
      name: 'Summary',
      custom: false,
      orderable: true,
      navigable: true,
      searchable: true,
      clauseNames: ['summary'],
      schema: { type: 'string', system: 'summary' },
    },
    {
      id: 'description',
      key: 'description',
      name: 'Description',
      custom: false,
      orderable: true,
      navigable: false,
      searchable: true,
      clauseNames: ['description'],
      schema: { type: 'doc', system: 'description' },
    },
    {
      id: 'customfield_10016',
      key: 'customfield_10016',
      name: 'Story Points',
      untranslatedName: 'Story Points',
      custom: true,
      orderable: true,
      navigable: true,
      searchable: true,
      clauseNames: ['cf[10016]', 'Story Points'],
      schema: {
        type: 'number',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
        customId: 10016,
      },
    },
    {
      // A duplicate display name on purpose: resolving "Story Points" to one id
      // is ambiguous on a real site too, and the tools are expected to say so.
      id: 'customfield_10038',
      key: 'customfield_10038',
      name: 'Story Points',
      custom: true,
      orderable: true,
      navigable: true,
      searchable: true,
      clauseNames: ['cf[10038]', 'Story Points'],
      schema: {
        type: 'number',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
        customId: 10038,
      },
    },
  ];
}

function wireCreateMetaFields(origin, projectKey) {
  return [
    {
      required: true,
      schema: { type: 'string', system: 'summary' },
      name: 'Summary',
      key: 'summary',
      fieldId: 'summary',
      hasDefaultValue: false,
      operations: ['set'],
    },
    {
      required: true,
      schema: { type: 'issuetype', system: 'issuetype' },
      name: 'Issue Type',
      key: 'issuetype',
      fieldId: 'issuetype',
      hasDefaultValue: false,
      operations: [],
      allowedValues: [
        {
          self: `${origin}/rest/api/3/issuetype/10001`,
          id: '10001',
          name: 'Task',
          subtask: false,
        },
      ],
    },
    {
      required: false,
      schema: { type: 'user', system: 'assignee' },
      name: 'Assignee',
      key: 'assignee',
      fieldId: 'assignee',
      hasDefaultValue: false,
      operations: ['set'],
      autoCompleteUrl: `${origin}/rest/api/3/user/assignable/search?project=${projectKey}&query=`,
    },
    {
      required: false,
      schema: {
        type: 'number',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
        customId: 10016,
      },
      name: 'Story Points',
      key: 'customfield_10016',
      fieldId: 'customfield_10016',
      hasDefaultValue: false,
      operations: ['set'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Match `/rest/api/3/issue/{key}/comment/{id}` style patterns. */
function matchPath(pattern, pathname) {
  const wanted = pattern.split('/');
  const actual = pathname.split('/');
  if (wanted.length !== actual.length) return undefined;
  const params = {};
  for (let index = 0; index < wanted.length; index += 1) {
    const segment = wanted[index];
    if (segment.startsWith('{') && segment.endsWith('}')) {
      params[segment.slice(1, -1)] = decodeURIComponent(actual[index]);
      continue;
    }
    if (segment !== actual[index]) return undefined;
  }
  return params;
}

/**
 * The whole route table. Each entry is `[method, path, handler]`; the handler
 * receives the request context and returns a response descriptor.
 */
function buildRoutes(server) {
  const { state, config } = server;
  const origin = () => server.origin;
  const findIssue = (wanted) => {
    const byKey = state.issues.get(wanted);
    if (byKey !== undefined && !byKey.deleted) return byKey;
    for (const issue of state.issues.values()) {
      if (issue.id === wanted && !issue.deleted) return issue;
    }
    return undefined;
  };
  const issueOf = (params) => findIssue(params.issueIdOrKey);
  const nextId = () => String((state.nextId += 1));
  /** Jira stamps its timestamps `+0000`, never `Z`. */
  const now = () => new Date().toISOString().replace('Z', '+0000');

  /** Classic PageBean over an array, honouring startAt/maxResults. */
  const page = (rows, query, key = 'values') => {
    const startAt = Number(query.startAt ?? 0);
    const maxResults = Math.min(Number(query.maxResults ?? 50), 100);
    const slice = rows.slice(startAt, startAt + maxResults);
    return {
      self: `${origin()}/rest/api/3`,
      startAt,
      maxResults,
      total: rows.length,
      isLast: startAt + slice.length >= rows.length,
      [key]: slice,
    };
  };

  /**
   * The Agile API's page envelope. Deliberately NOT the classic one: it omits
   * `self` and `total`, so a client that leans on `total` to stop paging would
   * loop here exactly as it would on a real board.
   */
  const agilePage = (rows, query, key = 'values') => {
    const startAt = Number(query.startAt ?? 0);
    const maxResults = Math.min(Number(query.maxResults ?? 50), 50);
    const slice = rows.slice(startAt, startAt + maxResults);
    return {
      startAt,
      maxResults,
      isLast: startAt + slice.length >= rows.length,
      [key]: slice,
    };
  };

  return [
    // -- identity ---------------------------------------------------------
    [
      'GET',
      '/rest/api/3/myself',
      () => json(200, wireUser(state, SELF_ACCOUNT, origin())),
    ],

    [
      'GET',
      '/rest/api/3/serverInfo',
      () =>
        json(200, {
          baseUrl: origin(),
          version: '1001.0.0-SNAPSHOT',
          deploymentType: 'Cloud',
          serverTitle: 'Jira (fake)',
        }),
    ],

    // -- users ------------------------------------------------------------
    [
      'GET',
      '/rest/api/3/user/search',
      (ctx) => {
        const query = String(ctx.query.query ?? '').toLowerCase();
        const rows = state.users.filter(
          (user) =>
            query === '' ||
            user.displayName.toLowerCase().includes(query) ||
            (user.emailAddress ?? '').toLowerCase().includes(query),
        );
        return json(
          200,
          rows.map((user) => wireUser(state, user.accountId, origin())),
        );
      },
    ],

    [
      'GET',
      '/rest/api/3/user/assignable/search',
      (ctx) => {
        const project = ctx.query.project;
        if (project !== undefined && !state.projects.some((row) => row.key === project)) {
          return jiraError(404, ['Project not found.']);
        }
        return json(
          200,
          state.users.map((user) => wireUser(state, user.accountId, origin())),
        );
      },
    ],

    // -- projects and metadata --------------------------------------------
    [
      'GET',
      '/rest/api/3/project/search',
      (ctx) => {
        const expand = String(ctx.query.expand ?? '')
          .split(',')
          .filter(Boolean);
        const rows = state.projects.map((project) =>
          wireProject(state, project, origin(), expand),
        );
        return json(200, page(rows, ctx.query));
      },
    ],

    [
      'GET',
      '/rest/api/3/project/{projectIdOrKey}',
      (ctx) => {
        const wanted = ctx.params.projectIdOrKey;
        const project = state.projects.find(
          (row) => row.key === wanted || row.id === wanted,
        );
        if (project === undefined) return notFound('Project');
        const expand =
          ctx.query.expand === undefined
            ? undefined
            : String(ctx.query.expand).split(',');
        return json(200, wireProject(state, project, origin(), expand));
      },
    ],

    [
      'GET',
      '/rest/api/3/project/{projectIdOrKey}/role',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        // Jira answers with a MAP of role name to role URL, not a list — the
        // role id exists only as the last path segment of that URL.
        return json(200, {
          Administrators: `${origin()}/rest/api/3/project/${project.id}/role/10002`,
          Developers: `${origin()}/rest/api/3/project/${project.id}/role/10001`,
        });
      },
    ],

    [
      'GET',
      '/rest/api/3/project/{projectIdOrKey}/role/{roleId}',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        const names = { 10001: 'Developers', 10002: 'Administrators' };
        const name = names[ctx.params.roleId];
        if (name === undefined) return notFound('Project role');
        return json(200, {
          self: `${origin()}/rest/api/3/project/${project.key}/role/${ctx.params.roleId}`,
          name,
          // A number here, a string on the search rows — Jira really is
          // inconsistent about this one.
          id: Number(ctx.params.roleId),
          description: `A project role that represents ${name.toLowerCase()}.`,
          actors: [
            {
              id: 10240,
              displayName: 'User One',
              type: 'atlassian-user-role-actor',
              actorUser: { accountId: SELF_ACCOUNT },
              avatarUrl: `${origin()}/secure/useravatar?size=xsmall`,
            },
            {
              id: 10241,
              displayName: 'jira-administrators',
              type: 'atlassian-group-role-actor',
              name: 'jira-administrators',
              actorGroup: {
                name: 'jira-administrators',
                groupId: '952d12c3-5b5b-4d04-bb32-44d383afc4b2',
              },
            },
          ],
          scope: { type: 'PROJECT', project: { id: project.id } },
        });
      },
    ],

    ['GET', '/rest/api/3/field', () => json(200, wireFields())],

    [
      'GET',
      '/rest/api/3/issueLinkType',
      () =>
        json(200, {
          issueLinkTypes: [
            {
              id: '10000',
              name: 'Blocks',
              inward: 'is blocked by',
              outward: 'blocks',
              self: `${origin()}/rest/api/3/issueLinkType/10000`,
            },
            {
              id: '10001',
              name: 'Relates',
              inward: 'relates to',
              outward: 'relates to',
              self: `${origin()}/rest/api/3/issueLinkType/10001`,
            },
          ],
        }),
    ],

    [
      'GET',
      '/rest/api/3/statuses/search',
      (ctx) =>
        json(
          200,
          page(
            [
              {
                id: '10000',
                name: 'To Do',
                statusCategory: 'TODO',
                scope: { type: 'GLOBAL' },
                description: '',
                usages: [],
              },
              {
                id: '3',
                name: 'In Progress',
                description: 'This issue is being actively worked on.',
                statusCategory: 'IN_PROGRESS',
                scope: { type: 'GLOBAL' },
                usages: [],
              },
            ],
            ctx.query,
          ),
        ),
    ],

    [
      'GET',
      '/rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        const rows = [
          {
            self: `${origin()}/rest/api/3/issuetype/10001`,
            id: '10001',
            description: 'A small, distinct piece of work.',
            name: 'Task',
            untranslatedName: 'Task',
            subtask: false,
            hierarchyLevel: 0,
          },
          {
            self: `${origin()}/rest/api/3/issuetype/10003`,
            id: '10003',
            description: 'A small piece of a larger task.',
            name: 'Sub-task',
            subtask: true,
            hierarchyLevel: -1,
          },
        ];
        const startAt = Number(ctx.query.startAt ?? 0);
        const maxResults = Number(ctx.query.maxResults ?? 50);
        return json(200, {
          startAt,
          maxResults,
          total: rows.length,
          issueTypes: rows.slice(startAt, startAt + maxResults),
        });
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        const rows = wireCreateMetaFields(origin(), project.key);
        const startAt = Number(ctx.query.startAt ?? 0);
        const maxResults = Number(ctx.query.maxResults ?? 50);
        return json(200, {
          startAt,
          maxResults,
          total: rows.length,
          fields: rows.slice(startAt, startAt + maxResults),
        });
      },
    ],

    // -- search -----------------------------------------------------------
    [
      'POST',
      '/rest/api/3/search/jql',
      (ctx) => {
        const body = ctx.body ?? {};
        const projectKey = projectFromJql(body.jql);
        if (typeof body.jql === 'string' && /\bNOT_A_FIELD\b/.test(body.jql)) {
          return jiraError(400, [
            "Error in the JQL Query: Field 'NOT_A_FIELD' does not exist or you do not have permission to view it.",
          ]);
        }
        const rows = [...state.issues.values()]
          .filter((issue) => !issue.deleted)
          .filter((issue) => projectKey === undefined || issue.projectKey === projectKey)
          .sort((left, right) => left.created.localeCompare(right.created));

        let offset = 0;
        if (body.nextPageToken !== undefined) {
          const decoded = decodeToken(body.nextPageToken);
          if (decoded === undefined) {
            // The shape Jira uses for a cursor it no longer recognises (CC-05).
            return jiraError(400, ['The provided nextPageToken is invalid or expired']);
          }
          offset = decoded;
        }
        const maxResults = Math.min(Number(body.maxResults ?? 50), 100);
        const slice = rows.slice(offset, offset + maxResults);
        const fields = Array.isArray(body.fields) ? body.fields.map(String) : undefined;
        const expand =
          typeof body.expand === 'string' ? body.expand.split(',') : undefined;
        const response = {
          issues: slice.map((issue) =>
            wireIssue(state, issue, origin(), { fields, expand }),
          ),
        };
        if (offset + slice.length < rows.length) {
          response.nextPageToken = encodeToken(offset + slice.length);
        } else {
          // No `total`, no `startAt` — the new search endpoint reports neither.
          response.isLast = true;
        }
        return json(200, response);
      },
    ],

    [
      'POST',
      '/rest/api/3/search/approximate-count',
      (ctx) => {
        const projectKey = projectFromJql(ctx.body?.jql);
        const count = [...state.issues.values()].filter(
          (issue) =>
            !issue.deleted &&
            (projectKey === undefined || issue.projectKey === projectKey),
        ).length;
        return json(200, { count });
      },
    ],

    // -- issue reads ------------------------------------------------------
    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const fields =
          ctx.query.fields === undefined
            ? undefined
            : String(ctx.query.fields).split(',');
        const expand =
          ctx.query.expand === undefined
            ? undefined
            : String(ctx.query.expand).split(',');
        return json(200, wireIssue(state, issue, origin(), { fields, expand }));
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/comment',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const rows = issue.comments.map((comment) =>
          wireComment(state, issue, comment, origin()),
        );
        const body = page(rows, ctx.query, 'comments');
        delete body.self;
        delete body.isLast;
        return json(200, body);
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/worklog',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const rows = issue.worklogs.map((worklog) =>
          wireWorklog(state, issue, worklog, origin()),
        );
        const body = page(rows, ctx.query, 'worklogs');
        delete body.self;
        delete body.isLast;
        return json(200, body);
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/changelog',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const rows = issue.changelog.map((entry) =>
          wireChangelogEntry(state, entry, origin()),
        );
        const body = page(rows, ctx.query);
        delete body.self;
        return json(200, body);
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/transitions',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        return json(200, {
          expand: 'transitions',
          transitions: [
            {
              id: '11',
              name: 'To Do',
              to: {
                id: '1',
                name: 'To Do',
                statusCategory: { key: 'new', name: 'To Do' },
              },
              hasScreen: false,
              isAvailable: true,
              isGlobal: true,
              isInitial: false,
              isConditional: false,
              looped: false,
            },
            {
              id: '31',
              name: 'Done',
              to: {
                id: '3',
                name: 'Done',
                statusCategory: { key: 'done', name: 'Done' },
              },
              hasScreen: true,
              isAvailable: true,
              fields: { resolution: { required: true, name: 'Resolution' } },
            },
          ],
        });
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/comment/{id}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const comment = issue.comments.find((row) => row.id === ctx.params.id);
        if (comment === undefined) return notFound('Comment');
        return json(200, wireComment(state, issue, comment, origin()));
      },
    ],

    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/worklog/{id}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const worklog = issue.worklogs.find((row) => row.id === ctx.params.id);
        if (worklog === undefined) return notFound('Worklog');
        return json(200, wireWorklog(state, issue, worklog, origin()));
      },
    ],

    // -- issue writes -----------------------------------------------------
    [
      'POST',
      '/rest/api/3/issue',
      (ctx) => {
        const fields = ctx.body?.fields;
        if (fields === undefined || typeof fields !== 'object') {
          return jiraError(400, [], { fields: 'Field "fields" is required.' });
        }
        const projectRef = fields.project ?? {};
        const project = state.projects.find(
          (row) => row.key === projectRef.key || row.id === String(projectRef.id ?? ''),
        );
        if (project === undefined) {
          return jiraError(400, [], { project: 'project is required' });
        }
        const number = [...state.issues.values()].filter(
          (issue) => issue.projectKey === project.key,
        ).length;
        const key = `${project.key}-${String(number + 1)}`;
        const stamp = now();
        const issue = {
          id: nextId(),
          key,
          projectKey: project.key,
          created: stamp,
          updated: stamp,
          summary: fields.summary ?? '',
          description: fields.description,
          issueType: {
            id: '10001',
            name: fields.issuetype?.name ?? 'Task',
            subtask: false,
            hierarchyLevel: 0,
          },
          status: {
            id: '1',
            name: 'To Do',
            statusCategory: { id: 2, key: 'new', name: 'To Do' },
          },
          priority: { id: '3', name: 'Medium' },
          assigneeAccountId: fields.assignee?.accountId,
          reporterAccountId: SELF_ACCOUNT,
          labels: Array.isArray(fields.labels) ? fields.labels : [],
          comments: [],
          worklogs: [],
          changelog: [],
          attachmentIds: [],
          watchers: [SELF_ACCOUNT],
          votes: [],
          deleted: false,
        };
        state.issues.set(key, issue);
        return json(201, {
          id: issue.id,
          key: issue.key,
          self: `${origin()}/rest/api/3/issue/${issue.id}`,
        });
      },
    ],

    [
      'PUT',
      '/rest/api/3/issue/{issueIdOrKey}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const fields = ctx.body?.fields ?? {};
        if (Object.hasOwn(fields, 'summary')) issue.summary = fields.summary;
        if (Object.hasOwn(fields, 'description')) issue.description = fields.description;
        if (Object.hasOwn(fields, 'labels')) issue.labels = fields.labels ?? [];
        const update = ctx.body?.update ?? {};
        for (const operation of update.labels ?? []) {
          if (operation.add !== undefined)
            issue.labels = [...issue.labels, operation.add];
          if (operation.remove !== undefined) {
            issue.labels = issue.labels.filter((label) => label !== operation.remove);
          }
        }
        issue.updated = now();
        return noContent();
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/transitions',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const id = ctx.body?.transition?.id;
        if (id !== '11' && id !== '31') {
          return jiraError(400, [
            `Transition id ${String(id)} is not valid for issue ${issue.key}.`,
          ]);
        }
        issue.status =
          id === '31'
            ? {
                id: '3',
                name: 'Done',
                statusCategory: { id: 3, key: 'done', name: 'Done' },
              }
            : {
                id: '1',
                name: 'To Do',
                statusCategory: { id: 2, key: 'new', name: 'To Do' },
              };
        issue.updated = now();
        return noContent();
      },
    ],

    [
      'PUT',
      '/rest/api/3/issue/{issueIdOrKey}/assignee',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        if (!Object.hasOwn(ctx.body ?? {}, 'accountId')) {
          return jiraError(400, [], { accountId: 'accountId is required' });
        }
        issue.assigneeAccountId = ctx.body.accountId ?? undefined;
        issue.updated = now();
        return noContent();
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/comment',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const stamp = now();
        const comment = {
          id: nextId(),
          authorAccountId: SELF_ACCOUNT,
          body: ctx.body?.body,
          created: stamp,
          updated: stamp,
          jsdPublic: true,
        };
        issue.comments.push(comment);
        return json(201, wireComment(state, issue, comment, origin()));
      },
    ],

    [
      'PUT',
      '/rest/api/3/issue/{issueIdOrKey}/comment/{id}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const comment = issue.comments.find((row) => row.id === ctx.params.id);
        if (comment === undefined) return notFound('Comment');
        comment.body = ctx.body?.body ?? comment.body;
        comment.updated = now();
        return json(200, wireComment(state, issue, comment, origin()));
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/worklog',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const started = ctx.body?.started;
        // Jira rejects a `Z` offset on this field; the client is expected never
        // to send one (CC-23), and the fake holds it to that.
        if (typeof started === 'string' && started.endsWith('Z')) {
          return jiraError(400, [], {
            started:
              'Date value ' +
              started +
              ' is invalid. The format must be yyyy-MM-ddTHH:mm:ss.SSSZZ.',
          });
        }
        const stamp = now();
        const worklog = {
          id: nextId(),
          issueId: issue.id,
          authorAccountId: SELF_ACCOUNT,
          comment: ctx.body?.comment,
          created: stamp,
          updated: stamp,
          started: started ?? stamp,
          timeSpent: ctx.body?.timeSpent ?? '1m',
          timeSpentSeconds: ctx.body?.timeSpentSeconds ?? 60,
        };
        issue.worklogs.push(worklog);
        return json(201, wireWorklog(state, issue, worklog, origin()));
      },
    ],

    ['POST', '/rest/api/3/issueLink', () => ({ status: 201 })],

    [
      'DELETE',
      '/rest/api/3/issue/{issueIdOrKey}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        issue.deleted = true;
        return noContent();
      },
    ],

    [
      'DELETE',
      '/rest/api/3/issue/{issueIdOrKey}/comment/{id}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const index = issue.comments.findIndex((row) => row.id === ctx.params.id);
        if (index < 0) return notFound('Comment');
        issue.comments.splice(index, 1);
        return noContent();
      },
    ],

    [
      'DELETE',
      '/rest/api/3/issue/{issueIdOrKey}/worklog/{id}',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const index = issue.worklogs.findIndex((row) => row.id === ctx.params.id);
        if (index < 0) return notFound('Worklog');
        issue.worklogs.splice(index, 1);
        return noContent();
      },
    ],

    // -- watchers and votes ------------------------------------------------
    [
      'GET',
      '/rest/api/3/issue/{issueIdOrKey}/watchers',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const body = {
          self: `${origin()}/rest/api/3/issue/${issue.id}/watchers`,
          isWatching: issue.watchers.includes(SELF_ACCOUNT),
          watchCount: issue.watchers.length,
        };
        // CC-47: without "View voters and watchers" Jira answers 200 with the
        // roster ABSENT rather than 403. `config.hideWatcherRoster` reproduces it.
        if (!config.hideWatcherRoster) {
          body.watchers = issue.watchers.map((accountId) =>
            wireUser(state, accountId, origin()),
          );
        }
        return json(200, body);
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/watchers',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        // THE CLAIM THIS CANNOT SETTLE (C14/C21). docs/JIRA-API.md says Jira
        // wants a BARE JSON STRING here, not `{"accountId": "..."}`. This fake
        // enforces that reading — but a fake agreeing with our documentation is
        // not evidence that Jira does. Only Gate C can settle it.
        if (typeof ctx.body !== 'string') {
          return jiraError(400, [
            'The request body must be the accountId as a bare JSON string.',
          ]);
        }
        if (!issue.watchers.includes(ctx.body)) issue.watchers.push(ctx.body);
        return noContent();
      },
    ],

    [
      'DELETE',
      '/rest/api/3/issue/{issueIdOrKey}/watchers',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        const accountId = ctx.query.accountId;
        if (accountId === undefined) {
          return jiraError(400, ['The accountId query parameter is required.']);
        }
        issue.watchers = issue.watchers.filter((row) => row !== accountId);
        return noContent();
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/votes',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        if (!issue.votes.includes(SELF_ACCOUNT)) issue.votes.push(SELF_ACCOUNT);
        return noContent();
      },
    ],

    [
      'DELETE',
      '/rest/api/3/issue/{issueIdOrKey}/votes',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        issue.votes = issue.votes.filter((row) => row !== SELF_ACCOUNT);
        return noContent();
      },
    ],

    // -- components and versions -------------------------------------------
    [
      'GET',
      '/rest/api/3/project/{projectIdOrKey}/component',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        const rows = [...state.components.values()]
          .filter((component) => component.projectKey === project.key)
          .map((component) => wireComponent(component, origin()));
        return json(200, page(rows, ctx.query));
      },
    ],

    [
      'GET',
      '/rest/api/3/project/{projectIdOrKey}/version',
      (ctx) => {
        const project = state.projects.find(
          (row) =>
            row.key === ctx.params.projectIdOrKey || row.id === ctx.params.projectIdOrKey,
        );
        if (project === undefined) return notFound('Project');
        const rows = [...state.versions.values()]
          .filter((version) => String(version.projectId) === project.id)
          .map((version) => wireVersion(version, origin()));
        return json(200, page(rows, ctx.query));
      },
    ],

    [
      'POST',
      '/rest/api/3/component',
      (ctx) => {
        const body = ctx.body ?? {};
        // Components take the project by KEY, versions by numeric id — the
        // asymmetry is Jira's, and it is exactly what C15/C22 are about.
        if (typeof body.project !== 'string') {
          return jiraError(400, [], {
            project: 'project is required and must be a project key',
          });
        }
        const project = state.projects.find((row) => row.key === body.project);
        if (project === undefined)
          return jiraError(400, [], { project: 'No project could be found.' });
        const component = {
          id: nextId(),
          name: body.name,
          description: body.description,
          projectKey: project.key,
        };
        state.components.set(component.id, component);
        return json(201, wireComponent(component, origin()));
      },
    ],

    [
      'PUT',
      '/rest/api/3/component/{id}',
      (ctx) => {
        const component = state.components.get(ctx.params.id);
        if (component === undefined) return notFound('Component');
        const body = ctx.body ?? {};
        if (Object.hasOwn(body, 'name')) component.name = body.name;
        if (Object.hasOwn(body, 'description')) component.description = body.description;
        return json(200, wireComponent(component, origin()));
      },
    ],

    [
      'POST',
      '/rest/api/3/version',
      (ctx) => {
        const body = ctx.body ?? {};
        // THE OTHER CLAIM THIS CANNOT SETTLE (C15/C22). docs/JIRA-API.md says
        // `projectId` must be a NUMBER here. The fake enforces that reading, and
        // that agreement is not evidence — Gate C is.
        if (typeof body.projectId !== 'number') {
          return jiraError(400, [], {
            projectId: 'projectId must be a number, not a string.',
          });
        }
        const project = state.projects.find((row) => row.id === String(body.projectId));
        if (project === undefined) {
          return jiraError(404, [
            'Project does not exist or you do not have permission to see it.',
          ]);
        }
        const version = {
          id: nextId(),
          name: body.name,
          description: body.description,
          projectId: body.projectId,
          released: body.released ?? false,
          archived: body.archived ?? false,
          startDate: body.startDate,
          releaseDate: body.releaseDate,
        };
        state.versions.set(version.id, version);
        return json(201, wireVersion(version, origin()));
      },
    ],

    [
      'PUT',
      '/rest/api/3/version/{id}',
      (ctx) => {
        const version = state.versions.get(ctx.params.id);
        if (version === undefined) return notFound('Version');
        const body = ctx.body ?? {};
        for (const name of [
          'name',
          'description',
          'released',
          'archived',
          'startDate',
          'releaseDate',
        ]) {
          if (Object.hasOwn(body, name)) version[name] = body[name];
        }
        return json(200, wireVersion(version, origin()));
      },
    ],

    // -- attachments -------------------------------------------------------
    [
      'GET',
      '/rest/api/3/attachment/{id}',
      (ctx) => {
        const attachment = state.attachments.get(ctx.params.id);
        if (attachment === undefined) return notFound('Attachment');
        return json(200, wireAttachment(state, attachment, origin()));
      },
    ],

    [
      'GET',
      '/rest/api/3/attachment/content/{id}',
      (ctx) => {
        const attachment = state.attachments.get(ctx.params.id);
        if (attachment === undefined) return notFound('Attachment');
        const wantsRedirect =
          config.mediaMode === 'always' ||
          (config.mediaMode === 'auto' &&
            String(ctx.query.redirect ?? 'true') !== 'false');
        if (wantsRedirect) {
          // The media hop: a 303 to a DIFFERENT host, which the client must
          // follow exactly once, anonymously.
          return {
            status: 303,
            headers: {
              location: `https://${MEDIA_HOST}:${String(server.port)}/media/${attachment.id}?token=signed`,
            },
          };
        }
        return {
          status: 200,
          buffer: attachment.bytes,
          headers: { 'content-type': attachment.mimeType },
        };
      },
    ],

    [
      'POST',
      '/rest/api/3/issue/{issueIdOrKey}/attachments',
      (ctx) => {
        const issue = issueOf(ctx.params);
        if (issue === undefined) return notFound('Issue');
        // Jira refuses a multipart upload that did not opt out of XSRF checking.
        if (ctx.headers['x-atlassian-token'] !== 'no-check') {
          return jiraError(403, ['XSRF check failed']);
        }
        const parts = parseMultipart(ctx.raw, ctx.headers['content-type']);
        const filePart = parts.find((part) => part.field === 'file');
        if (filePart === undefined) {
          return jiraError(400, ['No file was provided in the "file" form field.']);
        }
        const attachment = {
          id: nextId(),
          filename: filePart.filename ?? 'unnamed',
          authorAccountId: SELF_ACCOUNT,
          created: now(),
          size: filePart.bytes.length,
          mimeType: filePart.contentType ?? 'application/octet-stream',
          bytes: filePart.bytes,
        };
        state.attachments.set(attachment.id, attachment);
        issue.attachmentIds.push(attachment.id);
        // The upload answers with an ARRAY, even for a single file.
        return json(200, [wireAttachment(state, attachment, origin())]);
      },
    ],

    // -- filters ------------------------------------------------------------
    [
      'GET',
      '/rest/api/3/filter/search',
      (ctx) => {
        const expand = String(ctx.query.expand ?? '');
        const rows = state.filters.map((filter) => {
          const row = {
            self: `${origin()}/rest/api/3/filter/${filter.id}`,
            id: filter.id,
            name: filter.name,
            favourite: filter.favourite,
            // Sharing and subscription data comes back whether or not it was
            // asked for. The mapper is expected to drop it — it names people
            // outside the conversation — so the fake keeps sending it.
            viewUrl: `${origin()}/issues/?filter=${filter.id}`,
            searchUrl: `${origin()}/rest/api/3/search?jql=filter%3D${filter.id}`,
            sharePermissions: [
              { id: 10100, type: 'group', group: { name: 'jira-users' } },
            ],
            subscriptions: [{ id: 10102, user: { accountId: filter.ownerAccountId } }],
          };
          if (expand.includes('description')) row.description = filter.description;
          if (expand.includes('jql')) row.jql = filter.jql;
          if (expand.includes('owner'))
            row.owner = wireUser(state, filter.ownerAccountId, origin());
          return row;
        });
        return json(200, page(rows, ctx.query));
      },
    ],

    [
      'GET',
      '/rest/api/3/filter/{id}',
      (ctx) => {
        const filter = state.filters.find((row) => row.id === ctx.params.id);
        if (filter === undefined) return notFound('Filter');
        return json(200, {
          self: `${origin()}/rest/api/3/filter/${filter.id}`,
          id: filter.id,
          name: filter.name,
          description: filter.description,
          owner: wireUser(state, filter.ownerAccountId, origin()),
          jql: filter.jql,
          viewUrl: `${origin()}/issues/?filter=${filter.id}`,
          favourite: filter.favourite,
        });
      },
    ],

    // -- agile --------------------------------------------------------------
    [
      'GET',
      '/rest/agile/1.0/board',
      (ctx) => {
        const rows = state.boards.map((board) => ({
          id: board.id,
          self: `${origin()}/rest/agile/1.0/board/${String(board.id)}`,
          name: board.name,
          type: board.type,
          location: board.location,
        }));
        return json(200, agilePage(rows, ctx.query));
      },
    ],

    [
      'GET',
      '/rest/agile/1.0/board/{boardId}/sprint',
      (ctx) => {
        const boardId = Number(ctx.params.boardId);
        if (!state.boards.some((board) => board.id === boardId)) return notFound('Board');
        const rows = state.sprints
          .filter((sprint) => sprint.originBoardId === boardId)
          .map((sprint) => ({
            id: sprint.id,
            self: `${origin()}/rest/agile/1.0/sprint/${String(sprint.id)}`,
            state: sprint.state,
            name: sprint.name,
            startDate: sprint.startDate,
            endDate: sprint.endDate,
            originBoardId: sprint.originBoardId,
            goal: sprint.goal,
          }));
        return json(200, agilePage(rows, ctx.query));
      },
    ],

    [
      'GET',
      '/rest/agile/1.0/sprint/{sprintId}',
      (ctx) => {
        const sprint = state.sprints.find(
          (row) => String(row.id) === ctx.params.sprintId,
        );
        if (sprint === undefined) return notFound('Sprint');
        return json(200, {
          id: sprint.id,
          self: `${origin()}/rest/agile/1.0/sprint/${String(sprint.id)}`,
          state: sprint.state,
          name: sprint.name,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          originBoardId: sprint.originBoardId,
          goal: sprint.goal,
        });
      },
    ],

    [
      'GET',
      '/rest/agile/1.0/sprint/{sprintId}/issue',
      (ctx) => {
        const sprintId = Number(ctx.params.sprintId);
        if (!state.sprints.some((sprint) => sprint.id === sprintId))
          return notFound('Sprint');
        const fields =
          ctx.query.fields === undefined
            ? undefined
            : String(ctx.query.fields).split(',');
        const rows = [...state.issues.values()]
          .filter((issue) => !issue.deleted && issue.sprintId === sprintId)
          .map((issue) => wireIssue(state, issue, origin(), { fields }));
        const startAt = Number(ctx.query.startAt ?? 0);
        const maxResults = Number(ctx.query.maxResults ?? 50);
        return json(200, {
          expand: 'schema,names',
          startAt,
          maxResults,
          total: rows.length,
          issues: rows.slice(startAt, startAt + maxResults),
        });
      },
    ],

    // The four agile WRITE routes. They validate rather than shrug, because a
    // lenient fake turns the rehearsal into a tautology: a route that accepts
    // anything cannot catch the client sending the wrong thing, which is the
    // one class of bug this harness exists to find before Gate C does.
    //
    // Note what is NOT here: `PUT /rest/agile/1.0/sprint/{sprintId}`. Jira's
    // PUT is a FULL update that nulls every field the body omits, so the client
    // must only ever use POST (partial). Leaving PUT unrouted means a regression
    // to it surfaces as an `unmatched` request in the rehearsal's universal
    // checks instead of quietly passing.

    [
      'POST',
      '/rest/agile/1.0/sprint/{sprintId}/issue',
      (ctx) => {
        const sprintId = Number(ctx.params.sprintId);
        const sprint = state.sprints.find((row) => row.id === sprintId);
        if (sprint === undefined) return notFound('Sprint');
        const issues = ctx.body?.issues;
        if (!Array.isArray(issues) || issues.length === 0) {
          return jiraError(400, [], { issues: 'issues must be a non-empty array.' });
        }
        // THE CLAIM THIS CANNOT SETTLE (C28). docs/JIRA-API.md reads the Cloud
        // reference as a hard cap of 50 issues per call, which is why
        // api/agile.ts refuses an oversized batch locally rather than letting
        // Jira half-apply it (D22). The fake enforces that reading; agreeing
        // with the document is not evidence that Atlassian does.
        if (issues.length > 50) {
          return jiraError(400, ['Maximum number of issues in a request is 50.']);
        }
        if (sprint.state === 'closed') {
          return jiraError(400, ['Sprint is already completed.']);
        }
        const resolved = [];
        for (const wanted of issues) {
          const issue = findIssue(String(wanted));
          if (issue === undefined) {
            return jiraError(400, [
              `Issue does not exist or you do not have permission to see it: ${String(wanted)}`,
            ]);
          }
          resolved.push(issue);
        }
        for (const issue of resolved) issue.sprintId = sprintId;
        return noContent();
      },
    ],

    [
      'POST',
      '/rest/agile/1.0/backlog/issue',
      (ctx) => {
        // Deliberately board-less: this is the generic backlog route, and the
        // board-scoped variant (/backlog/{boardId}/issue) is a different
        // endpoint the client does not use. A request arriving here with a board
        // in it would be a client bug, so unknown keys are not silently eaten.
        const issues = ctx.body?.issues;
        if (!Array.isArray(issues) || issues.length === 0) {
          return jiraError(400, [], { issues: 'issues must be a non-empty array.' });
        }
        if (issues.length > 50) {
          return jiraError(400, ['Maximum number of issues in a request is 50.']);
        }
        const resolved = [];
        for (const wanted of issues) {
          const issue = findIssue(String(wanted));
          if (issue === undefined) {
            return jiraError(400, [
              `Issue does not exist or you do not have permission to see it: ${String(wanted)}`,
            ]);
          }
          resolved.push(issue);
        }
        for (const issue of resolved) issue.sprintId = undefined;
        return noContent();
      },
    ],

    [
      'POST',
      '/rest/agile/1.0/sprint',
      (ctx) => {
        const body = ctx.body ?? {};
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          return jiraError(400, [], { name: 'Sprint name must not be empty.' });
        }
        // THE CLAIM THIS CANNOT SETTLE (C27). `originBoardId` is a NUMBER here
        // while nearly every id in the v3 API is a string — the same trap as
        // `projectId` on POST /version (C15/C22). The fake enforces the
        // document's reading so a string regression FAILs the rehearsal; only a
        // real site can prove the reading itself.
        if (typeof body.originBoardId !== 'number') {
          return jiraError(400, [], {
            originBoardId: 'originBoardId must be a number, not a string.',
          });
        }
        const board = state.boards.find((row) => row.id === body.originBoardId);
        if (board === undefined) return notFound('Board');
        if (board.type !== 'scrum') {
          return jiraError(400, ['Sprints are only supported on Scrum boards.']);
        }
        const sprint = {
          id: Number(nextId()),
          // A created sprint is ALWAYS `future`, whatever dates came with it:
          // starting it is a separate call, which is what C29 exists to prove.
          state: 'future',
          name: body.name,
          startDate: body.startDate,
          endDate: body.endDate,
          originBoardId: body.originBoardId,
          goal: body.goal,
        };
        state.sprints.push(sprint);
        return json(201, {
          id: sprint.id,
          self: `${origin()}/rest/agile/1.0/sprint/${String(sprint.id)}`,
          state: sprint.state,
          name: sprint.name,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          goal: sprint.goal,
          originBoardId: sprint.originBoardId,
        });
      },
    ],

    [
      'POST',
      '/rest/agile/1.0/sprint/{sprintId}',
      (ctx) => {
        const sprint = state.sprints.find(
          (row) => String(row.id) === ctx.params.sprintId,
        );
        if (sprint === undefined) return notFound('Sprint');
        const body = ctx.body ?? {};
        const wanted = body.state;

        // The state machine, which is the whole reason this route validates:
        // future → active → closed, one step at a time, and every refusal is a
        // generic HTTP 400 that the server re-aims with SPRINT_START_REMEDIATION
        // or SPRINT_CLOSE_REMEDIATION. C29/C30 depend on that mapping.
        if (wanted === 'active') {
          if (sprint.state !== 'future') {
            return jiraError(400, [
              `Sprint is in the ${String(sprint.state)} state and cannot be started.`,
            ]);
          }
          if (body.startDate === undefined || body.endDate === undefined) {
            return jiraError(400, [
              'startDate and endDate are required to start a sprint.',
            ]);
          }
          if (config.boardHasActiveSprint) {
            // A board refuses a second active sprint unless parallel sprints are
            // enabled. The fake does NOT model this by default: the seeded board
            // already carries an active sprint, so modelling it always on would
            // make the happy path of C29 unreachable in rehearsal. It is a flag
            // instead, and rehearsal pass G turns it on to exercise the SKIP.
            return jiraError(400, [
              'The board already has an active sprint. Parallel sprints are not enabled.',
            ]);
          }
        } else if (wanted === 'closed') {
          if (sprint.state !== 'active') {
            return jiraError(400, [
              `Sprint is in the ${String(sprint.state)} state and cannot be completed.`,
            ]);
          }
          sprint.completeDate = now();
          // THE CLAIM THIS CANNOT SETTLE (C30). Closing a sprint moves its
          // unfinished issues somewhere; the reference says the next sprint if
          // there is one, otherwise the backlog. The fake takes the simple
          // documented position — everything not Done goes to the backlog — and
          // that is a reading, not evidence.
          for (const issue of state.issues.values()) {
            if (
              issue.sprintId === sprint.id &&
              issue.status?.statusCategory?.key !== 'done'
            ) {
              issue.sprintId = undefined;
            }
          }
        } else if (wanted !== undefined) {
          return jiraError(400, [], { state: `Invalid sprint state: ${String(wanted)}` });
        }

        for (const name of ['name', 'goal', 'state', 'startDate', 'endDate']) {
          if (Object.hasOwn(body, name)) sprint[name] = body[name];
        }
        return json(200, {
          id: sprint.id,
          self: `${origin()}/rest/agile/1.0/sprint/${String(sprint.id)}`,
          state: sprint.state,
          name: sprint.name,
          goal: sprint.goal,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          completeDate: sprint.completeDate,
          originBoardId: sprint.originBoardId,
        });
      },
    ],
  ];
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Start the fake.
 *
 * @param {object} options
 * @param {number} [options.port] 0 (the default) asks the OS for a free port.
 * @param {string} [options.email] The account the Basic credential must carry.
 * @param {string} [options.token] The API token the Basic credential must carry.
 * @param {string} [options.certDir] Where the TLS material lives.
 * @param {'auto'|'always'|'never'} [options.mediaMode] How
 *   `/attachment/content/{id}` answers: `auto` honours the `redirect` query
 *   parameter the way Jira Cloud documents it (so `redirect=false` returns the
 *   bytes directly), `always` forces the 303 hop, `never` forbids it.
 * @param {boolean} [options.hideWatcherRoster] Reproduce CC-47.
 * @param {boolean} [options.boardHasActiveSprint] Refuse every sprint start with
 *   the "board already has an active sprint" 400. Off by default: the fake does
 *   NOT otherwise model sprint concurrency, because the seeded board already
 *   carries an active sprint and modelling it unconditionally would make a
 *   successful start unreachable in rehearsal.
 * @param {boolean} [options.verbose] Log every request to stderr.
 */
export async function startFakeJira(options = {}) {
  const config = {
    email: options.email ?? 'rehearsal@example.invalid',
    token: options.token ?? 'rehearsal-token',
    projectKey: options.projectKey ?? 'SCRATCH',
    project2Key: options.project2Key ?? 'LEGACY',
    mediaMode: options.mediaMode ?? 'auto',
    hideWatcherRoster: options.hideWatcherRoster ?? false,
    boardHasActiveSprint: options.boardHasActiveSprint ?? false,
    verbose: options.verbose ?? false,
  };
  const certDir = options.certDir ?? join(tmpdir(), 'fake-jira-tls');
  const { key, cert, certFile } = ensureCertificate(certDir);

  const server = {
    config,
    state: seedState(config),
    /** Every request, minus credential values. */
    requests: [],
    /** Queued faults, consumed in order. */
    faults: [],
    port: 0,
    origin: '',
  };
  const routes = buildRoutes(server);

  const expectedAuth =
    'Basic ' + Buffer.from(`${config.email}:${config.token}`, 'utf8').toString('base64');

  const takeFault = (method, pathname) => {
    const index = server.faults.findIndex(
      (fault) =>
        (fault.method === undefined || fault.method === method) &&
        (fault.path === undefined || fault.path === pathname),
    );
    if (index < 0) return undefined;
    const fault = server.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) server.faults.splice(index, 1);
    return fault;
  };

  const httpServer = createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', `https://${req.headers.host ?? API_HOST}`);
      const query = Object.fromEntries(url.searchParams.entries());
      const method = (req.method ?? 'GET').toUpperCase();
      const isMediaHost = (req.headers.host ?? '').startsWith(`${MEDIA_HOST}:`);

      const record = {
        method,
        path: url.pathname,
        query,
        host: req.headers.host,
        onMediaHost: isMediaHost,
        hasAuthorization: req.headers.authorization !== undefined,
        atlassianToken: req.headers['x-atlassian-token'],
        contentType: req.headers['content-type'],
        accept: req.headers.accept,
        bytes: raw.length,
      };
      server.requests.push(record);

      const send = (result) => {
        record.status = result.status;
        const headers = { ...(result.headers ?? {}) };
        let payload;
        if (result.buffer !== undefined) {
          payload = result.buffer;
          headers['content-length'] = String(payload.length);
        } else if (result.json !== undefined) {
          payload = Buffer.from(JSON.stringify(result.json), 'utf8');
          headers['content-type'] = 'application/json;charset=UTF-8';
          headers['content-length'] = String(payload.length);
        }
        if (config.verbose) {
          process.stderr.write(
            `fake-jira ${method} ${url.pathname} -> ${String(result.status)}\n`,
          );
        }
        res.writeHead(result.status, headers);
        res.end(payload);
      };

      // -- the signed media host ------------------------------------------
      if (isMediaHost) {
        const id = /^\/media\/([^/?]+)$/.exec(url.pathname)?.[1];
        const attachment =
          id === undefined ? undefined : server.state.attachments.get(id);
        if (attachment === undefined) {
          send(jiraError(404, ['Media not found.']));
          return;
        }
        // The hop must be ANONYMOUS: leaking the Jira credential to a
        // third-party media host is the exact failure `core/http.ts` guards
        // against, so the fake refuses rather than quietly accepting it.
        if (req.headers.authorization !== undefined) {
          record.violation = 'authorization_sent_to_media_host';
          send(jiraError(400, ['The media host must not receive Jira credentials.']));
          return;
        }
        send({
          status: 200,
          buffer: attachment.bytes,
          headers: { 'content-type': attachment.mimeType },
        });
        return;
      }

      const fault = takeFault(method, url.pathname);
      if (fault !== undefined) {
        record.faultInjected = fault.status;
        const headers = { ...(fault.headers ?? {}) };
        send({
          status: fault.status,
          json: fault.body ?? {
            errorMessages: [`Injected fault ${String(fault.status)}`],
            errors: {},
          },
          headers,
        });
        return;
      }

      if (req.headers.authorization !== expectedAuth) {
        // Jira Cloud basic auth is `email:apiToken`, in that order. A client
        // that swapped them, or that sent a Bearer token, would authenticate
        // against nothing on a real site and get this same 401 — but the
        // recorded reason makes the rehearsal say WHY instead of leaving the
        // operator to guess.
        const parsed = parseBasicAuth(req.headers.authorization);
        record.authFailure =
          parsed === undefined
            ? 'not HTTP Basic'
            : parsed.user === config.token
              ? 'email and token are the wrong way round'
              : parsed.user !== config.email
                ? 'unexpected username'
                : 'wrong token';
        send(
          json(
            401,
            {
              errorMessages: ['Client must be authenticated to access this resource.'],
              errors: {},
            },
            { 'www-authenticate': 'Basic realm="Jira"' },
          ),
        );
        return;
      }

      let body;
      if (raw.length > 0 && (req.headers['content-type'] ?? '').includes('json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          send(jiraError(400, ['The request body could not be parsed as JSON.']));
          return;
        }
      }
      record.body = body;

      for (const [routeMethod, pattern, handler] of routes) {
        if (routeMethod !== method) continue;
        const params = matchPath(pattern, url.pathname);
        if (params === undefined) continue;
        try {
          send(handler({ params, query, body, raw, headers: req.headers, method }));
        } catch (error) {
          record.handlerError = String(error);
          send(jiraError(500, [`fake-jira handler crashed: ${String(error)}`]));
        }
        return;
      }

      // Nothing matched. Recorded loudly, because an unmatched route in a
      // rehearsal means the fake is missing an endpoint the client really uses.
      record.unmatched = true;
      send(jiraError(404, [`fake-jira has no route for ${method} ${url.pathname}`]));
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  server.port = httpServer.address().port;
  server.origin = `https://${API_HOST}:${String(server.port)}`;

  return {
    port: server.port,
    origin: server.origin,
    certFile,
    state: server.state,
    requests: server.requests,
    config,
    /** Queue faults to be returned by the next matching requests. */
    arm(...faults) {
      server.faults.push(...faults);
    },
    /** Forget the recorded traffic — handy between rehearsal passes. */
    clearRequests() {
      server.requests.length = 0;
    },
    setMediaMode(mode) {
      config.mediaMode = mode;
    },
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone entry
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: 'string', default: '0' },
      email: { type: 'string' },
      token: { type: 'string' },
      'cert-dir': { type: 'string' },
      media: { type: 'string', default: 'auto' },
      quiet: { type: 'boolean', default: false },
    },
    strict: true,
  });
  const fake = await startFakeJira({
    port: Number(values.port),
    email: values.email,
    token: values.token,
    certDir: values['cert-dir'],
    mediaMode: values.media,
    verbose: values.quiet !== true,
  });
  process.stderr.write(
    [
      `fake-jira listening on ${fake.origin} (bound to 127.0.0.1:${String(fake.port)})`,
      `  JIRA_SITE=${fake.origin}`,
      `  JIRA_ALLOWED_HOSTS=${API_HOST},${MEDIA_HOST}`,
      `  NODE_EXTRA_CA_CERTS=${fake.certFile}`,
      `  ${API_HOST} and ${MEDIA_HOST} must resolve to 127.0.0.1 for the client`,
      '',
    ].join('\n'),
  );
}
