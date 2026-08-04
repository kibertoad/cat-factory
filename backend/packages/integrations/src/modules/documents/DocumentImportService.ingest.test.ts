import { describe, expect, it } from 'vitest'
import type {
  Clock,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceRegistry,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { hasReadableContent, ValidationError } from '@cat-factory/kernel'
import { DocumentImportService } from './DocumentImportService.js'
import type { DocumentConnectionService } from './DocumentConnectionService.js'

// `ingest`: a document body handed to the platform directly rather than fetched from a connected
// source. What is worth pinning is everything that makes such a row behave like an imported one
// downstream while asking nothing of a provider, plus the two places it deliberately differs:
// a MINTED id, and no origin URL.

function makeService() {
  const store: DocumentRecord[] = []
  let minted = 0
  const documentRepository = {
    async upsert(record: DocumentRecord) {
      store.push(record)
    },
  } as unknown as DocumentRepository
  // Deliberately EMPTY: an ingest that reached for a provider would throw here rather than
  // quietly working because the test happened to register one.
  const registry: DocumentSourceRegistry = { get: () => undefined, list: () => [] }
  const service = new DocumentImportService({
    registry,
    documentRepository,
    connectionService: {} as unknown as DocumentConnectionService,
    workspaceRepository: { get: async () => ({ id: 'ws_1' }) } as unknown as WorkspaceRepository,
    clock: { now: () => 4242 } as Clock,
    idGenerator: { next: (prefix) => `${prefix ?? 'id'}_${++minted}` },
  })
  return { service, store }
}

describe('DocumentImportService.ingest', () => {
  it('persists the supplied body as an `upload` document an agent can read', async () => {
    const { service, store } = makeService()

    const doc = await service.ingest('ws_1', {
      title: 'Checkout PRD',
      content: '# Checkout PRD\n\nSupport split payments.',
    })

    expect(doc.source).toBe('upload')
    expect(doc.title).toBe('Checkout PRD')
    // No page behind it, so no URL is invented: readers render an origin only when there is one.
    expect(doc.url).toBe('')
    const [record] = store
    expect(record!.body).toBe('# Checkout PRD\n\nSupport split payments.')
    expect(record!.syncedAt).toBe(4242)
    expect(record!.linkedBlockId).toBeNull()
    // The invariant every downstream reader depends on: a row the context resolver would refuse
    // is never written in the first place.
    expect(hasReadableContent(record!)).toBe(true)
  })

  it('mints a fresh id per upload, so the same spec on two tasks is two documents', async () => {
    const { service } = makeService()
    const input = { title: 'Checkout PRD', content: 'Support split payments.' }

    const first = await service.ingest('ws_1', input)
    const second = await service.ingest('ws_1', input)

    // A content-addressed id would collide on the primary key, and since a row carries a single
    // `linkedBlockId` the second upload would silently steal the first task's attachment.
    expect(second.externalId).not.toBe(first.externalId)
  })

  it('refuses a body with no readable text, at the boundary rather than mid-run', async () => {
    const { service, store } = makeService()

    // An empty fenced block: non-empty as bytes, nothing at all once rendered to text (the shape
    // an extractor emits for an embed it could not render). The platform already refuses such a
    // document, but only on the first step that resolves context, by which point the caller has
    // started and paid for a run.
    await expect(service.ingest('ws_1', { title: 'Spec', content: '```\n\n```' })).rejects.toThrow(
      ValidationError,
    )
    expect(store).toHaveLength(0)
  })
})
