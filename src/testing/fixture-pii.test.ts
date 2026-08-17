// Fixture PII lint (TESTING.md §Fixtures, [test]) — the suite that stands
// between a recording session and a tenant's data committed forever.
//
// It has two halves and BOTH are mandatory:
//
//  1. the walk over the real `test/fixtures/**/*.json` corpus, which is what
//     actually fails `npm run check`;
//  2. an adversarial sample table run through the SAME detector, because half 1
//     is only as convincing as the corpus is large — and today the corpus is two
//     synthetic files. A lint proven against an almost-empty directory is
//     theatre. Every residue class TESTING.md names has a sample here that must
//     be caught, and every placeholder form it blesses has a sample that must
//     NOT be, so the allow-list is asserted as tightly as the deny-list.
//
// A third, smaller half proves the *walker* rather than the detector: a planted
// adversarial file in a temp directory has to be found by `scanFixtureDir`, so a
// mis-built glob cannot pass by reading nothing.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FIXTURES_DIR, listFixtureFiles } from '../core/fakes/fixtures.js';
import {
  CREDENTIAL_KEYS,
  FIXTURE_PLACEHOLDERS,
  formatScans,
  listNonJsonFiles,
  scanFixtureDir,
  scanFixtureValue,
  scanString,
  type PiiFinding,
  type PiiRule,
} from './fixture-pii.js';

// ---------------------------------------------------------------------------
// Half 2a — every residue class is caught
// ---------------------------------------------------------------------------

/** Every rule the detector can report. A new rule with no sample fails below. */
const ALL_RULES: readonly PiiRule[] = [
  'email',
  'account-id',
  'site-host',
  'credential-key',
  'jwt',
  'atlassian-token',
];

/** A believable JWT: three base64url segments, the first starting `eyJ`. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

/** A real-shaped Atlassian API token. */
const API_TOKEN = 'ATATT3xFfGF0T4Jq8nQ2LmXpZ1vYb7cRd9WsKe5Nh6Ag';

/** Nest `leaf` inside `depth` ADF paragraph levels, to walk past any depth cap. */
function nestAdf(depth: number, leaf: unknown): unknown {
  let node: unknown = leaf;
  for (let i = 0; i < depth; i += 1) node = { type: 'paragraph', content: [node] };
  return node;
}

interface Sample {
  readonly label: string;
  readonly rule: PiiRule;
  /** Expected finding path, when the point of the sample is *where* it looks. */
  readonly path?: string;
  readonly document: unknown;
}

