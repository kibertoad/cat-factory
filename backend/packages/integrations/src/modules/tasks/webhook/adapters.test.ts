import { describe, expect, it } from 'vitest'
import type { TrackerWebhookDelivery } from '@cat-factory/kernel'
import { githubIssuesWebhookAdapter, jiraWebhookAdapter, linearWebhookAdapter } from './adapters.js'

const SECRET = 'a-webhook-secret'

/** Build a delivery, signing the body with {@link SECRET} into `header` (prefixed unless bare). */
async function delivery(
  payload: unknown,
  opts: { header: string; prefix?: string; eventName?: string },
): Promise<TrackerWebhookDelivery> {
  const body = JSON.stringify(payload)
  const raw = new TextEncoder().encode(body)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw))
  let hex = ''
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0')
  return {
    eventName: opts.eventName ?? '',
    headers: { [opts.header]: `${opts.prefix ?? ''}${hex}` },
    // `raw.buffer` is the exact bytes the receiver hands over — verification must run over THESE,
    // never a re-serialised parse.
    raw: raw.buffer as ArrayBuffer,
  }
}

describe('tracker webhook signature verification', () => {
  const cases = [
    {
      name: 'github',
      adapter: githubIssuesWebhookAdapter,
      header: 'x-hub-signature-256',
      prefix: 'sha256=',
    },
    { name: 'jira', adapter: jiraWebhookAdapter, header: 'x-hub-signature', prefix: 'sha256=' },
    { name: 'linear', adapter: linearWebhookAdapter, header: 'linear-signature', prefix: '' },
  ] as const

  for (const { name, adapter, header, prefix } of cases) {
    describe(name, () => {
      it('accepts a correctly signed delivery', async () => {
        const d = await delivery({ any: 'body' }, { header, prefix })
        expect(await adapter.verify(SECRET, d)).toBe(true)
      })

      it('FAILS CLOSED on an empty secret, without throwing', async () => {
        // Two things at once. An empty HMAC key is one an attacker also has, so an unconfigured
        // connection must never accept a delivery. And the guard has to come BEFORE `importKey`,
        // which rejects a zero-length key with a `DataError` — the port requires `verify` to
        // RESOLVE false for every rejection, so a throw here would surface as a 500 to the tracker
        // (and a redelivery loop) instead of the terse 401 the receiver is designed to send.
        const d = await delivery({ any: 'body' }, { header, prefix })
        await expect(adapter.verify('', d)).resolves.toBe(false)
      })

      it('rejects a mismatched secret, a missing header and a malformed digest', async () => {
        const signed = await delivery({ any: 'body' }, { header, prefix })
        expect(await adapter.verify('another-secret', signed)).toBe(false)
        expect(await adapter.verify(SECRET, { ...signed, headers: {} })).toBe(false)
        expect(
          await adapter.verify(SECRET, { ...signed, headers: { [header]: `${prefix}zzzz` } }),
        ).toBe(false)
      })

      it('rejects a tampered body under a valid-looking signature', async () => {
        const signed = await delivery({ any: 'body' }, { header, prefix })
        const tampered = new TextEncoder().encode(JSON.stringify({ any: 'other' }))
        expect(
          await adapter.verify(SECRET, { ...signed, raw: tampered.buffer as ArrayBuffer }),
        ).toBe(false)
      })
    })
  }

  it('rejects a GitHub/Jira digest that omits the scheme prefix', async () => {
    // A vendor option set to sha1 sends `sha1=<40 hex>`; decoding that as if it were the SHA-256
    // would fail opaquely instead of visibly.
    const d = await delivery({ any: 'body' }, { header: 'x-hub-signature-256', prefix: 'sha1=' })
    expect(await githubIssuesWebhookAdapter.verify(SECRET, d)).toBe(false)
  })
})

