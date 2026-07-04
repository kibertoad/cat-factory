import { createAppCaches } from '@cat-factory/caching'
import type {
  Clock,
  FragmentOwnerKind,
  PromptFragmentRecord,
  PromptFragmentRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FragmentLibraryService } from './FragmentLibraryService.js'

// Slice 1 of the caching initiative (docs/initiatives/caching-layer.md): the
// merged tenant catalog is served through the fragment-catalog cache, and every
// fragment write invalidates it — so a resolve immediately after a write sees
// the write, while repeat resolves skip the repositories entirely. Driven
// against the REAL @cat-factory/caching implementation, not a recording fake.

function rowKey(kind: FragmentOwnerKind, id: string, fragmentId: string): string {
  return `${kind}|${id}|${fragmentId}`
}

class CountingFragmentRepo implements PromptFragmentRepository {
  readonly rows = new Map<string, PromptFragmentRecord>()
  listReads = 0
  async listByOwner(kind: FragmentOwnerKind, id: string, includeDeleted = false) {
    this.listReads++
    return [...this.rows.values()].filter(
      (r) => r.ownerKind === kind && r.ownerId === id && (includeDeleted || r.deletedAt === null),
    )
  }
  async get(kind: FragmentOwnerKind, id: string, fragmentId: string) {
    return this.rows.get(rowKey(kind, id, fragmentId)) ?? null
  }
  async upsert(record: PromptFragmentRecord) {
    this.rows.set(rowKey(record.ownerKind, record.ownerId, record.fragmentId), record)
  }
  async softDelete(kind: FragmentOwnerKind, id: string, fragmentId: string, at: number) {
    const r = this.rows.get(rowKey(kind, id, fragmentId))
    if (r) r.deletedAt = at
  }
  async listBySource(sourceId: string) {
    return [...this.rows.values()].filter((r) => r.sourceId === sourceId)
  }
}

const clock: Clock = { now: () => 1_000_000 }

function makeService(accountId: string | null = null) {
  const repo = new CountingFragmentRepo()
  const workspaces = { accountOf: async () => accountId } as unknown as WorkspaceRepository
  const service = new FragmentLibraryService({
    promptFragmentRepository: repo,
    workspaceRepository: workspaces,
    clock,
    builtins: [],
    catalogCache: createAppCaches().fragmentCatalog,
  })
  return { service, repo }
}

describe('FragmentLibraryService + fragment-catalog cache (slice 1)', () => {
  it('serves repeat resolves from the cache (no repository re-reads)', async () => {
    const { service, repo } = makeService()
    await service.create('workspace', 'ws1', { title: 'Perf', summary: 's', body: 'b' })
    const first = await service.resolveCatalog('ws1')
    const readsAfterFirst = repo.listReads
    const second = await service.resolveCatalog('ws1')
    expect(second).toEqual(first)
    expect(repo.listReads).toBe(readsAfterFirst)
  })

  it('a workspace-tier write is visible on the immediately following resolve', async () => {
    const { service } = makeService()
    expect(await service.resolveCatalog('ws1')).toEqual([])

    await service.create('workspace', 'ws1', { id: 'perf', title: 'Perf', summary: 's', body: 'b' })
    expect((await service.resolveCatalog('ws1')).map((e) => e.id)).toEqual(['perf'])

    await service.update('workspace', 'ws1', 'perf', { summary: 'updated' })
    expect((await service.resolveCatalog('ws1'))[0]?.summary).toBe('updated')

    await service.remove('workspace', 'ws1', 'perf')
    expect(await service.resolveCatalog('ws1')).toEqual([])
  })

  it('an account-tier write invalidates the cached catalog of the account workspaces', async () => {
    const { service } = makeService('acc1')
    expect(await service.resolveCatalog('ws1')).toEqual([]) // now cached
    await service.create('account', 'acc1', { id: 'org', title: 'Org', summary: 's', body: 'b' })
    expect((await service.resolveCatalog('ws1')).map((e) => e.id)).toEqual(['org'])
  })

  it('workspace groups are independent: invalidating one leaves the other cached', async () => {
    const { service, repo } = makeService()
    await service.resolveCatalog('ws1')
    await service.resolveCatalog('ws2')
    const reads = repo.listReads
    // A ws1-tier write only drops ws1's group.
    await service.create('workspace', 'ws1', { id: 'a', title: 'A', summary: 's', body: 'b' })
    await service.resolveCatalog('ws2')
    expect(repo.listReads).toBe(reads)
    const ws1 = await service.resolveCatalog('ws1')
    expect(ws1.map((e) => e.id)).toEqual(['a'])
    expect(repo.listReads).toBeGreaterThan(reads)
  })
})