const CAUGHT: readonly Sample[] = [
  {
    label: 'a real email in a user object',
    rule: 'email',
    path: '$.fields.assignee.emailAddress',
    document: { fields: { assignee: { emailAddress: 'maria.petrova@acme.example' } } },
  },
  {
    label: 'a real email buried in ADF prose 16 levels deep',
    rule: 'email',
    document: nestAdf(16, { type: 'text', text: 'ping ivan.baev@acme.example about it' }),
  },
  {
    label: 'a real email used as an object KEY',
    rule: 'email',
    path: '$.watchers["maria.petrova@acme.example"]',
    document: { watchers: { 'maria.petrova@acme.example': true } },
  },
  {
    label: 'a 24-hex accountId outside the placeholder range',
    rule: 'account-id',
    path: '$.accountId',
    document: { accountId: '712020f4a1b9c8d3e6f70a2b' },
  },
  {
    label: 'an opaque nnnnnn:uuid accountId with a real uuid',
    rule: 'account-id',
    path: '$.author.accountId',
    document: { author: { accountId: '557058:5f1e3a7c-9b2d-4e18-8a63-0c4d7e9f1b25' } },
  },
  {
    label: 'an accountId hidden in a URL query string',
    rule: 'account-id',
    path: '$.self',
    document: {
      self: 'https://example.atlassian.net/rest/api/3/user?accountId=712020f4a1b9c8d3e6f70a2b',
    },
  },
  {
    label: 'an accountId used as a map KEY',
    rule: 'account-id',
    path: '$.votes["712020f4a1b9c8d3e6f70a2b"]',
    document: { votes: { '712020f4a1b9c8d3e6f70a2b': 1 } },
  },
  {
    label: 'the real site host in a self link',
    rule: 'site-host',
    path: '$.exchanges[0].request.url',
    document: {
      exchanges: [
        { request: { url: 'https://acme-corp.atlassian.net/rest/api/3/myself' } },
      ],
    },
  },
  {
    label: 'the real site host mentioned in prose',
    rule: 'site-host',
    path: '$.note',
    document: { note: 'recorded against acmecorp.atlassian.net on a Tuesday' },
  },
  {
    label: 'an Authorization header key that survived redaction',
    rule: 'credential-key',
    path: '$.exchanges[0].request.headers.Authorization',
    document: {
      exchanges: [{ request: { headers: { Authorization: 'Basic dXNlcjp0b2tlbg==' } } }],
    },
  },
  {
    label: 'a set-cookie response header key',
    rule: 'credential-key',
    path: '$.exchanges[0].response.headers["set-cookie"]',
    document: {
      exchanges: [{ response: { headers: { 'set-cookie': 'JSESSIONID=x' } } }],
    },
  },
  {
    label: 'a Cookie request header key, however it is cased',
    rule: 'credential-key',
    path: '$.headers.CooKie',
    document: { headers: { CooKie: 'atlassian.xsrf.token=abc' } },
  },
  {
    label: 'a password field',
    rule: 'credential-key',
    path: '$.params.password',
    document: { params: { password: 'hunter2' } },
  },
  {
    label: 'a JWT in a media URL',
    rule: 'jwt',
    path: '$.content[0].attrs.url',
    document: {
      content: [{ attrs: { url: `https://media.example.com/f?token=${JWT}` } }],
    },
  },
  {
    label: 'a bare JWT value',
    rule: 'jwt',
    path: '$.token',
    document: { token: JWT },
  },
  {
    label: 'an Atlassian API token',
    rule: 'atlassian-token',
    path: '$.params.token',
    // The key `token` is deliberately NOT on the credential list: this asserts
    // the VALUE rule, which catches a token pasted somewhere nobody expected.
    document: { params: { token: API_TOKEN } },
  },
  {
    label: 'residue nested inside arrays of arrays',
    rule: 'email',
    path: '$.rows[1][0].email',
    document: { rows: [[], [{ email: 'ops.team@acme.example' }]] },
  },
];

test('CC-73: the detector catches every residue class TESTING.md names', () => {
  for (const sample of CAUGHT) {
    const findings = scanFixtureValue(sample.document);
    assert.ok(
      findings.length > 0,
      `${sample.label}: expected a finding, got none — the lint would pass this file`,
    );
    const matching = findings.filter((f: PiiFinding) => f.rule === sample.rule);
    assert.ok(
      matching.length > 0,
      `${sample.label}: expected rule ${sample.rule}, got ${findings
        .map((f) => f.rule)
        .join(', ')}`,
    );
    if (sample.path !== undefined) {
      assert.equal(matching[0]?.path, sample.path, `${sample.label}: wrong path`);
    }
  }
});

test('the sample table exercises every rule the detector can report', () => {
  // Guards against the failure mode this whole file exists to prevent: a rule
  // that is never proven, and therefore might not work at all.
  const covered = new Set(CAUGHT.map((sample) => sample.rule));
  assert.deepEqual([...covered].sort(), [...ALL_RULES].sort());
});

test('findings are located and truncated, not dumped into CI logs', () => {
  const [finding] = scanString(`token ${JWT} end`, '$.body.text');
  assert.ok(finding !== undefined);
  assert.equal(finding.rule, 'jwt');
  assert.equal(finding.path, '$.body.text');
  assert.equal(finding.where, 'value');
  assert.ok(finding.evidence.length <= 21, `evidence not truncated: ${finding.evidence}`);
  assert.ok(JWT.startsWith(finding.evidence.replace('…', '')));
  assert.match(finding.message, /\$\.body\.text/);
  assert.match(finding.message, /\[jwt\]/);
});

// ---------------------------------------------------------------------------
// Half 2b — the placeholder vocabulary is NOT a finding
// ---------------------------------------------------------------------------

