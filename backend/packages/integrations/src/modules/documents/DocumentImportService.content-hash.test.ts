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

function makeService(
  body: { value: string },
  version = { value: '1' },
  over: { workspaceExists?: boolean } = {},
) {
  let upserts = 0
  const invalidated: { key: string; group: string }[] = []
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
    get: async () => (over.workspaceExists === false ? null : { id: 'ws_1' }),
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
    versionCache: {
      get: async (_key, _group, load) => load(),
      invalidate: async (key, group) => {
        invalidated.push({ key, group })
      },
      invalidateGroup: async () => {},
      invalidateAll: async () => {},
    },
  })
  return {
    service,
    upserts: () => upserts,
    stored: () => store.get('PAGE-1') ?? null,
    invalidated: () => invalidated,
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

  it('records the caller’s probed token when the fetch itself exposes none', async () => {
    // What makes the dispatch-time ladder converge: a provider whose fetch resolves its version
    // best-effort (GitHub docs' commit sha degrades to null on a rate-limited request) would
    // otherwise leave the row holding null, mismatch the probe forever, and re-download the whole
    // document on every dispatch of every run.
    const h = makeService({ value: '# PRD' }, { value: '' })
    const record = await h.service.reimport('ws_1', 'confluence', 'PAGE-1', {
      fallbackVersion: 'sha-abc',
    })

    expect(record.sourceVersion).toBe('sha-abc')
  })

  it('prefers the FETCH’s own version over the fallback', async () => {
    // The fallback fills a gap; it never overrides what the source actually said about the body
    // that was stored.
    const h = makeService({ value: '# PRD' }, { value: 'v9' })
    const record = await h.service.reimport('ws_1', 'confluence', 'PAGE-1', {
      fallbackVersion: 'sha-abc',
    })

    expect(record.sourceVersion).toBe('v9')
  })
})

describe('DocumentImportService write guards', () => {
  it('refuses to write a projection for a workspace that does not exist', async () => {
    // The class invariant every other write on this service holds. It sits on `reimport`, the
    // method that WRITES, so no entry point can reach the upsert around it.
    const h = makeService({ value: '# PRD' }, { value: 'v1' }, { workspaceExists: false })

    await expect(h.service.reimport('ws_gone', 'confluence', 'PAGE-1')).rejects.toThrow()
    await expect(h.service.import('ws_gone', 'confluence', 'PAGE-1')).rejects.toThrow()
    expect(h.upserts()).toBe(0)
  })

  it('drops the document’s cached freshness verdict after a MANUAL import', async () => {
    // The verdict was reached against the token the row carried before this write. Left in place,
    // the next dispatch compares a fresh row against a stale answer: either a needless re-download
    // or a `confirmed` naming the wrong revision.
    const h = makeService({ value: '# PRD' }, { value: 'v1' })
    await h.service.import('ws_1', 'confluence', 'PAGE-1')

    expect(h.invalidated()).toEqual([{ key: 'confluence:PAGE-1', group: 'ws_1' }])
  })

  it('does NOT invalidate from `reimport`, which runs inside that cache’s own loader', async () => {
    // The refresh calls `reimport` from within the loader that is about to store the fresh entry,
    // so an invalidation there would race the store it precedes and buy nothing.
    const h = makeService({ value: '# PRD' }, { value: 'v1' })
    await h.service.reimport('ws_1', 'confluence', 'PAGE-1')

    expect(h.invalidated()).toEqual([])
  })
})
