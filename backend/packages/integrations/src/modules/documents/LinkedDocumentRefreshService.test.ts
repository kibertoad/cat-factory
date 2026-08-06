import type {
  DocumentCredentials,
  DocumentRecord,
  DocumentSourceProvider,
  GroupCacheHandle,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedDocumentRefreshService } from './LinkedDocumentRefreshService.js'

// The dispatch-time freshness ladder: probe (cached) → compare against the version the stored row was
// imported at → re-import only what moved. What each test pins is a disposition someone downstream
// RENDERS, so a wrong verdict is a lie an agent reads rather than a crash: "confirmed" on a body that
// is actually behind the live page, or a stale-warning on an upload that has no source to trail.

const WS = 'ws_1'

function record(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: WS,
    source: 'figma',
    externalId: 'file1:1-2',
    title: 'Checkout flow',
    url: 'https://figma.com/design/file1',
    excerpt: 'Checkout',
    body: '## Checkout',
    contentHash: 'h1',
    sourceVersion: 'v1',
    linkedBlockId: 'task_1',
    role: null,
    docKind: null,
    syncedAt: 1,
    deletedAt: null,
    ...over,
  }
}

/** A pass-through cache handle: every `get` runs its loader, so the ladder itself is under test. */
function passThroughCache(): GroupCacheHandle<{ version: string }> {
  return {
    get: (_key, _group, load) => load(),
    invalidate: async () => {},
    invalidateGroup: async () => {},
    invalidateAll: async () => {},
  }
}

/** A real one-entry-per-key memo, for asserting that a burst of dispatches costs ONE probe. */
function memoCache(): GroupCacheHandle<{ version: string }> {
  const store = new Map<string, { version: string }>()
  return {
    get: async (key, group, load) => {
      const k = `${group}:${key}`
      const hit = store.get(k)
      if (hit) return hit
      const loaded = await load()
      store.set(k, loaded)
      return loaded
    },
    invalidate: async () => {},
    invalidateGroup: async () => {},
    invalidateAll: async () => {},
  }
}

let probeVersion: ReturnType<typeof vi.fn>
let provider: DocumentSourceProvider
let reimport: ReturnType<typeof vi.fn>
let connected: boolean

function service(over: { versionCache?: GroupCacheHandle<{ version: string }> } = {}) {
  return new LinkedDocumentRefreshService({
    registry: {
      get: (kind) => (kind === 'figma' ? provider : undefined),
      list: () => [provider],
    },
    connectionService: {
      getConnection: async () =>
        connected ? { source: 'figma', label: 'f', connectedAt: 1 } : null,
      requireConnection: async () => ({
        workspaceId: WS,
        source: 'figma' as const,
        credentials: { apiToken: 't' } satisfies DocumentCredentials,
        label: 'f',
        createdAt: 1,
        deletedAt: null,
      }),
    } as never,
    importService: { reimport } as never,
    ...(over.versionCache ? { versionCache: over.versionCache } : {}),
  })
}

beforeEach(() => {
  connected = true
  probeVersion = vi.fn(async () => 'v1')
  reimport = vi.fn(async () => record({ body: '## Checkout (revised)', sourceVersion: 'v2' }))
  provider = { kind: 'figma', probeVersion } as unknown as DocumentSourceProvider
})

