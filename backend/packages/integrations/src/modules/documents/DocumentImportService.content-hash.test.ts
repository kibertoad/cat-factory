import { describe, expect, it } from 'vitest'
import type {
  Clock,
  DocumentContent,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceProvider,
  DocumentSourceRegistry,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { DocumentImportService } from './DocumentImportService.js'
import type { DocumentConnectionService } from './DocumentConnectionService.js'

// Focused coverage of the content-hash idempotency added to import(): a re-import whose
// body is byte-for-byte unchanged is a no-op (no second upsert, synced time preserved),
// while a changed body re-projects. The cross-runtime column mapping is exercised by the
// repo builds + conformance; this pins the SERVICE behaviour without a live source.

function makeService(body: { value: string }) {
  let upserts = 0
  const store = new Map<string, DocumentRecord>()
  const documentRepository: DocumentRepository = {
    async upsert(record) {
      upserts++
      store.set(record.externalId, record)
    },
    async get(_ws, _source, externalId) {
      return store.get(externalId) ?? null
    },
    async getByUrl() {
      return null
    },
    async listByWorkspace() {
      return [...store.values()]
    },
    async listByBlock() {
      return []
    },
    async linkBlock() {},
  }
  const provider: Partial<DocumentSourceProvider> = {
    kind: 'confluence',
    parseRef: () => 'PAGE-1',
    fetchDocument: async (): Promise<DocumentContent> => ({
      externalId: 'PAGE-1',
      title: 'Export PRD',
      url: 'https://docs/export-prd',
      body: body.value,
      version: '1',
    }),
  }
  const registry: DocumentSourceRegistry = {
    get: () => provider as DocumentSourceProvider,
    list: () => [provider as DocumentSourceProvider],
  }
  const connectionService = {
    requireConnection: async () => ({ credentials: {} }),
  } as unknown as DocumentConnectionService
  const workspaceRepository = {
    get: async () => ({ id: 'ws_1' }),
  } as unknown as WorkspaceRepository
  let now = 1000
  const clock: Clock = { now: () => now }
  const service = new DocumentImportService({
    registry,
    documentRepository,
    connectionService,
    workspaceRepository,
    clock,
  })
  return {
    service,
    upserts: () => upserts,
    advance: (to: number) => {
      now = to
    },
  }
}

describe('DocumentImportService content-hash idempotency', () => {
  it('re-importing an unchanged body is a no-op (no second upsert)', async () => {
    const h = makeService({ value: '# PRD\n\nExport must be UTF-8.' })
    await h.service.import('ws_1', 'confluence', 'PAGE-1')
    expect(h.upserts()).toBe(1)
    h.advance(2000)
    const again = await h.service.import('ws_1', 'confluence', 'PAGE-1')
    expect(h.upserts()).toBe(1) // unchanged ⇒ skipped
    expect(again.syncedAt).toBe(1000) // original synced time preserved
  })

  it('re-importing a changed body re-projects', async () => {
    const body = { value: '# PRD\n\nv1' }
    const h = makeService(body)
    await h.service.import('ws_1', 'confluence', 'PAGE-1')
    expect(h.upserts()).toBe(1)
    body.value = '# PRD\n\nv2 — now UTF-16'
    h.advance(2000)
    const updated = await h.service.import('ws_1', 'confluence', 'PAGE-1')
    expect(h.upserts()).toBe(2)
    expect(updated.syncedAt).toBe(2000)
  })
})
