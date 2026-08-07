import { describe, expect, it, vi } from 'vitest'
import type {
  BinaryArtifactRecord,
  BinaryArtifactStore,
  Clock,
  DocumentArtifactRef,
  DocumentContent,
  DocumentRecord,
  DocumentRenderResult,
  DocumentRepository,
  DocumentSourceProvider,
  DocumentSourceRegistry,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { DocumentImportService } from './DocumentImportService.js'
import type { DocumentConnectionService } from './DocumentConnectionService.js'

// The RENDER lifecycle an import owns: retain a design source's pictures beside its text, replace
// them when the design moves, and — the part that actually matters — say on the row what became of
// them, because every way of ending up with no images looks the same from the outside.
//
// The costly branch is pinned here too. A design file's version moves on any edit anywhere in it,
// so most re-imports write nothing but a token; re-rasterising six frames on each of those would
// put megabytes on the critical path of a step dispatch that had no reason to spend them.

const DESIGN: DocumentArtifactRef = { source: 'figma', externalId: 'file1:1:2' }

function memoryStore(over: { failOn?: string } = {}) {
  const rows: BinaryArtifactRecord[] = []
  const store: BinaryArtifactStore = {
    store: async ({ meta, blob }) => {
      if (over.failOn && meta.view === over.failOn) throw new Error('blob backend is full')
      const record: BinaryArtifactRecord = {
        id: `art_${rows.length + 1}`,
        workspaceId: meta.workspaceId,
        executionId: meta.executionId,
        blockId: meta.blockId,
        kind: meta.kind,
        view: meta.view,
        contentType: meta.contentType,
        byteSize: blob.byteLength,
        hash: 'h',
        storage: 'memory',
        storageKey: `k${rows.length + 1}`,
        document: meta.document ?? null,
        createdAt: 1,
      }
      rows.push(record)
      return record
    },
    getMetadata: async () => null,
    getBlob: async () => null,
    getBlobWithMetadata: async () => null,
    listByExecution: async () => [],
    countByExecution: async () => 0,
    listByBlock: async () => [],
    listByDocument: async (_ws, document) =>
      rows.filter(
        (r) =>
          r.document?.source === document.source && r.document.externalId === document.externalId,
      ),
    pruneByDocument: async (ws, document) => {
      const doomed = await store.listByDocument(ws, document)
      for (const r of doomed) rows.splice(rows.indexOf(r), 1)
      return doomed.length
    },
    delete: async () => {},
    pruneOlderThan: async () => 0,
    deleteByWorkspace: async () => 0,
  }
  return { store, rows: () => rows }
}

interface Harness {
  body: { value: string }
  version: { value: string }
  renders: { value: DocumentRenderResult | Error }
}

function makeService(
  harness: Harness,
  wiring: { storage?: BinaryArtifactStore | null; rendersSupported?: boolean } = {},
) {
  const stored = new Map<string, DocumentRecord>()
  const documentRepository = {
    upsert: async (record: DocumentRecord) => {
      stored.set(record.externalId, record)
    },
    get: async (_ws: string, _source: string, externalId: string) => stored.get(externalId) ?? null,
  } as unknown as DocumentRepository
  const fetchRenders = vi.fn(async (): Promise<DocumentRenderResult> => {
    if (harness.renders.value instanceof Error) throw harness.renders.value
    return harness.renders.value
  })
  const provider: Partial<DocumentSourceProvider> = {
    kind: 'figma',
    parseRef: () => DESIGN.externalId,
    fetchDocument: async (): Promise<DocumentContent> => ({
      externalId: DESIGN.externalId,
      title: 'Checkout flow',
      url: 'https://figma.com/design/file1',
      body: harness.body.value,
      version: harness.version.value,
    }),
    ...(wiring.rendersSupported === false ? {} : { fetchRenders }),
  }
  const registry: DocumentSourceRegistry = {
    get: () => provider as DocumentSourceProvider,
    list: () => [provider as DocumentSourceProvider],
  }
  const clock: Clock = { now: () => 1000 }
  const service = new DocumentImportService({
    registry,
    documentRepository,
    connectionService: {
      requireConnection: async () => ({ credentials: {} }),
    } as unknown as DocumentConnectionService,
    workspaceRepository: { get: async () => ({ id: 'ws_1' }) } as unknown as WorkspaceRepository,
    clock,
    idGenerator: { next: (p) => `${p}_1` },
    ...(wiring.storage === undefined
      ? {}
      : { resolveBinaryArtifactStore: async () => wiring.storage ?? null }),
  })
  return { service, stored: () => stored.get(DESIGN.externalId) ?? null, fetchRenders }
}

const png = (n: number) => new Uint8Array([0x89, n])

function rendered(views: string[], failed = 0): DocumentRenderResult {
  return {
    renders: views.map((view, i) => ({ view, contentType: 'image/png', bytes: png(i) })),
    failed,
    causes: failed ? ['HTTP 429'] : [],
  }
}

describe('DocumentImportService renders', () => {
  it('retains a design’s frames keyed to the document and records `stored`', async () => {
    const { store, rows } = memoryStore()
    const harness: Harness = {
      body: { value: '## Checkout' },
      version: { value: 'v1' },
      renders: { value: rendered(['Checkout', 'Confirm']) },
    }
    const { service, stored } = makeService(harness, { storage: store })

    await service.import('ws_1', 'figma', 'https://figma.com/design/file1')

    expect(stored()?.renderStatus).toBe('stored')
    // No run and no block: the import happens before either exists, so the document's own source
    // identity is the only key a later reader can join on.
    expect(rows().map((r) => [r.view, r.kind, r.executionId, r.blockId])).toEqual([
      ['Checkout', 'reference', null, null],
      ['Confirm', 'reference', null, null],
    ])
    expect(rows()[0]?.document).toEqual(DESIGN)
  })

  it('replaces the previous revision’s renders rather than accumulating them', async () => {
    const { store, rows } = memoryStore()
    const harness: Harness = {
      body: { value: '## Checkout' },
      version: { value: 'v1' },
      renders: { value: rendered(['Checkout']) },
    }
    const { service } = makeService(harness, { storage: store })
    await service.import('ws_1', 'figma', 'ref')

    harness.body.value = '## Checkout v2'
    harness.version.value = 'v2'
    harness.renders.value = rendered(['Checkout', 'Receipt'])
    await service.import('ws_1', 'figma', 'ref')

    // Two frames, not three: a design's pictures are never a mix of two revisions.
    expect(rows().map((r) => r.view)).toEqual(['Checkout', 'Receipt'])
  })

  it('does NOT re-render when only the version moved, and carries the status forward', async () => {
    const { store } = memoryStore()
    const harness: Harness = {
      body: { value: '## Checkout' },
      version: { value: 'v1' },
      renders: { value: rendered(['Checkout']) },
    }
    const { service, stored, fetchRenders } = makeService(harness, { storage: store })
    await service.import('ws_1', 'figma', 'ref')
    expect(fetchRenders).toHaveBeenCalledTimes(1)

    // A file version bumps on any edit in the file, including frames this document does not cover.
    // The body is byte-for-byte the same, so the pictures are too.
    harness.version.value = 'v2'
    await service.import('ws_1', 'figma', 'ref')

    expect(fetchRenders).toHaveBeenCalledTimes(1)
    expect(stored()?.sourceVersion).toBe('v2')
    expect(stored()?.renderStatus).toBe('stored')
  })

  it('records `storage_unavailable` without spending the download', async () => {
    const harness: Harness = {
      body: { value: '## Checkout' },
      version: { value: 'v1' },
      renders: { value: rendered(['Checkout']) },
    }
    const { service, stored, fetchRenders } = makeService(harness, { storage: null })

    await service.import('ws_1', 'figma', 'ref')

    // The import still lands: the text is the load-bearing half, and an image is an enrichment.
    expect(stored()?.body).toBe('## Checkout')
    expect(stored()?.renderStatus).toBe('storage_unavailable')
    // Asked BEFORE the fetch, so a deployment with no image storage pulls no bytes it must drop.
    expect(fetchRenders).not.toHaveBeenCalled()
  })

  it('separates “the source offered none”, “some were lost” and “the pass failed”', async () => {
    const cases: Array<[DocumentRenderResult | Error, string]> = [
      [rendered([]), 'none'],
      [rendered(['Checkout'], 2), 'partial'],
      [rendered([], 3), 'failed'],
      [new Error('figma is down'), 'failed'],
    ]
    for (const [result, expected] of cases) {
      const { store } = memoryStore()
      const harness: Harness = {
        body: { value: `## ${expected}` },
        version: { value: 'v1' },
        renders: { value: result },
      }
      const { service, stored } = makeService(harness, { storage: store })
      await service.import('ws_1', 'figma', 'ref')
      expect(stored()?.renderStatus).toBe(expected)
    }
  })

  it('counts a frame the STORE rejected as lost, not as retained', async () => {
    // The status is derived from what was RETAINED, not from what was downloaded: claiming
    // `stored` over an artifact that never landed sends the next reader looking for a row that
    // does not exist.
    const { store, rows } = memoryStore({ failOn: 'Confirm' })
    const harness: Harness = {
      body: { value: '## Checkout' },
      version: { value: 'v1' },
      renders: { value: rendered(['Checkout', 'Confirm']) },
    }
    const { service, stored } = makeService(harness, { storage: store })

    await service.import('ws_1', 'figma', 'ref')

    expect(stored()?.renderStatus).toBe('partial')
    expect(rows().map((r) => r.view)).toEqual(['Checkout'])
  })

  it('leaves the status NULL for a source with nothing to rasterise', async () => {
    const { store } = memoryStore()
    const harness: Harness = {
      body: { value: '# PRD' },
      version: { value: 'v1' },
      renders: { value: rendered([]) },
    }
    const { service, stored } = makeService(harness, {
      storage: store,
      rendersSupported: false,
    })

    await service.import('ws_1', 'figma', 'ref')

    // NULL is "the question does not apply", which is a different fact from `none` ("the source
    // offered no image"): a prose document has no frames to miss.
    expect(stored()?.renderStatus).toBeNull()
  })
})
