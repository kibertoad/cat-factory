import type {
  Clock,
  DocumentContent,
  DocumentContentResolver,
  DocumentSourceKind,
  FragmentOwnerKind,
  GroupCacheHandle,
  PromptFragmentRecord,
  PromptFragmentRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  clearRegisteredPromptFragments,
  registerPromptFragment,
} from '@cat-factory/prompt-fragments'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FragmentLibraryService } from './FragmentLibraryService.js'

// Unit coverage for the document-backed ("living") fragment path: createFromDocument
// seeds a catalog entry from the source, and resolveBodiesForRun re-resolves it at run
// time through the document-body cache (docs/initiatives/caching-layer.md slice 2) —
// fetching on a miss, keeping the cached body while the source's version probe reports
// unchanged, re-fetching when it moves, and falling back to the persisted body when the
// source is unreachable. The generic loader/probe mechanics are covered in
// @cat-factory/caching; here the focus is the service's use of the seam.

function key(kind: FragmentOwnerKind, id: string, fragmentId: string): string {
  return `${kind}|${id}|${fragmentId}`
}

/**
 * A minimal in-memory {@link GroupCacheHandle} for {@link DocumentContent}, modelling
 * an entry ALWAYS in the refresh window: a hit with a probe runs the probe (serve the
 * cached value when current, reload when stale); a hit without a probe is served
 * as-is; a load error is propagated and never cached. Enough to exercise the service's
 * cache usage without the real loader's timers.
 */
function fakeBodyCache(): GroupCacheHandle<DocumentContent> {
  const store = new Map<string, DocumentContent>()
  const at = (k: string, g: string) => `${g}::${k}`
  return {
    async get(k, group, load, isStillCurrent) {
      const id = at(k, group)
      const cached = store.get(id)
      if (cached && (!isStillCurrent || (await isStillCurrent(cached)))) return cached
      const loaded = await load()
      store.set(id, loaded)
      return loaded
    },
    async invalidate(k, group) {
      store.delete(at(k, group))
    },
    async invalidateGroup(group) {
      for (const id of store.keys()) if (id.startsWith(`${group}::`)) store.delete(id)
    },
    async invalidateAll() {
      store.clear()
    },
  }
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

/**
 * A resolver returning a configurable body + version (both closures so a test can
 * change them mid-run), or throwing to simulate an outage. Records fetch/probe counts
 * and the workspaces each was called through.
 */
function fakeResolver(
  body: () => string,
  opts: { throws?: boolean; version?: () => string } = {},
): DocumentContentResolver & { calls: number; probes: number; vias: string[] } {
  const version = opts.version ?? (() => 'v1')
  const r = {
    calls: 0,
    probes: 0,
    vias: [] as string[],
    async fetch(
      ws: string,
      _source: DocumentSourceKind,
      externalId: string,
    ): Promise<DocumentContent> {
      r.calls++
      r.vias.push(ws)
      if (opts.throws) throw new Error('source unreachable')
      return { externalId, title: 'Doc', url: 'https://x/doc', body: body(), version: version() }
    },
    async probeVersion(
      _ws: string,
      _source: DocumentSourceKind,
      _externalId: string,
    ): Promise<string> {
      r.probes++
      if (opts.throws) throw new Error('source unreachable')
      return version()
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
    expect(stored?.docViaWorkspaceId).toBe('ws1')
  })

  it('re-resolves an account-tier fragment through its linked workspace, not the run workspace', async () => {
    // An account-tier link is fetched through a chosen workspace's connection (doc
    // credentials are per-workspace). At run time a DIFFERENT workspace in the same
    // account must re-read through that SAME linked workspace — otherwise a run in a
    // workspace with no connection to the source would wedge (then degrade to cache).
    const resolver = fakeResolver(() => 'ACCOUNT-V2')
    // Every workspace in this test belongs to the same account.
    const accountWorkspaces = {
      accountOf: async () => 'acct1',
    } as unknown as WorkspaceRepository
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: accountWorkspaces,
      clock,
      documentContentResolver: resolver,
      documentBodyCache: fakeBodyCache(),
    })
    // Linked at the account tier, fetched through workspace 'wsA'.
    const created = await svc.createFromDocument(
      'account',
      'acct1',
      { source: 'confluence', ref: 'page-9' },
      'wsA',
    )
    resolver.calls = 0
    resolver.vias = []

    // A run in workspace 'wsB' (no connection of its own) resolves the fragment.
    const bodies = await svc.resolveBodiesForRun('wsB', [created.id])
    expect(bodies).toEqual([{ id: created.id, body: 'ACCOUNT-V2' }])
    // Re-read through the linked 'wsA', NOT the run's 'wsB'.
    expect(resolver.vias).toEqual(['wsA'])
  })

  it('serves the live body through the cache and keeps it while the version is unchanged', async () => {
    const resolver = fakeResolver(() => 'BODY-V2') // version fixed at 'v1'
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
      documentBodyCache: fakeBodyCache(),
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'p1' },
      'ws1',
    )
    resolver.calls = 0

    const first = await svc.resolveBodiesForRun('ws1', [created.id])
    expect(first).toEqual([{ id: created.id, body: 'BODY-V2' }])
    const second = await svc.resolveBodiesForRun('ws1', [created.id])
    expect(second).toEqual([{ id: created.id, body: 'BODY-V2' }])
    // Fetched once on the miss; the second read probed the version (unchanged) and
    // reused the cached body instead of re-fetching the whole page.
    expect(resolver.calls).toBe(1)
    expect(resolver.probes).toBe(1)
  })

  it('re-fetches when the source version moves (probe reports stale)', async () => {
    let body = 'A'
    let ver = 'v1'
    const resolver = fakeResolver(() => body, { version: () => ver })
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
      documentBodyCache: fakeBodyCache(),
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'p1' },
      'ws1',
    )
    resolver.calls = 0
    expect((await svc.resolveBodiesForRun('ws1', [created.id]))[0]?.body).toBe('A')

    body = 'B'
    ver = 'v2' // the page moved upstream
    expect((await svc.resolveBodiesForRun('ws1', [created.id]))[0]?.body).toBe('B')
    expect(resolver.calls).toBe(2)
  })

  it('without a body cache wired, a run serves the persisted body (no live re-resolve)', async () => {
    let body = 'PERSISTED'
    const resolver = fakeResolver(() => body)
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
      // no documentBodyCache
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'notion', ref: 'p1' },
      'ws1',
    )
    body = 'CHANGED' // the source moves, but there is no cache seam to re-resolve through
    resolver.calls = 0
    const bodies = await svc.resolveBodiesForRun('ws1', [created.id])
    expect(bodies[0]?.body).toBe('PERSISTED') // the durable create-time body, not 'CHANGED'
    expect(resolver.calls).toBe(0)
  })

  it('falls back to the last-resolved body when the source is unreachable', async () => {
    // Seed with a working resolver, then resolve through a throwing one.
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
    // A new service instance whose resolver always throws, with a body cache wired.
    const down = fakeResolver(() => 'NEVER', { throws: true })
    const svc2 = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: down,
      documentBodyCache: fakeBodyCache(),
    })
    const bodies = await svc2.resolveBodiesForRun('ws1', [created.id])
    expect(bodies).toEqual([{ id: created.id, body: 'CACHED' }])
    expect(down.calls).toBe(1) // it tried the live fetch, then degraded
  })

  it('refresh() re-resolves and invalidates the cached run-time body', async () => {
    let body = 'A'
    const resolver = fakeResolver(() => body) // version fixed at 'v1' throughout
    const svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock,
      documentContentResolver: resolver,
      documentBodyCache: fakeBodyCache(),
    })
    const created = await svc.createFromDocument(
      'workspace',
      'ws1',
      { source: 'github', ref: 'g1' },
      'ws1',
    )
    // Warm the run-time body cache with the current body.
    expect((await svc.resolveBodiesForRun('ws1', [created.id]))[0]?.body).toBe('A')

    body = 'B'
    const refreshed = await svc.refresh('workspace', 'ws1', created.id, 'ws1')
    expect(refreshed.body).toBe('B')
    // The version never moved, so only refresh()'s cache invalidation makes the run
    // see 'B' — a bare probe would have reported the cached 'A' still current.
    expect((await svc.resolveBodiesForRun('ws1', [created.id]))[0]?.body).toBe('B')
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

