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
    renderStatus: null,
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
    // A REAL invalidate, because the manual-refresh path is defined by dropping the entry before
    // it asks: a no-op here would pass that test for the wrong reason.
    invalidate: async (key, group) => {
      store.delete(`${group}:${key}`)
    },
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
  reimport = vi.fn(async () =>
    record({ body: '## Checkout (revised)', contentHash: 'h2', sourceVersion: 'v2' }),
  )
  requireDocument = vi.fn(async () => record())
  resolveConnections = vi.fn(
    async (_ws: string, sources: readonly DocumentSourceKind[]) =>
      new Map(
        sources.map((source) => [
          source,
          { status: 'connected', connection: connectionRecord(source) },
        ]),
      ),
  )
  provider = { kind: 'figma', probeVersion } as unknown as DocumentSourceProvider
})

describe('LinkedDocumentRefreshService', () => {
  it('confirms without re-importing when the probed version matches the stored one', async () => {
    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v1', change: 'unchanged' })
    // The whole point of storing the version: an unchanged design costs one cheap probe and no
    // download, which is what makes this affordable on EVERY step dispatch.
    expect(reimport).not.toHaveBeenCalled()
    expect(out?.record.body).toBe('## Checkout')
  })

  it('re-imports and returns the FRESH record when the source has moved', async () => {
    probeVersion.mockResolvedValue('v2')

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(reimport).toHaveBeenCalledWith(WS, 'figma', 'file1:1-2', { fallbackVersion: 'v2' })
    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v2', change: 'reimported' })
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
    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v2', change: 'reimported' })
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
      // A distinct hash keeps this test about CONVERGENCE: a fetch that also rewrote the body is
      // the case where the recorded token has to stick, and the `revision_only` classification has
      // its own test below rather than riding along here.
      return record({ contentHash: 'h2', sourceVersion: stored.version })
    })

    const svc = service({ versionCache: passThroughCache() })
    const [first] = await svc.refresh(WS, [record({ sourceVersion: null })])
    const [second] = await svc.refresh(WS, [record({ sourceVersion: stored.version })])

    expect(first?.freshness).toEqual({
      status: 'confirmed',
      version: 'sha-abc',
      change: 'reimported',
    })
    // The second dispatch is the assertion that matters: nothing re-downloaded, and no false
    // `unversioned` note about a source that exposes a token.
    expect(second?.freshness).toEqual({
      status: 'confirmed',
      version: 'sha-abc',
      change: 'unchanged',
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
    resolveConnections.mockResolvedValue(new Map([['figma', { status: 'not_connected' }]]))

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    // Two different fixes: reconnect the source vs wait out an outage. Collapsing them would put
    // the wrong remedy in front of whoever reads the note.
    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'not_connected' })
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('names an unreadable connection distinctly from both a missing one and an outage', async () => {
    // A corrupt envelope, a drifted key, or a mothership that could not be reached to open the row.
    // Reporting any of them as `source_unreachable` would send an operator hunting a Figma incident
    // that does not exist.
    const logger = createRecordingLogger()
    resolveConnections.mockResolvedValue(
      new Map([
        [
          'figma',
          {
            status: 'unreadable',
            cause: new Error('the stored figma credentials are not valid JSON'),
          },
        ],
      ]),
    )

    const [out] = await service({ versionCache: passThroughCache(), logger }).refresh(WS, [
      record(),
    ])

    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'credentials_unreadable' })
    expect(probeVersion).not.toHaveBeenCalled()
    // WARN, because there is now always something to fix. It was `info` while a mothership-mode
    // node failed this permanently and by design (its connection repository decrypted inside, so it
    // stayed db-direct over an absent `db`); with the row sealed and openable over the machine API,
    // every remaining cause is a real fault.
    expect(logger.lines.some((e) => e.level === 'warn')).toBe(true)
  })

  it('marks every source unreadable only when the READ ITSELF failed, not one bad bag', async () => {
    // The stored-row query precedes every open, so its failure means nothing was learned about any
    // source and the whole set is honestly unknown. That is the ONLY remaining path to a
    // corpus-wide verdict: a single unopenable bag is confined to its own source above.
    const logger = createRecordingLogger()
    resolveConnections.mockRejectedValue(new Error('persistence RPC unreachable'))

    const [out] = await service({ versionCache: passThroughCache(), logger }).refresh(WS, [
      record(),
    ])

    expect(out?.freshness).toEqual({ status: 'unconfirmed', reason: 'credentials_unreadable' })
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
    // next step's dispatch, and the next, sustaining the rate limit for the whole run, which is
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
      record({ body: '## Checkout (revised)', contentHash: 'h2', sourceVersion: 'v2' }),
    )
    const cache = memoCache()
    const svc = service({ versionCache: cache })

    await svc.refresh(WS, [record()])
    const [second] = await svc.refresh(WS, [record()])

    expect(reimport).toHaveBeenCalledTimes(1)
    expect(requireDocument).toHaveBeenCalledWith(WS, 'figma', 'file1:1-2')
    expect(second?.record.body).toBe('## Checkout (revised)')
    expect(second?.freshness).toEqual({ status: 'confirmed', version: 'v2', change: 'reimported' })
  })

  it('calls a moved TOKEN with an unmoved body revision_only, never a re-import', async () => {
    // The normal case for a whole-file source: a Figma file's version bumps on any edit anywhere in
    // it, so a document covering one frame routinely sees a newer revision with not one byte a
    // reader sees different. Collapsing that into `reimported` would tell a person their own edit
    // had landed when it may be in a frame this document does not cover. It is the same class of lie as
    // calling a stale copy confirmed, pointing the other way.
    probeVersion.mockResolvedValue('v2')
    reimport.mockResolvedValue(record({ sourceVersion: 'v2' }))

    const [out] = await service({ versionCache: passThroughCache() }).refresh(WS, [record()])

    expect(out?.freshness).toEqual({ status: 'confirmed', version: 'v2', change: 'revision_only' })
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

  describe('refreshNow (a person asked, not a dispatch)', () => {
    it('answers with the stored projection AND the verdict about it', async () => {
      // The stored row is at v1 and the page has moved on, which is the case the action exists
      // for: a designer edited the frame and wants the board to be holding that edit.
      probeVersion.mockResolvedValue('v2')
      reimport.mockResolvedValue(record({ sourceVersion: 'v2', title: 'Checkout v2' }))

      const out = await service({ versionCache: memoCache() }).refreshNow(WS, 'figma', 'file1:1-2')

      // Both halves: the row a surface re-renders, and the only thing that says whether it was
      // confirmed current. The same row under a `confirmed` and an `unconfirmed` verdict is
      // identical bytes and opposite facts.
      expect(out.document.title).toBe('Checkout v2')
      expect(out.freshness).toEqual({ status: 'confirmed', version: 'v2', change: 'reimported' })
    })

    it('does NOT count a person\u2019s gap against the dispatch-time staleness rate', async () => {
      // `document.freshness_gap` measures runs reading a copy the source has moved past. A click
      // hands no body to any agent, and the commonest reason to click is that the source was down a
      // moment ago, so counting it would let one person retrying an outage move a deployment-wide
      // rate as far as they have patience for, in the direction that reads as a worsening fleet.
      probeVersion.mockRejectedValue(new Error('figma 500'))
      const svc = service({ versionCache: memoCache() })

      const manual = await svc.refreshNow(WS, 'figma', 'file1:1-2')

      expect(manual.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
      expect(counted).toEqual([])
    })

    it('leaves NO failure behind in the cache the dispatches read', async () => {
      // The asymmetry that makes the manual entry point safe. `refreshNow` drops the cached entry
      // before it asks; if it then re-filled it with whatever the click found, a person retrying
      // past a flaky source would install an `unreachable` verdict every dispatch reads for the
      // rest of the TTL window, degrading the run path with a failure no dispatch ever observed,
      // and renewing it with each further click.
      probeVersion.mockRejectedValueOnce(new Error('figma 429'))
      const svc = service({ versionCache: memoCache() })

      const manual = await svc.refreshNow(WS, 'figma', 'file1:1-2')
      const [dispatched] = await svc.refresh(WS, [record()])

      expect(manual.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
      // The dispatch asked for itself rather than inheriting the click's failure.
      expect(dispatched?.freshness).toEqual({
        status: 'confirmed',
        version: 'v1',
        change: 'unchanged',
      })
      expect(probeVersion).toHaveBeenCalledTimes(2)
    })

    it('leaves a SUCCESS behind, so the dispatches after it inherit the answer', async () => {
      // The other half: dropping the entry is about not SERVING a stale answer to the click, not
      // about withholding the fresh one from the run path that follows it.
      const svc = service({ versionCache: memoCache() })

      await svc.refreshNow(WS, 'figma', 'file1:1-2')
      const [dispatched] = await svc.refresh(WS, [record()])

      expect(probeVersion).toHaveBeenCalledTimes(1)
      expect(dispatched?.freshness).toEqual({
        status: 'confirmed',
        version: 'v1',
        change: 'unchanged',
      })
    })

    it('re-asks a source the cached verdict says is unreachable', async () => {
      // The click IS the request for a new answer, and the commonest reason to click is that the
      // last one reported an outage. Serving that from the 60s cache would report the very failure
      // the person is retrying past, and no amount of clicking would clear it.
      probeVersion.mockRejectedValueOnce(new Error('figma 429'))
      const svc = service({ versionCache: memoCache() })

      const [dispatched] = await svc.refresh(WS, [record()])
      const manual = await svc.refreshNow(WS, 'figma', 'file1:1-2')

      expect(dispatched?.freshness).toEqual({ status: 'unconfirmed', reason: 'source_unreachable' })
      expect(manual.freshness).toEqual({ status: 'confirmed', version: 'v1', change: 'unchanged' })
      expect(probeVersion).toHaveBeenCalledTimes(2)
    })
  })
})