describe('githubIssuesWebhookAdapter.parse', () => {
  const raw = (payload: unknown, eventName: string): TrackerWebhookDelivery => ({
    eventName,
    headers: {},
    raw: new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
  })

  it('maps an issue_comment `created` onto the neutral comment event', () => {
    const event = githubIssuesWebhookAdapter.parse(
      raw(
        {
          action: 'created',
          repository: { full_name: 'acme/api' },
          issue: { number: 42 },
          comment: {
            id: 991,
            body: '@cat-factory proceed',
            user: { login: 'ada', node_id: 'U_1' },
          },
        },
        'issue_comment',
      ),
    )
    expect(event).toEqual({
      kind: 'comment',
      source: 'github',
      externalId: 'acme/api#42',
      commentId: '991',
      body: '@cat-factory proceed',
      author: { id: 'U_1', handle: 'ada', email: null, bot: false },
    })
  })

  it('flags a Bot author, which is how the platform’s own comments are dropped', () => {
    const event = githubIssuesWebhookAdapter.parse(
      raw(
        {
          action: 'created',
          repository: { full_name: 'acme/api' },
          issue: { number: 42 },
          comment: { id: 1, body: 'x', user: { login: 'cat-factory[bot]', type: 'Bot' } },
        },
        'issue_comment',
      ),
    )
    expect(event).toMatchObject({ author: { bot: true } })
  })

  it('ignores an edited or deleted comment', () => {
    // An `edited` delivery would be a legitimate second apply under the same claim key; a
    // `deleted` one carries a comment we must not act on at all.
    for (const action of ['edited', 'deleted']) {
      expect(
        githubIssuesWebhookAdapter.parse(
          raw(
            {
              action,
              repository: { full_name: 'acme/api' },
              issue: { number: 42 },
              comment: { id: 1, body: 'x', user: { login: 'ada' } },
            },
            'issue_comment',
          ),
        ),
      ).toBeNull()
    }
  })

  it('maps an issues event, collapsing label edits onto `updated`', () => {
    const event = githubIssuesWebhookAdapter.parse(
      raw(
        {
          action: 'labeled',
          repository: { full_name: 'acme/api' },
          issue: {
            number: 7,
            title: 'Crash on submit',
            labels: [{ name: 'bug' }],
            type: { name: 'Bug' },
            html_url: 'https://github.test/acme/api/issues/7',
          },
        },
        'issues',
      ),
    )
    expect(event).toEqual({
      kind: 'issue',
      source: 'github',
      externalId: 'acme/api#7',
      action: 'updated',
      title: 'Crash on submit',
      labels: ['bug'],
      issueType: 'Bug',
      // The `owner/name` slug is exactly what an intake config's `githubRepo` scope carries, so a
      // schedule scoped to one repository can compare against it with no per-vendor knowledge.
      board: 'acme/api',
      url: 'https://github.test/acme/api/issues/7',
    })
  })

  it('returns null for an unrelated delivery or a payload it cannot key', () => {
    expect(githubIssuesWebhookAdapter.parse(raw({ zen: 'hi' }, 'ping'))).toBeNull()
    expect(
      githubIssuesWebhookAdapter.parse(raw({ action: 'opened', issue: { number: 1 } }, 'issues')),
    ).toBeNull()
  })
})

describe('jiraWebhookAdapter.parse', () => {
  const raw = (payload: unknown): TrackerWebhookDelivery => ({
    eventName: '',
    headers: {},
    raw: new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
  })

  it('maps comment_created, upper-casing the key exactly as parseJiraRef does', () => {
    const event = jiraWebhookAdapter.parse(
      raw({
        webhookEvent: 'comment_created',
        issue: { key: 'eng-12' },
        comment: {
          id: '10001',
          body: '@cat-factory dismiss rri_1',
          author: { accountId: 'a1', displayName: 'Ada', emailAddress: 'ada@acme.test' },
        },
      }),
    )
    // The projection is keyed by the canonical (upper-cased) key, so a lower-cased payload must
    // still resolve to the imported row.
    expect(event).toMatchObject({ kind: 'comment', externalId: 'ENG-12', commentId: '10001' })
  })

  it('maps issue_updated, reading `done` off the status CATEGORY', () => {
    const event = jiraWebhookAdapter.parse(
      raw({
        webhookEvent: 'jira:issue_updated',
        issue: {
          key: 'ENG-3',
          fields: {
            summary: 'Timeouts',
            labels: ['bug'],
            issuetype: { name: 'Bug' },
            status: { statusCategory: { key: 'done' } },
          },
        },
      }),
    )
    expect(event).toMatchObject({ kind: 'issue', action: 'closed', labels: ['bug'] })
  })

  it('reads the board as the project KEY, upper-cased, never the project id', () => {
    // `IssueIntakeQuery.board.jiraProjectKey` is a KEY: it is what a schedule stores, what
    // `listBoards` hands the picker, and what JQL scopes on. The numeric id would look plausible
    // in the payload and never match a configured scope.
    const event = jiraWebhookAdapter.parse(
      raw({
        webhookEvent: 'jira:issue_created',
        issue: {
          key: 'ENG-4',
          fields: { summary: 'x', project: { id: '10001', key: 'eng' }, labels: [] },
        },
      }),
    )
    expect(event).toMatchObject({ kind: 'issue', board: 'ENG' })
  })

  it('states a MISSING project as null rather than guessing one', () => {
    const event = jiraWebhookAdapter.parse(
      raw({
        webhookEvent: 'jira:issue_created',
        issue: { key: 'ENG-5', fields: { summary: 'x', labels: [] } },
      }),
    )
    expect(event).toMatchObject({ kind: 'issue', board: null })
  })

  it('ignores an ADF comment body it cannot read as text', () => {
    // Guessing at ADF traversal here would be a second, drifting copy of the import path's
    // normalisation; a reply is a plain-text command line.
    expect(
      jiraWebhookAdapter.parse(
        raw({
          webhookEvent: 'comment_created',
          issue: { key: 'ENG-1' },
          comment: { id: '1', body: { type: 'doc', content: [] }, author: {} },
        }),
      ),
    ).toBeNull()
  })
})