const ALLOWED: readonly { label: string; document: unknown }[] = [
  {
    label: 'the placeholder email',
    document: { emailAddress: FIXTURE_PLACEHOLDERS.email(1) },
  },
  {
    label: 'both placeholder accountId forms, side by side',
    document: {
      // A nnnnnn:uuid id keeps its shape — collapsing it into the 24-hex form
      // would destroy what the fixture exists to preserve (TESTING.md).
      a: FIXTURE_PLACEHOLDERS.accountId(1),
      b: FIXTURE_PLACEHOLDERS.opaqueAccountId(7),
      c: FIXTURE_PLACEHOLDERS.accountId(42),
    },
  },
  {
    label: 'placeholder accountIds used as map keys',
    document: { [FIXTURE_PLACEHOLDERS.accountId(3)]: { active: true } },
  },
  {
    label: 'the placeholder display name',
    document: { displayName: FIXTURE_PLACEHOLDERS.displayName(2) },
  },
  {
    label: 'the placeholder site in self, avatar and next URLs',
    document: {
      self: `https://${FIXTURE_PLACEHOLDERS.site}/rest/api/3/issue/EX-1`,
      avatarUrls: {
        '48x48': `https://${FIXTURE_PLACEHOLDERS.site}/secure/useravatar?size=48`,
      },
      next: `https://${FIXTURE_PLACEHOLDERS.site}/rest/api/3/search/jql`,
      subdomainish: `https://media.${FIXTURE_PLACEHOLDERS.site}/file/1`,
    },
  },
  {
    label: 'the recorder headersDropped list — evidence of a drop, not a leak',
    // The exact false positive TESTING.md warns about: a lint that grepped for
    // the substring "authorization" would fail every fixture the recorder makes.
    document: {
      request: {
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        headersDropped: ['authorization', 'cookie', 'set-cookie'],
      },
    },
  },
  {
    label: 'the XSRF header, which is not a credential',
    document: { headers: { 'x-atlassian-token': 'no-check' } },
  },
  {
    label: 'an opaque nextPageToken',
    document: { nextPageToken: 'CAEaAggDGAMiBggBEAEYAQ==' },
  },
  {
    label: 'a 32-hex avatar id (longer than an accountId, and not one)',
    document: {
      avatar: `https://${FIXTURE_PLACEHOLDERS.site}/wiki/aa-avatar/9f2c1d8e4b7a6c5d3e0f1a2b3c4d5e6f`,
    },
  },
  {
    label: 'Atlassian media hostnames that are not the site',
    document: { url: 'https://api.media.atlassian.com/file/abc/binary' },
  },
  {
    label: 'ordinary Jira scalars',
    document: {
      id: '10001',
      key: 'EX-42',
      created: '2026-01-14T09:31:07.412+0200',
      status: { name: 'In Progress' },
      headers: { 'content-type': 'application/json;charset=UTF-8' },
      body: { errorMessages: ['Issue does not exist or you do not have permission'] },
    },
  },
];

test('the placeholder vocabulary is never a finding', () => {
  for (const sample of ALLOWED) {
    const findings = scanFixtureValue(sample.document);
    assert.equal(
      findings.length,
      0,
      `${sample.label}: false positive — ${findings.map((f) => f.message).join('; ')}`,
    );
  }
});

test('credential keys are matched exactly, never as substrings', () => {
  // Both halves of the rule in one place: the key `authorization` is a finding,
  // a key that merely CONTAINS it is not, and the string value is not either.
  assert.equal(scanFixtureValue({ authorization: 'x' }).length, 1);
  assert.equal(scanFixtureValue({ 'x-authorization-info': 'x' }).length, 0);
  assert.equal(scanFixtureValue({ note: 'authorization was dropped' }).length, 0);
  for (const key of CREDENTIAL_KEYS) {
    const findings = scanFixtureValue({ [key]: 'value' });
    assert.equal(findings.length, 1, `${key} must be a finding`);
    assert.equal(findings[0]?.rule, 'credential-key');
    assert.equal(findings[0]?.where, 'key');
    // Case is irrelevant — headers arrive however the server spelled them.
    assert.equal(scanFixtureValue({ [key.toUpperCase()]: 'value' }).length, 1);
  }
});

