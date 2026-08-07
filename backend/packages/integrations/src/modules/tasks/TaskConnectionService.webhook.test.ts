import { describe, expect, it } from 'vitest'
import type {
  TaskConnectionRecord,
  TaskConnectionStore,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { TaskConnectionService, trackerWebhookPath } from './TaskConnectionService.js'
import { JiraProvider } from './JiraProvider.js'
import { MapTaskSourceRegistry } from './tasks.logic.js'

// The inbound-webhook configuration surface: mint / read / clear the per-connection secret that
// authenticates a tracker's deliveries.
//
// The case worth the most here is the LAST one. The secret rides the connection's existing sealed
// credential bag — which needs no table and no second lifecycle, but does mean the bag a provider
// returns from `normalizeConnection` would replace it wholesale on a credential rotation. That
// failure is silent (deliveries just start 503-ing), so it gets a pinned test rather than a
// comment.

function makeService(
  seed: TaskConnectionRecord[] = [],
  /** Override a store method, to stand in for a bag this deployment cannot open. */
  storeOverrides: Partial<TaskConnectionStore> = {},
) {
  const rows = new Map(seed.map((r) => [`${r.workspaceId}:${r.source}`, r]))
  // Faked at the STORE level: these cases are about the webhook secret's read-modify-write, and
  // the sealing itself has its own unit test (`sealedConnectionStore.test.ts`).
  const taskConnectionStore: TaskConnectionStore = {
    getByWorkspace: async (workspaceId, source) => rows.get(`${workspaceId}:${source}`) ?? null,
    listBySources: async (workspaceId, sources) =>
      sources.flatMap((source) => {
        const row = rows.get(`${workspaceId}:${source}`)
        return row ? [{ source, status: 'opened' as const, connection: row }] : []
      }),
    listSummaries: async (workspaceId) =>
      [...rows.values()]
        .filter((r) => r.workspaceId === workspaceId)
        .map(({ workspaceId: ws, source, label, createdAt }) => ({
          workspaceId: ws,
          source,
          label,
          createdAt,
        })),
    upsert: async (record) => {
      rows.set(`${record.workspaceId}:${record.source}`, record)
    },
    softDelete: async () => {},
    ...storeOverrides,
  }
  const service = new TaskConnectionService({
    taskConnectionStore,
    taskSourceSettingsRepository: {
      getByWorkspace: async () => [],
      get: async () => null,
      upsert: async () => {},
    },
    registry: new MapTaskSourceRegistry([new JiraProvider() as TaskSourceProvider]),
    workspaceRepository: { get: async () => ({ id: 'ws1' }) } as never,
    clock: { now: () => 1 },
  })
  return { service, rows }
}

const connected: TaskConnectionRecord = {
  workspaceId: 'ws1',
  source: 'jira',
  credentials: {
    baseUrl: 'https://acme.atlassian.net',
    accountEmail: 'ada@acme.test',
    apiToken: 'token-1',
  },
  label: 'acme',
  createdAt: 1,
  deletedAt: null,
}

describe('TaskConnectionService — inbound webhook configuration', () => {
  it('reports the delivery path before a secret exists, so an operator can see where it goes', async () => {
    const { service } = makeService([connected])
    const state = await service.getWebhookState('ws1', 'jira')
    expect(state).toEqual({
      source: 'jira',
      supported: true,
      configured: false,
      deliveryPath: trackerWebhookPath('ws1', 'jira'),
      replyAllow: '',
      // The bag opened, so `configured: false` is an observed fact rather than a safe default.
      credentialsReadable: true,
    })
  })

  it('states an unopenable bag instead of failing the panel that exists to diagnose it', async () => {
    // A read-only settings panel is the one surface that may not 503 on this: it is where someone
    // lands to find out what is wrong. `credentialsReadable` is what stops the reported
    // `configured: false` reading as "no secret minted yet" and sending them to mint one OVER a
    // bag that still holds the live secret.
    const { service } = makeService([connected], {
      getByWorkspace: () => Promise.reject(new Error('cannot open')),
    })

    const state = await service.getWebhookState('ws1', 'jira')

    expect(state).toMatchObject({
      supported: true,
      configured: false,
      credentialsReadable: false,
      deliveryPath: trackerWebhookPath('ws1', 'jira'),
    })
  })

  it('mints a secret ONCE and never echoes it back on a read', async () => {
    // The one-shot contract is what forces rotation rather than retrieval — a secret a surface
    // hands out again is a secret nobody ever has to rotate.
    const { service } = makeService([connected])
    const minted = await service.mintWebhookSecret('ws1', 'jira')
    expect(minted.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(minted.configured).toBe(true)

    const read = await service.getWebhookState('ws1', 'jira')
    expect(read.configured).toBe(true)
    expect(read).not.toHaveProperty('secret')
  })

  it('rotates to a NEW secret, invalidating the old one immediately', async () => {
    const { service } = makeService([connected])
    const first = await service.mintWebhookSecret('ws1', 'jira')
    const second = await service.mintWebhookSecret('ws1', 'jira')
    expect(second.secret).not.toBe(first.secret)
  })

  it('stores the reply allow-list alongside the secret', async () => {
    const { service } = makeService([connected])
    await service.mintWebhookSecret('ws1', 'jira', { replyAllow: ' ada@acme.test, bob ' })
    expect((await service.getWebhookState('ws1', 'jira')).replyAllow).toBe('ada@acme.test, bob')
  })

  it('refuses to mint for a source with no webhook capability', async () => {
    // The guard is the provider's `webhook` being absent — the same thing the receiver resolves,
    // so the surface can never offer a secret for deliveries that would 404 on arrival.
    const bare = { ...new JiraProvider(), webhook: undefined } as unknown as TaskSourceProvider
    const svc = new TaskConnectionService({
      taskConnectionStore: {
        getByWorkspace: async () => connected,
        listBySources: async () => [
          { source: connected.source, status: 'opened' as const, connection: connected },
        ],
        listSummaries: async () => [connected],
        upsert: async () => {},
        softDelete: async () => {},
      },
      taskSourceSettingsRepository: {
        getByWorkspace: async () => [],
        get: async () => null,
        upsert: async () => {},
      },
      registry: new MapTaskSourceRegistry([bare]),
      workspaceRepository: { get: async () => ({ id: 'ws1' }) } as never,
      clock: { now: () => 1 },
    })
    await expect(svc.mintWebhookSecret('ws1', 'jira')).rejects.toThrow(/does not accept inbound/)
    expect((await svc.getWebhookState('ws1', 'jira')).supported).toBe(false)
  })

  it('clearing the secret leaves the vendor credentials — and the connection — intact', async () => {
    const { service, rows } = makeService([connected])
    await service.mintWebhookSecret('ws1', 'jira')
    await service.clearWebhookSecret('ws1', 'jira')

    expect((await service.getWebhookState('ws1', 'jira')).configured).toBe(false)
    expect(rows.get('ws1:jira')?.credentials.apiToken).toBe('token-1')
  })

  it('edits the reply allow-list WITHOUT rotating the secret', async () => {
    // Tightening the allow-list is what an operator does when a tracker turns out to be more
    // public than they thought. If that rotated the secret as a side effect, the tracker's
    // configured webhook would start failing until they re-pasted it — a security control that
    // costs an outage is one people learn not to touch.
    const { service, rows } = makeService([connected])
    const minted = await service.mintWebhookSecret('ws1', 'jira')

    const state = await service.updateWebhookReplyAllow('ws1', 'jira', '  ada, grace  ')
    expect(state).toMatchObject({ configured: true, replyAllow: 'ada, grace' })
    // The stored secret is untouched, so a delivery signed with what the operator already pasted
    // into the tracker keeps verifying.
    expect(rows.get('ws1:jira')?.credentials.webhookSecret).toBe(minted.secret)
    expect(rows.get('ws1:jira')?.credentials.apiToken).toBe('token-1')
  })

  it('PRESERVES the webhook secret across a credential rotation', async () => {
    // The silent failure this exists to stop: `connect` replaces the whole credential bag with the
    // one the provider's `normalizeConnection` returns, which carries only VENDOR credentials. So
    // rotating a Jira API token would drop the webhook secret, and every subsequent delivery would
    // 503 with nothing pointing at the cause.
    const { service, rows } = makeService([connected])
    const minted = await service.mintWebhookSecret('ws1', 'jira', { replyAllow: 'ada' })

    await service.connect('ws1', 'jira', {
      baseUrl: 'https://acme.atlassian.net',
      accountEmail: 'ada@acme.test',
      apiToken: 'token-2',
    })

    expect(rows.get('ws1:jira')?.credentials.apiToken).toBe('token-2')
    expect(rows.get('ws1:jira')?.credentials.webhookSecret).toBe(minted.secret)
    const state = await service.getWebhookState('ws1', 'jira')
    expect(state.configured).toBe(true)
    expect(state.replyAllow).toBe('ada')
  })
})
