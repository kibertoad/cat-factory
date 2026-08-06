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

function makeService(body: { value: string }, version = { value: '1' }) {
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
    async listByRefs(_ws, refs) {
      return refs.flatMap((ref) => {
        const hit = store.get(ref.externalId)
        return hit && hit.source === ref.source ? [hit] : []
      })
    },
    async listByBlock() {
      return []
    },
    async linkBlock() {},
    async linkBlockMany() {},
    async detachBlocks() {},
    async getRoleLink() {
      return null
    },
    async listRoleLinks() {
      return []
    },
    async listRoleLinksByWorkspace() {
      return []
    },
    async setRole() {},
    async clearRole() {},
    async clearRoleForKind() {},
  }
  const provider: Partial<DocumentSourceProvider> = {
    kind: 'confluence',
    parseRef: () => 'PAGE-1',
    fetchDocument: async (): Promise<DocumentContent> => ({
      externalId: 'PAGE-1',
      title: 'Export PRD',
      url: 'https://docs/export-prd',
      body: body.value,
      version: version.value,
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
  let minted = 0
  const clock: Clock = { now: () => now }
  const service = new DocumentImportService({
    registry,
    documentRepository,
    connectionService,
    workspaceRepository,
    clock,
    idGenerator: { next: (prefix) => `${prefix ?? 'id'}_${++minted}` },
  })
  return {
    service,
    upserts: () => upserts,
    stored: () => store.get('PAGE-1') ?? null,
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

describe('DocumentImportService source-version recording', () => {
  it('records the source version the stored body came from', async () => {
    // The token the dispatch-time refresh compares against. Without it stored, "the page has not
    // moved" is unprovable and every dispatch pays a full re-download.
    const h = makeService({ value: '# PRD' }, { value: '2317456' })
    await h.service.import('ws_1', 'confluence', 'PAGE-1')

    expect(h.stored()?.sourceVersion).toBe('2317456')
  })

  it('re-projects a body that did not change when only the VERSION moved', async () => {
    // A Figma file version bumps on any edit in the file, including a frame this document does not
    // cover. Skipping the write here would leave the old token on the row and re-fetch the whole
    // design on every single dispatch, forever — the exact cost the probe exists to avoid.
    const version = { value: 'v1' }
    const h = makeService({ value: '# PRD' }, version)
    await h.service.import('ws_1', 'confluence', 'PAGE-1')
    expect(h.upserts()).toBe(1)

    version.value = 'v2'
    await h.service.import('ws_1', 'confluence', 'PAGE-1')

    expect(h.upserts()).toBe(2)
    expect(h.stored()?.sourceVersion).toBe('v2')
  })

  it('stores NULL, not an empty string, for a source that exposes no version', async () => {
    // "Not versioned" has to be ONE value everywhere, or the refresh has two absences to test for.
    const h = makeService({ value: '# PRD' }, { value: '' })
    await h.service.import('ws_1', 'confluence', 'PAGE-1')

    expect(h.stored()?.sourceVersion).toBeNull()
  })

  it('reimport reaches the same projection without re-parsing a ref', async () => {
    // The refresh path starts from a stored row, so it already holds the canonical external id.
    // Routing it back through `parseRef` would put the one hop that can legitimately fail on a path
    // with no user input to fail on.
    const h = makeService({ value: '# PRD' }, { value: 'v7' })
    const record = await h.service.reimport('ws_1', 'confluence', 'PAGE-1')

    expect(record.externalId).toBe('PAGE-1')
    expect(record.sourceVersion).toBe('v7')
  })
})
