import { describe, expect, it } from 'vitest'
import type {
  TaskConnectionRecord,
  TaskConnectionStore,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { ConnectionCredentialsUnreadableError } from '../shared/sealedConnectionStore.js'
import { TaskConnectionService } from './TaskConnectionService.js'
import { JiraProvider } from './JiraProvider.js'
import { MapTaskSourceRegistry } from './tasks.logic.js'

// What each tracker surface does when the connection ROW is there but its sealed credential bag
// will not open — a corrupt envelope, a drifted key, or a mothership-mode node that cannot reach
// the key service holding the org's key.
//
// This is one condition with four different right answers, which is why it is worth a file. The
// store deliberately THROWS rather than answering an empty bag (an empty bag is indistinguishable
// from a connection saved with no credentials), and that raised a second question every caller had
// to answer for itself: a surface whose whole job is to REPAIR this state must not be the surface
// that needs the key, and a read-only panel must not answer a diagnosis with a 500.

/** A store whose row EXISTS (so it lists) but whose bag refuses to open. */
function unopenableStore(upserts: TaskConnectionRecord[]): TaskConnectionStore {
  return {
    getByWorkspace: () =>
      Promise.reject(new ConnectionCredentialsUnreadableError('jira', { cause: new Error('key') })),
    listBySources: async (_ws, sources) =>
      sources.map((source) => ({
        source,
        status: 'unreadable' as const,
        cause: new Error('key'),
      })),
    listSummaries: async () => [
      { workspaceId: 'ws1', source: 'jira', label: 'acme', createdAt: 1 },
    ],
    upsert: async (record) => void upserts.push(record),
    softDelete: async () => {},
  }
}

function makeService(store: TaskConnectionStore, logger = createRecordingLogger()) {
  const service = new TaskConnectionService({
    taskConnectionStore: store,
    taskSourceSettingsRepository: {
      getByWorkspace: async () => [],
      get: async () => null,
      upsert: async () => {},
    },
    registry: new MapTaskSourceRegistry([new JiraProvider() as TaskSourceProvider]),
    workspaceRepository: { get: async () => ({ id: 'ws1' }) } as never,
    clock: { now: () => 99 },
    logger,
  })
  return { service, logger }
}

describe('TaskConnectionService — a connection whose sealed bag will not open', () => {
  it('lets a re-connect LAND, because re-connecting is the remedy for this exact row', async () => {
    // The deadlock this replaced: `store()` opened the old bag to carry the platform-owned webhook
    // secret across a rotation, so the one call that repairs an unopenable connection was also the
    // one call that could not run against it. A workspace had no way out at all.
    const upserts: TaskConnectionRecord[] = []
    const { service, logger } = makeService(unopenableStore(upserts))

    const connection = await service.connect('ws1', 'jira', {
      baseUrl: 'https://acme.atlassian.net',
      accountEmail: 'a@b.test',
      apiToken: 'rotated',
    })

    expect(connection.source).toBe('jira')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]!.credentials.apiToken).toBe('rotated')
    // The loss is REAL and it is STATED: the webhook secret lived inside the bag that would not
    // open, so it could not be carried over. `getWebhookState` reports `configured: false` and the
    // operator mints a fresh one. Silently dropping it is what the warn exists to prevent.
    expect(upserts[0]!.credentials.webhookSecret).toBeUndefined()
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true)
  })

  it('answers the setup check with the fault and its remedy, never a 500', async () => {
    // `diagnose` exists to turn a broken integration into an actionable sentence. A bag that will
    // not open is precisely such a break, so it is a VERDICT here rather than an exception that
    // escapes the check and replaces every classification with a generic failure.
    const { service } = makeService(unopenableStore([]))

    const diagnostic = await service.diagnose('ws1', 'jira')

    expect(diagnostic.ok).toBe(false)
    expect(diagnostic.status).toBe('error')
    expect(diagnostic.message).toContain('re-connect')
  })

  it('states the gap on the read-only webhook panel instead of failing it', async () => {
    const { service } = makeService(unopenableStore([]))

    const state = await service.getWebhookState('ws1', 'jira')

    expect(state.credentialsReadable).toBe(false)
    expect(state.configured).toBe(false)
  })

  it('REFUSES to clear the webhook secret, with a translatable 503 rather than a 500', async () => {
    // The one surface that must not degrade: clearing rewrites the bag minus a key, so proceeding
    // blind would replace the workspace's vendor credentials with an empty object and take polling
    // intake and imports down alongside the webhook.
    const upserts: TaskConnectionRecord[] = []
    const { service } = makeService(unopenableStore(upserts))

    const failure = await service
      .clearWebhookSecret('ws1', 'jira')
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ConnectionCredentialsUnreadableError)
    expect((failure as ConnectionCredentialsUnreadableError).code).toBe('unavailable')
    expect(upserts).toHaveLength(0)
  })

  it('keeps disconnect working, since removing a connection must not need the key', async () => {
    const softDeleted: string[] = []
    const { service } = makeService({
      ...unopenableStore([]),
      softDelete: async (_ws, source) => void softDeleted.push(source),
    })

    await service.disconnect('ws1', 'jira')

    expect(softDeleted).toEqual(['jira'])
  })
})