// ---------------------------------------------------------------------------
// Half 3 — the walker itself
// ---------------------------------------------------------------------------

test('the directory walk finds planted residue and names the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jira-mcp-pii-'));
  try {
    mkdirSync(join(dir, 'search'), { recursive: true });
    writeFileSync(
      join(dir, 'clean.json'),
      `${JSON.stringify({ site: FIXTURE_PLACEHOLDERS.site }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, 'search', 'leaky.json'),
      `${JSON.stringify(
        {
          exchanges: [
            {
              request: {
                url: 'https://acme-corp.atlassian.net/rest/api/3/search/jql',
                headers: { Authorization: 'Basic dXNlcjp0b2tlbg==' },
              },
              response: {
                body: {
                  issues: [
                    {
                      fields: {
                        assignee: {
                          accountId: '712020f4a1b9c8d3e6f70a2b',
                          emailAddress: 'maria.petrova@acme.example',
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const scans = scanFixtureDir(dir);
    assert.deepEqual(
      scans.map((scan) => scan.file),
      ['clean.json', 'search/leaky.json'],
    );
    assert.equal(scans[0]?.findings.length, 0);

    const leaky = scans[1];
    assert.ok(leaky !== undefined);
    const rules = new Set(leaky.findings.map((f) => f.rule));
    assert.deepEqual([...rules].sort(), [
      'account-id',
      'credential-key',
      'email',
      'site-host',
    ]);

    const report = formatScans(scans);
    assert.match(report, /^search\/leaky\.json /m);
    assert.match(report, /\$\.exchanges\[0\]\.response\.body\.issues\[0\]/);
    assert.equal(formatScans([scans[0]].filter((s) => s !== undefined)), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Half 1 — the real corpus
// ---------------------------------------------------------------------------

test('CC-73: every committed fixture is free of tenant residue', () => {
  const scans = scanFixtureDir();
  // A corpus that reads as empty would make this suite pass by doing nothing —
  // exactly the failure mode the sample table above exists to rule out.
  assert.ok(
    scans.length > 0,
    `no fixtures found under ${FIXTURES_DIR}; the lint would be vacuous`,
  );
  assert.deepEqual(
    scans.map((scan) => scan.file),
    listFixtureFiles(),
  );

  const report = formatScans(scans);
  assert.equal(report, '', `fixture PII lint found tenant residue:\n${report}`);
});

test('every committed fixture declares how it came to exist', () => {
  // The honor rule in TESTING.md §Mocking tiers has one mechanical edge: a file
  // may claim to be a recording, or may be hand-crafted, but it must say which,
  // and a hand-crafted one must carry the note that justifies it. What no test
  // can check is whether a `synthetic: false` file was really recorded against
  // Jira rather than against our own fake — that stays a review question.
  for (const scan of scanFixtureDir()) {
    const document = scan.document;
    assert.ok(
      document !== null && typeof document === 'object' && !Array.isArray(document),
      `${scan.file}: a fixture is a JSON object`,
    );
    const record = document as Record<string, unknown>;
    assert.equal(typeof record.scenario, 'string', `${scan.file}: missing scenario`);
    assert.equal(typeof record.synthetic, 'boolean', `${scan.file}: missing synthetic`);
    assert.equal(
      record.site,
      FIXTURE_PLACEHOLDERS.site,
      `${scan.file}: site must be the placeholder`,
    );
    assert.ok(Array.isArray(record.exchanges), `${scan.file}: missing exchanges`);

    if (record.synthetic === false) {
      assert.equal(
        record.recordedBy,
        'scripts/record-fixture.mjs',
        `${scan.file}: only the record script may produce a non-synthetic fixture`,
      );
    } else {
      assert.equal(
        typeof record.note,
        'string',
        `${scan.file}: a hand-crafted fixture must say why it is hand-crafted ` +
          '(TESTING.md §Fixtures)',
      );
      assert.match(String(record.note), /SYNTHETIC/);
    }
  }
});

test('nothing hides in the corpus that the lint does not read', () => {
  // The walk reads *.json only, so a stray .har, .txt or editor backup would be
  // invisible to the lint and just as committed-forever as everything else.
  assert.deepEqual(listNonJsonFiles(), []);
});
