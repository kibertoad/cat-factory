import type {
  DocumentConnectionRecord,
  DocumentCredentials,
  DocumentRecord,
  DocumentSourceKind,
  DocumentSourceProvider,
  GroupCacheHandle,
  LinkedDocumentRefreshOutcome,
  OperationalCounter,
  OperationalDimensions,
} from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedDocumentRefreshService } from './LinkedDocumentRefreshService.js'

// The dispatch-time freshness ladder: probe (cached) → compare against the version the stored row was
// imported at → re-import only what moved. What each test pins is a disposition someone downstream
// RENDERS, so a wrong verdict is a lie an agent reads rather than a crash: "confirmed" on a body that
// is actually behind the live page, or a stale-warning on an upload that has no source to trail.
//
// The other half is the COST MODEL, which is not a nice-to-have here: this runs on every step
// dispatch of every run, so an unbounded fan-out, a re-read per document, or a failure that is not
// remembered are each a way for one linked design to multiply into a source's rate limit.

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
function passThroughCache(): GroupCacheHandle<LinkedDocumentRefreshOutcome> {
  return {
    get: (_key, _group, load) => load(),
    invalidate: async () => {},
    invalidateGroup: async () => {},
    invalidateAll: async () => {},
  }
}

/** A real one-entry-per-key memo, for asserting that a burst of dispatches costs ONE round trip. */
function memoCache(): GroupCacheHandle<LinkedDocumentRefreshOutcome> {
  const store = new Map<string, LinkedDocumentRefreshOutcome>()
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

function connectionRecord(source: DocumentSourceKind = 'figma'): DocumentConnectionRecord {
  return {
    workspaceId: WS,
    source,
    credentials: { apiToken: 't' } satisfies DocumentCredentials,
    label: 'f',
    createdAt: 1,
    deletedAt: null,
  }
}

let probeVersion: ReturnType<typeof vi.fn>
let provider: DocumentSourceProvider
let reimport: ReturnType<typeof vi.fn>
let requireDocument: ReturnType<typeof vi.fn>
let resolveConnections: ReturnType<typeof vi.fn>
let counted: { counter: OperationalCounter; dimensions?: OperationalDimensions }[]

function service(
  over: {
    versionCache?: GroupCacheHandle<LinkedDocumentRefreshOutcome>
    logger?: ReturnType<typeof createRecordingLogger>
  } = {},
) {
  return new LinkedDocumentRefreshService({
    registry: {
      get: (kind) => (kind === 'figma' ? provider : undefined),
      list: () => [provider],
    },
    connectionService: { resolveConnections } as never,
    importService: { reimport, requireDocument } as never,
    metrics: { increment: (counter, dimensions) => counted.push({ counter, dimensions }) },
    ...(over.versionCache ? { versionCache: over.versionCache } : {}),
    ...(over.logger ? { logger: over.logger } : {}),
  })
}

beforeEach(() => {
  counted = []
  probeVersion = vi.fn(async () => 'v1')
  reimport = vi.fn(async () => record({ body: '## Checkout (revised)', sourceVersion: 'v2' }))
  requireDocument = vi.fn(async () => record())
  resolveConnections = vi.fn(
    async (_ws: string, sources: readonly DocumentSourceKind[]) =>
      new Map(sources.map((source) => [source, connectionRecord(source)])),
  )
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

    expect(reimport).toHaveBeenCalledWith(WS, 'figma', 'file1:1-2', { fallbackVersion: 'v2' })
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

  it('CONVERGES on a provider whose fetch exposes no version but whose probe does', async () => {
    // The loop this closes: GitHub docs resolve their commit sha best-effort inside `fetchDocument`
    // (a rate-limited request degrades it to null) while `probeVersion` still answers. A row left
    // holding null mismatches the probe on EVERY future dispatch, so the whole document is
    // re-downloaded forever and the note claims `unversioned` about a source that plainly versions.
    // The fix is that the refresh hands the probed token down as the version to record.
    const stored: { version: string | null } = { version: null }
    probeVersion.mockResolvedValue('sha-abc')
    reimport = vi.fn(async (_ws, _source, _id, opts?: { fallbackVersion?: string }) => {
      stored.version = opts?.fallbackVersion ?? null
      return record({ sourceVersion: stored.version })
    })

    const svc = service({ versionCache: passThroughCache() })
    const [first] = await svc.refresh(WS, [record({ sourceVersion: null })])
    const [second] = await svc.refresh(WS, [record({ sourceVersion: stored.version })])

    expect(first?.freshness).toEqual({ status: 'confirmed', version: 'sha-abc', reimported: true })
    // The second dispatch is the assertion that matters: nothing re-downloaded, and no false
    // `unversioned` note about a source that exposes a token.
    expect(second?.freshness).toEqual({
      status: 'confirmed',
      version: 'sha-abc',
      reimported: false,
    })
    expect(reimport).toHaveBeenCalledTimes(1)
  })

  it('reports an upload as not-applicable, never as a staleness warning', async () => {
    // An upload has no source to trail, so warning about its freshness would be a fabricated
    // problem — the distinction the `not-applicable` status exists to keep.
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ source: 'upload', externalId: 'doc_1', url: '' }),
    ])

    expect(out?.freshness).toEqual({ status: 'not-applicable' })
    expect(probeVersion).not.toHaveBeenCalled()
    expect(counted).toEqual([])
  })

  it('reports a source with no provider wired as not-applicable', async () => {
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ source: 'notion', externalId: 'n1' }),
    ])

    expect(out?.freshness).toEqual({ status: 'not-applicable' })
  })

  it('names a lost connection distinctly from an unreachable source', async () => {
    resolveConnections.mockResolvedValue(new Map([['figma', null]]))

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
    resolveConnections.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'select')"),
    )

    const [out] = await service({ versionCache: passThroughCache(), logger }).refresh(WS, [
      record(),
    ])

    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'credentials_unreadable' })
    expect(probeVersion).not.toHaveBeenCalled()
    // INFO, not `warn`: permanent by design on such a node, on every dispatch of every run, with no
    // remedy anyone intends to apply. The counter below is what carries the rate instead.
    expect(logger.lines.some((e) => e.level === 'warn')).toBe(false)
    expect(logger.lines.some((e) => e.level === 'info')).toBe(true)
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

    const [out] = await service({ versionCache: passThroughCache(), logger }).refresh(WS, [
      record(),
    ])

    // A source outage costs the run a stale body and a stated warning, NEVER the run.
    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
    expect(out?.record.body).toBe('## Checkout')
    expect(
      logger.lines.some((e) => e.level === 'warn' && String(e.fields?.err).includes('figma 429')),
    ).toBe(true)
  })

  it('counts every gap, dimensioned by the reason and the source', async () => {
    // The log line answers "what happened to this run"; only the counter answers "is this rising",
    // which is the question an operator has when half the deployment starts building from stale
    // designs. The reason split is what separates the different remedies.
    probeVersion.mockRejectedValue(new Error('figma 403'))

    await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(counted).toEqual([
      {
        counter: 'document.freshness_gap',
        dimensions: { reason: 'source_unreachable', source: 'figma' },
      },
    ])
  })

  it('asks the source ONCE across a run’s repeated dispatches', async () => {
    // The cost model: linked context re-resolves per STEP, so without the cache a ten-step pipeline
    // would probe every attachment ten times.
    const svc = service({ versionCache: memoCache() })

    await svc.refresh(WS, [record()])
    await svc.refresh(WS, [record()])
    await svc.refresh(WS, [record()])

    expect(probeVersion).toHaveBeenCalledTimes(1)
  })

  it('REMEMBERS an unreachable source instead of re-asking it on every dispatch', async () => {
    // Without this, a 429 during one dispatch is re-attempted (probe AND whole-file import) by the
    // next step's dispatch, and the next, sustaining the rate limit for the whole run — which is
    // the opposite of what a cache in front of the ladder is for.
    probeVersion.mockRejectedValue(new Error('figma 429'))
    const svc = service({ versionCache: memoCache() })

    const [first] = await svc.refresh(WS, [record()])
    const [second] = await svc.refresh(WS, [record()])

    expect(first?.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
    expect(second?.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
    expect(probeVersion).toHaveBeenCalledTimes(1)
  })

  it('resolves the workspace connection ONCE for a whole corpus, not once per document', async () => {
    // The connection is invariant per (workspace, source) for the entire pass, and this runs per
    // step dispatch: reading it per document turns one linked corpus into an N+1 that the version
    // cache does not cover, because it sits in front of the probe rather than of the read.
    await service({ versionCache: passThroughCache() }).refresh(WS, [
      record({ externalId: 'a' }),
      record({ externalId: 'b' }),
      record({ externalId: 'c' }),
      record({ source: 'upload', externalId: 'd', url: '' }),
    ])

    expect(resolveConnections).toHaveBeenCalledTimes(1)
    // The upload contributes no source to resolve: an unconnectable origin is never asked about.
    expect(resolveConnections).toHaveBeenCalledWith(WS, ['figma'])
  })

  it('bounds how many documents it asks about at a time', async () => {
    // A task may attach a whole corpus budget's worth of Figma frames, and each miss fans out into
    // chunked per-frame node reads: unbounded, one dispatch becomes that many concurrent whole-file
    // imports at a source that answers 429 well before it finishes them.
    let live = 0
    let peak = 0
    probeVersion.mockImplementation(async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 1))
      live -= 1
      return 'v1'
    })
    const documents = Array.from({ length: 24 }, (_, i) => record({ externalId: `f${i}` }))

    await service({ versionCache: passThroughCache() }).refresh(WS, documents)

    expect(probeVersion).toHaveBeenCalledTimes(24)
    expect(peak).toBeLessThan(documents.length)
  })

  it('re-reads the row when a concurrent dispatch re-imported behind a cached outcome', async () => {
    // Two dispatches sharing one document dedupe onto a single ladder run, so only ONE of them
    // holds the re-imported record; the other's corpus read predates the write. Labelling that
    // stale body with the fresh revision is exactly the lie the feature exists to prevent.
    probeVersion.mockResolvedValue('v2')
    requireDocument.mockResolvedValue(
      record({ body: '## Checkout (revised)', sourceVersion: 'v2' }),
    )
    const cache = memoCache()
    const svc = service({ versionCache: cache })

    await svc.refresh(WS, [record()])
    const [second] = await svc.refresh(WS, [record()])

    expect(reimport).toHaveBeenCalledTimes(1)
    expect(requireDocument).toHaveBeenCalledWith(WS, 'figma', 'file1:1-2')
    expect(second?.record.body).toBe('## Checkout (revised)')
    expect(second?.freshness).toEqual({ status: 'confirmed', version: 'v2', reimported: true })
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
