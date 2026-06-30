import type {
  Block,
  BlockRepository,
  Notification,
  SecretCipher,
  SlackConnectionRecord,
  SlackConnectionRepository,
  SlackMemberMappingEntry,
  SlackMemberMappingRepository,
  SlackSettingsRecord,
  SlackSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import { SlackApiClient } from './SlackApiClient.js'
import { SlackNotificationChannel } from './SlackNotificationChannel.js'

// The channel posts via SlackApiClient over the global `fetch`; intercept that real fetch with
// undici's MockAgent rather than a hand-stubbed fetch (the old fake `{ json }` omitted
// `ok`/`status`/`headers`). `disableNetConnect` makes an unexpected post fail loudly.
const SLACK = 'https://slack.com'

let agent: MockAgent
let previousDispatcher: ReturnType<typeof getGlobalDispatcher>

beforeEach(() => {
  previousDispatcher = getGlobalDispatcher()
  agent = new MockAgent()
  agent.disableNetConnect()
  setGlobalDispatcher(agent)
  // Node's built-in `fetch` binds to its OWN bundled undici (v7 on Node 24), which ignores a
  // dispatcher set on the userland `undici` package (v8) — so the MockAgent above would be
  // silently bypassed and the channel would post to the REAL Slack API. Route the SUT's `fetch`
  // through the userland undici's fetch, which honours the dispatcher we set.
  vi.stubGlobal('fetch', undiciFetch)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  setGlobalDispatcher(previousDispatcher)
  await agent.close()
})

/** Record every chat.postMessage (token + parsed body); `calls` stays empty if none is sent. */
function recordChatPost(): { token: string; body: unknown }[] {
  const calls: { token: string; body: unknown }[] = []
  agent
    .get(SLACK)
    .intercept({ path: '/api/chat.postMessage', method: 'POST' })
    .reply(200, (opts) => {
      const auth = (opts.headers as Record<string, string>).authorization ?? ''
      calls.push({
        token: auth.replace('Bearer ', ''),
        body: opts.body ? JSON.parse(String(opts.body)) : null,
      })
      return JSON.stringify({ ok: true })
    })
    .persist()
  return calls
}

// A SecretCipher whose ciphertext is just the plaintext reversed (deterministic,
// no crypto needed) — enough to prove decrypt is invoked before posting.
const reversingCipher: SecretCipher = {
  encrypt: async (s) => [...s].reverse().join(''),
  decrypt: async (s) => [...s].reverse().join(''),
}

function workspaceRepo(accountId: string | null): WorkspaceRepository {
  return { accountOf: async () => accountId } as unknown as WorkspaceRepository
}

function connectionRepo(record: SlackConnectionRecord | null): SlackConnectionRepository {
  return {
    getByAccount: async () => record,
    getByTeam: async () => null,
    upsert: async () => {},
    softDelete: async () => {},
  }
}

function settingsRepo(record: SlackSettingsRecord | null): SlackSettingsRepository {
  return { getByWorkspace: async () => record, upsert: async () => {} }
}

function mappingRepo(entries: SlackMemberMappingEntry[]): SlackMemberMappingRepository {
  return { getByAccount: async () => entries, upsert: async () => {} }
}

/** A BlockRepository whose `get` returns a task block with the given creator. */
function blockRepo(createdBy: string | null): BlockRepository {
  const block = { id: 'blk_1', createdBy } as unknown as Block
  return { get: async () => block } as unknown as BlockRepository
}

const connection: SlackConnectionRecord = {
  accountId: 'acc_1',
  teamId: 'T1',
  teamName: 'Acme',
  teamIconUrl: null,
  botUserId: 'B1',
  scopesJson: null,
  tokenCipher: 'xxx-nkot', // decrypts (reversed) to "tokn-xxx"
  createdAt: 0,
  deletedAt: null,
}

const notification: Notification = {
  id: 'ntf_1',
  type: 'merge_review',
  status: 'open',
  blockId: 'blk_1',
  executionId: 'exe_1',
  title: 'Review PR',
  body: 'body',
  payload: null,
  createdAt: 0,
  resolvedAt: null,
}

const enabledRoute = (channel: string): SlackSettingsRecord => ({
  workspaceId: 'ws_1',
  routesJson: JSON.stringify({
    merge_review: { enabled: true, channel },
    requirement_review: { enabled: true, channel },
  }),
  mentionsEnabled: true,
  updatedAt: 0,
})

describe('SlackNotificationChannel', () => {
  it('posts to the routed channel with the decrypted token', async () => {
    const calls = recordChatPost()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo({
        workspaceId: 'ws_1',
        routesJson: JSON.stringify({ merge_review: { enabled: true, channel: '#releases' } }),
        mentionsEnabled: false,
        updatedAt: 0,
      }),
      slackMemberMappingRepository: mappingRepo([]),
      blockRepository: blockRepo(null),
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
    })

    await channel.deliver('ws_1', notification)

    // The interceptor path guarantees the call hit chat.postMessage.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.token).toBe('tokn-xxx')
    expect((calls[0]!.body as { channel: string }).channel).toBe('#releases')
  })

  it('does not post when the type is disabled or unrouted', async () => {
    const calls = recordChatPost()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo({
        workspaceId: 'ws_1',
        routesJson: JSON.stringify({ merge_review: { enabled: false, channel: '#releases' } }),
        mentionsEnabled: false,
        updatedAt: 0,
      }),
      slackMemberMappingRepository: mappingRepo([]),
      blockRepository: blockRepo(null),
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
    })

    await channel.deliver('ws_1', notification)
    expect(calls).toHaveLength(0)
  })

  it('does not post when the account has no Slack connection', async () => {
    const calls = recordChatPost()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(null),
      slackSettingsRepository: settingsRepo(enabledRoute('#releases')),
      slackMemberMappingRepository: mappingRepo([]),
      blockRepository: blockRepo('usr_7'),
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
    })

    await channel.deliver('ws_1', notification)
    expect(calls).toHaveLength(0)
  })

  it('mentions ONLY the task creator on an engineering notification', async () => {
    const calls = recordChatPost()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo(enabledRoute('#releases')),
      slackMemberMappingRepository: mappingRepo([
        { userId: 'usr_7', slackUserId: 'U7', role: 'engineering' },
        { userId: 'usr_9', slackUserId: 'U9', role: 'product' },
      ]),
      blockRepository: blockRepo('usr_7'), // task created by github user 7
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
    })

    await channel.deliver('ws_1', notification) // merge_review (engineering)
    expect(calls).toHaveLength(1)
    const blocks = JSON.stringify((calls[0]!.body as { blocks: unknown }).blocks)
    expect(blocks).toContain('<@U7>') // the creator
    expect(blocks).not.toContain('<@U9>') // product person is NOT pinged on engineering work
  })

  it('mentions product people AND the creator on a requirement review', async () => {
    const calls = recordChatPost()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo(enabledRoute('#product')),
      slackMemberMappingRepository: mappingRepo([
        { userId: 'usr_7', slackUserId: 'U7', role: 'engineering' }, // the creator
        { userId: 'usr_9', slackUserId: 'U9', role: 'product' },
        { userId: 'usr_10', slackUserId: 'U10', role: 'product' },
      ]),
      blockRepository: blockRepo('usr_7'),
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
    })

    await channel.deliver('ws_1', { ...notification, type: 'requirement_review' })
    expect(calls).toHaveLength(1)
    const blocks = JSON.stringify((calls[0]!.body as { blocks: unknown }).blocks)
    expect(blocks).toContain('<@U9>') // product
    expect(blocks).toContain('<@U10>') // product
    expect(blocks).toContain('<@U7>') // the creator, even though engineering-role
  })

  it('never throws on a delivery failure (best-effort) but surfaces it via onError', async () => {
    // The ingestion POST fails at the network layer; the channel must swallow it.
    agent
      .get(SLACK)
      .intercept({ path: '/api/chat.postMessage', method: 'POST' })
      .replyWithError(new Error('network down'))
    const errors: { error: unknown; context: Record<string, unknown> }[] = []
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo(enabledRoute('#releases')),
      slackMemberMappingRepository: mappingRepo([]),
      blockRepository: blockRepo(null),
      secretCipher: reversingCipher,
      slackClient: new SlackApiClient(),
      onError: (error, context) => errors.push({ error, context }),
    })

    // Best-effort: the lifecycle is never broken...
    await expect(channel.deliver('ws_1', notification)).resolves.toBeUndefined()
    // ...but the swallowed failure is observable, not silently dropped. A network failure on
    // the global fetch surfaces as a `TypeError: fetch failed` carrying the real cause — the
    // exact shape production sees (the old injected-fake error never wrapped this way).
    expect(errors).toHaveLength(1)
    const surfaced = errors[0]!.error as Error
    expect(surfaced.message).toBe('fetch failed')
    expect((surfaced.cause as Error | undefined)?.message).toBe('network down')
    expect(errors[0]!.context).toEqual({
      workspaceId: 'ws_1',
      notificationId: 'ntf_1',
      type: 'merge_review',
    })
  })
})
