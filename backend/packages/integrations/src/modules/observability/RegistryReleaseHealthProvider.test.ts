import { describe, expect, it } from 'vitest'
import type {
  Block,
  BlockRepository,
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  ReleaseHealthConfigRecord,
  ReleaseHealthConfigRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { RegistryReleaseHealthProvider } from './RegistryReleaseHealthProvider.js'
import { defaultObservabilityRegistry } from './registry.js'

// A SecretCipher whose envelope is just the plaintext (the provider only decrypts here).
const identityCipher: SecretCipher = {
  encrypt: async (s) => s,
  decrypt: async (s) => s,
}

// A Datadog connection whose sealed `credentials` blob is just the plaintext JSON.
const connection: ObservabilityConnectionRecord = {
  workspaceId: 'ws',
  provider: 'datadog',
  credentials: JSON.stringify({ site: 'datadoghq.com', apiKey: 'k', appKey: 'a' }),
  summary: JSON.stringify({ site: 'datadoghq.com' }),
  createdAt: 0,
  updatedAt: 0,
}

function makeProvider(
  config: ReleaseHealthConfigRecord | null,
  monitorState: string,
  monitorStateModified?: string,
): RegistryReleaseHealthProvider {
  const connectionRepo: ObservabilityConnectionRepository = {
    get: async () => connection,
    upsert: async () => {},
    delete: async () => {},
  }
  const configRepo: ReleaseHealthConfigRepository = {
    getByBlock: async (_ws, blockId) => (config && config.blockId === blockId ? config : null),
    listByWorkspace: async () => (config ? [config] : []),
    upsert: async () => {},
    delete: async () => {},
  }
  const blockRepo = {
    get: async (_ws: string, id: string): Promise<Block | null> =>
      ({ id, parentId: null }) as Block,
  } as unknown as BlockRepository

  // Fake Datadog: every monitor returns `monitorState` (+ optional last-change time).
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        name: 'errors',
        overall_state: monitorState,
        ...(monitorStateModified ? { overall_state_modified: monitorStateModified } : {}),
      }),
      { status: 200 },
    )) as unknown as typeof fetch

  return new RegistryReleaseHealthProvider({
    observabilityConnectionRepository: connectionRepo,
    releaseHealthConfigRepository: configRepo,
    blockRepository: blockRepo,
    secretCipher: identityCipher,
    registry: defaultObservabilityRegistry,
    fetchImpl,
  })
}

const config: ReleaseHealthConfigRecord = {
  workspaceId: 'ws',
  blockId: 'blk',
  monitorIds: ['123'],
  sloIds: [],
  envTag: 'prod',
  createdAt: 0,
  updatedAt: 0,
}

describe('RegistryReleaseHealthProvider.probe (Datadog adapter)', () => {
  it('returns healthy with no signals when the block has no config (gate passes through)', async () => {
    const provider = makeProvider(null, 'OK')
    const report = await provider.probe('ws', 'blk', Date.now())
    expect(report.status).toBe('healthy')
    expect(report.signals).toHaveLength(0)
  })

  it('reports healthy when the monitor is OK', async () => {
    const provider = makeProvider(config, 'OK')
    const report = await provider.probe('ws', 'blk', Date.now())
    expect(report.status).toBe('healthy')
    expect(report.signals[0]!.state).toBe('ok')
  })

  it('reports regressed when the monitor is alerting', async () => {
    const provider = makeProvider(config, 'Alert')
    const report = await provider.probe('ws', 'blk', Date.now())
    expect(report.status).toBe('regressed')
    expect(report.signals[0]!.state).toBe('alert')
  })

  it('reports regressed when the alert started AFTER the release marker', async () => {
    const since = Date.parse('2026-06-24T12:00:00Z')
    const provider = makeProvider(config, 'Alert', '2026-06-24T12:05:00Z')
    const report = await provider.probe('ws', 'blk', since)
    expect(report.status).toBe('regressed')
    expect(report.signals[0]!.state).toBe('alert')
  })

  it('does NOT regress on a pre-existing alert that started before the release marker', async () => {
    const since = Date.parse('2026-06-24T12:00:00Z')
    // Monitor went into alert 5 minutes BEFORE this release shipped — an unrelated/flaky
    // incident, not attributable to this PR; the gate must not escalate on-call.
    const provider = makeProvider(config, 'Alert', '2026-06-24T11:55:00Z')
    const report = await provider.probe('ws', 'blk', since)
    expect(report.status).toBe('healthy')
    expect(report.signals[0]!.state).toBe('warn')
  })

  it('reports pending when the monitor has no data yet', async () => {
    const provider = makeProvider(config, 'No Data')
    const report = await provider.probe('ws', 'blk', Date.now())
    expect(report.status).toBe('pending')
  })

  it('rejects a malformed credentials blob at the registry boundary', async () => {
    const badConnection: ObservabilityConnectionRecord = {
      ...connection,
      // A drifted/corrupted blob missing the required keys.
      credentials: JSON.stringify({ site: 'datadoghq.com' }),
    }
    const provider = new RegistryReleaseHealthProvider({
      observabilityConnectionRepository: {
        get: async () => badConnection,
        upsert: async () => {},
        delete: async () => {},
      },
      releaseHealthConfigRepository: {
        getByBlock: async (_ws, blockId) => (config.blockId === blockId ? config : null),
        listByWorkspace: async () => [config],
        upsert: async () => {},
        delete: async () => {},
      },
      blockRepository: {
        get: async (_ws: string, id: string): Promise<Block | null> =>
          ({ id, parentId: null }) as Block,
      } as unknown as BlockRepository,
      secretCipher: identityCipher,
      registry: defaultObservabilityRegistry,
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    })
    await expect(provider.probe('ws', 'blk', Date.now())).rejects.toThrow()
  })
})