describe('FragmentLibraryService — built-in tier, suppression and registered fragments', () => {
  let repo: FakeFragmentRepo
  let svc: FragmentLibraryService

  beforeEach(() => {
    repo = new FakeFragmentRepo()
    svc = new FragmentLibraryService({
      promptFragmentRepository: repo,
      workspaceRepository: workspaces,
      clock: fakeClock(),
    })
  })

  afterEach(() => clearRegisteredPromptFragments())

  it('drops a tier-tombstoned built-in from a run resolution (suppression sticks)', async () => {
    // Pinned before the workspace suppressed it — the stale selection must NOT
    // resurrect the built-in from the static pool.
    const before = await svc.resolveBodiesForRun('ws1', ['node.performance'])
    expect(before).toHaveLength(1)

    await svc.remove('workspace', 'ws1', 'node.performance')

    const after = await svc.resolveBodiesForRun('ws1', ['node.performance'])
    expect(after).toEqual([])
  })

  it('serves a deployment-registered OVERRIDE of a built-in id to runs and the catalog', async () => {
    registerPromptFragment({
      id: 'node.performance',
      version: '2.0.0',
      title: 'Our perf rules',
      category: 'Node',
      summary: 'Deployment-refined performance guidance.',
      body: 'OVERRIDDEN-PERF-BODY',
    })
    const bodies = await svc.resolveBodiesForRun('ws1', ['node.performance'])
    expect(bodies).toEqual([{ id: 'node.performance', body: 'OVERRIDDEN-PERF-BODY' }])

    const catalog = await svc.resolvedCatalog('ws1')
    const entry = catalog.find((f) => f.id === 'node.performance')
    expect(entry?.body).toBe('OVERRIDDEN-PERF-BODY')
    expect(entry?.tier).toBe('builtin')
  })

  it('folds a registered EXTRA fragment into the catalog, tier-shadowable and tombstonable', async () => {
    registerPromptFragment({
      id: 'org.review-standard',
      version: '1.0.0',
      title: 'Org review standard',
      category: 'Org',
      summary: 'A proprietary org standard.',
      body: 'ORG-BODY',
    })
    const bodies = await svc.resolveBodiesForRun('ws1', ['org.review-standard'])
    expect(bodies).toEqual([{ id: 'org.review-standard', body: 'ORG-BODY' }])
    const catalog = await svc.resolvedCatalog('ws1')
    expect(catalog.find((f) => f.id === 'org.review-standard')?.tier).toBe('builtin')

    // A workspace tombstone suppresses it exactly like a shipped built-in.
    await svc.remove('workspace', 'ws1', 'org.review-standard')
    expect(await svc.resolveBodiesForRun('ws1', ['org.review-standard'])).toEqual([])
  })

  it('drops an id the catalog does not know at all', async () => {
    expect(await svc.resolveBodiesForRun('ws1', ['gone.stale-id'])).toEqual([])
  })
})
