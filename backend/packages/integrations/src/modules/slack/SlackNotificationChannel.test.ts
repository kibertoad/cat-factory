import type {
  Membership,
  MembershipRepository,
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
import { describe, expect, it } from 'vitest'
import { SlackApiClient } from './SlackApiClient.js'
import { SlackNotificationChannel } from './SlackNotificationChannel.js'

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

function membershipRepo(members: Membership[]): MembershipRepository {
  return {
    listByAccount: async () => members,
    listByUser: async () => [],
    get: async () => null,
    upsert: async () => {},
    remove: async () => {},
  }
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

/** A SlackApiClient over a fetch stub that records the chat.postMessage call. */
function recordingClient() {
  const calls: { url: string; token: string; body: unknown }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(url),
      token: (headers.authorization ?? '').replace('Bearer ', ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    return { json: async () => ({ ok: true }) } as Response
  }) as unknown as typeof fetch
  return { client: new SlackApiClient({ fetchImpl }), calls }
}

describe('SlackNotificationChannel', () => {
  it('posts to the routed channel with the decrypted token', async () => {
    const { client, calls } = recordingClient()
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
      membershipRepository: membershipRepo([]),
      secretCipher: reversingCipher,
      slackClient: client,
    })

    await channel.deliver('ws_1', notification)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('chat.postMessage')
    expect(calls[0]!.token).toBe('tokn-xxx')
    expect((calls[0]!.body as { channel: string }).channel).toBe('#releases')
  })

  it('does not post when the type is disabled or unrouted', async () => {
    const { client, calls } = recordingClient()
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
      membershipRepository: membershipRepo([]),
      secretCipher: reversingCipher,
      slackClient: client,
    })

    await channel.deliver('ws_1', notification)
    expect(calls).toHaveLength(0)
  })

  it('does not post when the account has no Slack connection', async () => {
    const { client, calls } = recordingClient()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(null),
      slackSettingsRepository: settingsRepo({
        workspaceId: 'ws_1',
        routesJson: JSON.stringify({ merge_review: { enabled: true, channel: '#releases' } }),
        mentionsEnabled: false,
        updatedAt: 0,
      }),
      slackMemberMappingRepository: mappingRepo([]),
      membershipRepository: membershipRepo([]),
      secretCipher: reversingCipher,
      slackClient: client,
    })

    await channel.deliver('ws_1', notification)
    expect(calls).toHaveLength(0)
  })

  it('tags mapped account members when mentions are enabled', async () => {
    const { client, calls } = recordingClient()
    const channel = new SlackNotificationChannel({
      workspaceRepository: workspaceRepo('acc_1'),
      slackConnectionRepository: connectionRepo(connection),
      slackSettingsRepository: settingsRepo({
        workspaceId: 'ws_1',
        routesJson: JSON.stringify({ merge_review: { enabled: true, channel: '#releases' } }),
        mentionsEnabled: true,
        updatedAt: 0,
      }),
      slackMemberMappingRepository: mappingRepo([
        { githubUserId: 7, slackUserId: 'U7' },
        { githubUserId: 9, slackUserId: 'U9' },
      ]),
      membershipRepository: membershipRepo([
        { accountId: 'acc_1', userId: 7, role: 'owner', createdAt: 0 },
        { accountId: 'acc_1', userId: 42, role: 'member', createdAt: 0 }, // unmapped → skipped
      ]),
      secretCipher: reversingCipher,
      slackClient: client,
    })

    await channel.deliver('ws_1', notification)
    expect(calls).toHaveLength(1)
    const blocks = JSON.stringify((calls[0]!.body as { blocks: unknown }).blocks)
    expect(blocks).toContain('<@U7>')
    expect(blocks).not.toContain('<@U9>') // U9 is mapped but not an account member
    expect(blocks).not.toContain('<@42>')
  })

  it('never throws on a delivery failure (best-effort) but surfaces it via onError', async () => {
    const throwingClient = new SlackApiClient({
      fetchImpl: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    })
    const errors: { error: unknown; context: Record<string, unknown> }[] = []
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
      membershipRepository: membershipRepo([]),
      secretCipher: reversingCipher,
      slackClient: throwingClient,
      onError: (error, context) => errors.push({ error, context }),
    })

    // Best-effort: the lifecycle is never broken...
    await expect(channel.deliver('ws_1', notification)).resolves.toBeUndefined()
    // ...but the swallowed failure is observable, not silently dropped.
    expect(errors).toHaveLength(1)
    expect((errors[0]!.error as Error).message).toBe('network down')
    expect(errors[0]!.context).toEqual({
      workspaceId: 'ws_1',
      notificationId: 'ntf_1',
      type: 'merge_review',
    })
  })
})