describe('linearWebhookAdapter.parse', () => {
  const raw = (payload: unknown): TrackerWebhookDelivery => ({
    eventName: '',
    headers: {},
    raw: new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer,
  })

  it('keys a comment by the issue IDENTIFIER, not its UUID', () => {
    // `data.issue.id` is a UUID and would never match an imported row; `identifier` is what
    // `parseLinearRef` yields and therefore what the projection is keyed by.
    const event = linearWebhookAdapter.parse(
      raw({
        type: 'Comment',
        action: 'create',
        data: {
          id: 'c-1',
          body: '@cat-factory proceed',
          issue: { id: 'uuid-here', identifier: 'eng-9' },
          user: { id: 'u1', name: 'Ada', email: 'ada@acme.test' },
        },
      }),
    )
    expect(event).toMatchObject({ kind: 'comment', externalId: 'ENG-9', commentId: 'c-1' })
  })

  it('maps an Issue update, reading `completed` off the state type and reporting no issue type', () => {
    const event = linearWebhookAdapter.parse(
      raw({
        type: 'Issue',
        action: 'update',
        data: {
          identifier: 'ENG-4',
          title: 'Crash',
          labels: [{ name: 'bug' }],
          state: { type: 'completed' },
          url: 'https://linear.app/acme/issue/ENG-4',
        },
      }),
    )
    // Linear has no issue-type notion, so `null` is the honest answer, reported as a predicate the
    // delivery cannot answer rather than one it fails, which is what stops it excluding the source.
    expect(event).toMatchObject({ kind: 'issue', action: 'closed', issueType: null })
  })

  it('reads the board as the team UUID, falling back to a bare `teamId`', () => {
    // `buildLinearIntakeFilter` matches `team.id.eq`, and `listTeams` hands the picker the same
    // UUID. The human team KEY would look plausible here and never match a configured scope.
    const withTeam = linearWebhookAdapter.parse(
      raw({
        type: 'Issue',
        action: 'create',
        data: { identifier: 'ENG-5', title: 'x', team: { id: 'team-uuid', key: 'ENG' } },
      }),
    )
    expect(withTeam).toMatchObject({ board: 'team-uuid' })

    const leaner = linearWebhookAdapter.parse(
      raw({
        type: 'Issue',
        action: 'create',
        data: { identifier: 'ENG-6', title: 'x', teamId: 'team-uuid' },
      }),
    )
    expect(leaner).toMatchObject({ board: 'team-uuid' })
  })

  it('ignores a non-create comment action and an unrelated entity', () => {
    expect(
      linearWebhookAdapter.parse(raw({ type: 'Comment', action: 'update', data: { id: 'c' } })),
    ).toBeNull()
    expect(linearWebhookAdapter.parse(raw({ type: 'Reaction', action: 'create' }))).toBeNull()
  })
})
