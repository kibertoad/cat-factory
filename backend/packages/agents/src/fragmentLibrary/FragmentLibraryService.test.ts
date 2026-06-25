import type {
  Clock,
  DocumentContent,
  DocumentContentResolver,
  DocumentSourceKind,
  FragmentOwnerKind,
  PromptFragmentRecord,
  PromptFragmentRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DOCUMENT_FRAGMENT_TTL_MS,
  FragmentLibraryService,
} from './FragmentLibraryService.js'

// Unit coverage for the document-backed ("living") fragment path: createFromDocument
// seeds a catalog entry from the source, and resolveBodiesForRun re-resolves it at
// run time TTL-gated, persisting the refresh and falling back to the cached body when
// the source is unreachable. The cross-runtime conformance suite separately asserts a
// managed (DB) fragment reaches a run on both stores; here the focus is the pure logic.

function key(kind: FragmentOwnerKind, id: string, fragmentId: string): string {
  return `${kind}|${id}|${fragmentId}`
}

/** Minimal in-memory PromptFragmentRepository for the service under test. */
class FakeFragmentRepo implements PromptFragmentRepository {
  readonly rows = new Map<string, PromptFragmentRecord>()
  async listByOwner(kind: FragmentOwnerKind, id: string, includeDeleted = false) {
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === kind && r.ownerId === id && (includeDeleted || r.deletedAt === null),
    )
  }
  async get(kind: FragmentOwnerKind, id: string, fragmentId: string) {
    return this.rows.get(key(kind, id, fragmentId)) ?? null
  }
  async upsert(record: PromptFragmentRecord) {
    this.rows.set(key(record.ownerKind, record.ownerId, record.fragmentId), record)
  }
  async softDelete(kind: FragmentOwnerKind, id: string, fragmentId: string, at: number) {
    const r = this.rows.get(key(kind, id, fragmentId))
    if (r) r.deletedAt = at
  }
  async listBySource(sourceId: string) {
    return [...this.rows.values()].filter((r) => r.sourceId === sourceId)
  }
}

const workspaces = {
  accountOf: async () => null,
} as unknown as WorkspaceRepository

/** A controllable clock whose `now()` the test advances. */
function fakeClock(start = 1_000_000): Clock & { set(n: number): void } {
  let t = start
  return { now: () => t, set: (n: number) => (t = n) }
}

/** A resolver returning a configurable body, or throwing to simulate an outage. */
function fakeResolver(
  body: () => string,
  opts: { throws?: boolean } = {},
): DocumentContentResolver & { calls: number } {
  const r = {
    calls: 0,
    async fetch(
      _ws: string,
      source: DocumentSourceKind,
      externalId: string,
    ): Promise<DocumentContent> {
      r.calls++
      if (opts.throws) throw new Error('source unreachable')
      return { externalId, title: 'Doc', url: 'https://x/doc', body: body() }
    },
  }
  return r
}

describe('FragmentLibraryService — document-backed fragments', () => {
  let repo: FakeFragmentRepo
  let clock: Clock & { set(n: number): void }

  beforeEach(() => {
    repo = new FakeFragmentRepo()
    clock = fakeClock()
  })

  it('createFromDocument fetches the source and persists a living fragment', async () => {
    const resolver = fakeResolver(() => 'BODY-V1')
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
    })
    const fragment = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'page-123', tags: ['backend'] },
      'ws1',
    )
    expect(fragment.documentRef).toEqual({ source: 'notion', externalId: 'page-123' })
    expect(fragment.body).toBe('BODY-V1')
    expect(fragment.resolvedAt).toBe(clock.now())
    const stored = await repo.get('workspace', 'ws1', fragment.id)
    expect(stored?.docSource).toBe('notion')
    expect(stored?.docExternalId).toBe('page-123')
  })

  it('re-resolves a stale body at run time and persists the refresh', async () => {
    const resolver = fakeResolver(() => 'BODY-V2')
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
    })
    // Seed a document-backed row resolved long ago (stale).
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'p1' },
      'ws1',
    )
    clock.set(clock.now() + DEFAULT_DOCUMENT_FRAGMENT_TTL_MS + 1)
    resolver.calls = 0

    const bodies = await svc.resolveBodiesForRun('ws1', [created.id])
    expect(bodies).toEqual([{ id: created.id, body: 'BODY-V2' }])
    expect(resolver.calls).toBe(1)
    const stored = await repo.get('workspace', 'ws1', created.id)
    expect(stored?.body).toBe('BODY-V2')
    expect(stored?.resolvedAt).toBe(clock.now())
  })

  it('does NOT re-fetch a fresh body (within the TTL)', async () => {
    const resolver = fakeResolver(() => 'FRESH-BODY')
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'p1' },
      'ws1',
    )
    resolver.calls = 0 // still fresh: resolvedAt === now, so no re-fetch
    const bodies = await svc.resolveBodiesForRun('ws1', [created.id])
    expect(bodies[0]?.body).toBe('FRESH-BODY') // the cached create-time body
    expect(resolver.calls).toBe(0)
  })

  it('falls back to the last-resolved body when the source is unreachable', async () => {
    // Seed with a working resolver, then swap to a throwing one and go stale.
    const live = fakeResolver(() => 'CACHED')
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: live,
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'confluence', ref: 'c1' },
      'ws1',
    )
    // A new service instance whose resolver always throws.
    const down = fakeResolver(() => 'NEVER', { throws: true })
    const svc2 = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: down,
    })
    clock.set(clock.now() + DEFAULT_DOCUMENT_FRAGMENT_TTL_MS + 1)
    const bodies = await svc2.resolveBodiesForRun('ws1', [created.id])
    expect(bodies).toEqual([{ id: created.id, body: 'CACHED' }])
    expect(down.calls).toBe(1) // it tried, then degraded
  })

  it('refresh() force-re-resolves regardless of the TTL', async () => {
    let v = 'A'
    const resolver = fakeResolver(() => v)
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'github', ref: 'g1' },
      'ws1',
    )
    v = 'B' // still within TTL, but a manual refresh must re-fetch
    const refreshed = await svc.refresh('workspace', 'ws1', created.id, 'ws1')
    expect(refreshed.body).toBe('B')
  })

  it('rejects creating a document fragment when no resolver is wired', async () => {
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
    })
    await expect(
      svc.createFromDocument('workspace', 'ws1', { source: 'notion', ref: 'p' }, 'ws1'),
    ).rejects.toThrow()
  })
})