describe('LinkedDocumentRefreshService', () => {
  it('confirms without re-importing when the probed version matches the stored one', async () => {
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v1', reimported: false })
    // The whole point of storing the version: an unchanged design costs one cheap probe and no
    // download, which is what makes this affordable on EVERY step dispatch.
    expect(reimport).not.toHaveBeenCalled()
    expect(out?.record.body).toBe('## Checkout')
  })

  it('re-imports and returns the FRESH record when the source has moved', async () => {
    probeVersion.mockResolvedValue('v2')

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(reimport).toHaveBeenCalledWith(WS, 'figma', 'file1:1-2')
    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v2', reimported: true })
    // The refreshed body, not the stored one — the reason the whole feature exists.
    expect(out?.record.body).toBe('## Checkout (revised)')
  })

  it('re-imports a row that records no version at all, so it self-heals once', async () => {
    // Rows imported before the version column existed cannot be proven current, which is the same
    // position as a moved page — and one re-import records the token, so it never repeats.
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ sourceVersion: null }),
    ])

    expect(reimport).toHaveBeenCalledTimes(1)
    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v2', reimported: true })
  })

  it('reports an upload as not-applicable, never as a staleness warning', async () => {
    // An upload has no source to trail, so warning about its freshness would be a fabricated
    // problem — the distinction the `not-applicable` status exists to keep.
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ source: 'upload', externalId: 'doc_1', url: '' }),
    ])

    expect(out?.freshness).toEqual({ status: 'not-applicable' })
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('reports a source with no provider wired as not-applicable', async () => {
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ source: 'notion', externalId: 'n1' }),
    ])

    expect(out?.freshness).toEqual({ status: 'not-applicable' })
  })

  it('names a lost connection distinctly from an unreachable source', async () => {
    connected = false

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    // Two different fixes: reconnect the source vs wait out an outage. Collapsing them would put
    // the wrong remedy in front of whoever reads the note.
    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'not_connected' })
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('names an unreadable connection distinctly from both a missing one and an outage', async () => {
    // The mothership-mode case: the connection repository is db-direct over an absent `db`, so this
    // read fails permanently and by design. Reporting it as `source_unreachable` would send an
    // operator hunting a Figma incident that does not exist.
    const logger = createRecordingLogger()
    const svc = new LinkedDocumentRefreshService({
      registry: { get: () => provider, list: () => [provider] },
      connectionService: {
        getConnection: async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'select')")
        },
        requireConnection: async () => ({ credentials: {} }),
      } as never,
      importService: { reimport } as never,
      versionCache: passThroughCache(),
      logger,
    })

    const [out] = await svc.refresh(WS, [record()])

    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'credentials_unreadable' })
    expect(probeVersion).not.toHaveBeenCalled()
    expect(logger.lines.some((e) => e.level === 'warn')).toBe(true)
  })

  it('reports a source that exposes no version as unversioned, and does not re-import', async () => {
    probeVersion.mockResolvedValue('')

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ sourceVersion: null }),
    ])

    // Not confirmable and not fixable — but claiming "confirmed" here is the one lie the feature
    // must not tell, and re-downloading every dispatch is the cost it must not pay.
    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'unversioned' })
    expect(reimport).not.toHaveBeenCalled()
  })

  it('degrades to the stored body with a logged cause when the probe throws', async () => {
    const logger = createRecordingLogger()
    probeVersion.mockRejectedValue(new Error('figma 429'))
    const svc = new LinkedDocumentRefreshService({
      registry: { get: () => provider, list: () => [provider] },
      connectionService: {
        getConnection: async () => ({ source: 'figma', label: 'f', connectedAt: 1 }),
        requireConnection: async () => ({ credentials: {} }),
      } as never,
      importService: { reimport } as never,
      versionCache: passThroughCache(),
      logger,
    })

    const [out] = await svc.refresh(WS, [record()])

    // A source outage costs the run a stale body and a stated warning, NEVER the run.
    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
    expect(out?.record.body).toBe('## Checkout')
    expect(
      logger.lines.some((e) => e.level === 'warn' && String(e.fields?.err).includes('figma 429')),
    ).toBe(true)
  })

  it('probes each document ONCE across a run’s repeated dispatches', async () => {
    // The cost model: linked context re-resolves per STEP, so without the cache a ten-step pipeline
    // would probe every attachment ten times.
    const svc = service({ versionCache: memoCache() })

    await svc.refresh(WS, [record()])
    await svc.refresh(WS, [record()])
    await svc.refresh(WS, [record()])

    expect(probeVersion).toHaveBeenCalledTimes(1)
  })

  it('returns one verdict per input, in input order', async () => {
    const out = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ externalId: 'a' }),
      record({ source: 'upload', externalId: 'b', url: '' }),
      record({ externalId: 'c' }),
    ])

    // The port promises a zippable result: a caller pairs these back onto the list it passed.
    expect(out.map((o) => o.record.externalId)).toEqual(['a', 'b', 'c'])
  })
})
