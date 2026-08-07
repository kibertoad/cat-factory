import { describe, expect, it, vi } from 'vitest'
import type { ResolvedCatalogEntry } from '@cat-factory/kernel'
import { createOperationalMetricsCollector } from '@cat-factory/kernel'
import type { BackgroundWorkMeta } from 'layered-loader/core'
import { createAppCaches } from './appCaches.js'
import type { AppCachesProfile } from './appCaches.js'
import type { CacheGenerationStore } from './generationCoherency.js'

// The pull-coherency seam end to end, driven through `createAppCaches` the way the Worker
// drives it: two bag instances ("isolates") sharing one fake generation store (the FakeBus
// two-node pattern one file over), a probe window per profile entry, and layered-loader
// 16.1's applyRemote* primitives applying what a probe finds. What is pinned here is the
// behaviour the Worker profile depends on: window amortization, the bounded-staleness
// window, the mid-flight fence, self-echo suppression, the '*' epoch path, and the
// fail-closed-read / fail-open-write error posture.

function entry(id: string): ResolvedCatalogEntry {
  return {
    id,
    version: '1.0.0',
    title: id,
    category: null,
    summary: `${id} summary`,
    body: `${id} body`,
    brief: null,
    briefScope: { ownerKind: 'workspace' as const, ownerId: 'ws1' },
    appliesTo: null,
    tags: null,
    source: null,
    documentRef: null,
    docViaWorkspaceId: null,
    resolvedAt: null,
    tier: 'workspace',
  }
}

class FakeGenerationStore implements CacheGenerationStore {
  private readonly generations = new Map<string, Map<string, number>>()
  reads = 0
  bumps = 0
  failReads = false
  failBumps = false

  async getGenerations(group: string): Promise<Record<string, number>> {
    if (this.failReads) throw new Error('directory down')
    this.reads += 1
    return Object.fromEntries(this.generations.get(group) ?? [])
  }

  async bump(cacheName: string, group: string): Promise<number> {
    if (this.failBumps) throw new Error('directory down')
    this.bumps += 1
    let byCache = this.generations.get(group)
    if (!byCache) {
      byCache = new Map()
      this.generations.set(group, byCache)
    }
    const next = (byCache.get(cacheName) ?? 0) + 1
    byCache.set(cacheName, next)
    return next
  }
}

/** A coherent fragment-catalog entry; `windowMsecs: 0` means "probe on every read". */
function coherentProfile(windowMsecs: number): Partial<AppCachesProfile> {
  return {
    fragmentCatalog: {
      enabled: true,
      ttlInMsecs: 5 * 60_000,
      maxGroups: 10,
      maxItemsPerGroup: 4,
      coherencyWindowMsecs: windowMsecs,
    },
  }
}

describe('generation coherency (pull invalidation across two bags)', () => {
  it('one probe per group serves every coherent cache, and the window amortizes it', async () => {
    const store = new FakeGenerationStore()
    const caches = createAppCaches({
      profile: {
        ...coherentProfile(60_000),
        workspaceSettings: {
          enabled: true,
          ttlInMsecs: 5 * 60_000,
          maxGroups: 10,
          maxItemsPerGroup: 1,
          coherencyWindowMsecs: 60_000,
        },
      },
      generationStore: store,
    })
    await caches.fragmentCatalog.get('k', 'ws1', async () => [entry('a')])
    // First coherent read probed the group AND the '*' epoch shard: two round trips.
    expect(store.reads).toBe(2)
    // The sibling coherent cache's read of the SAME group rides those probes; further
    // fragment-catalog reads inside the window probe nothing either.
    await caches.workspaceSettings.get('ws1', 'ws1', async () => ({ settings: null }))
    await caches.fragmentCatalog.get('k', 'ws1', async () => [entry('a')])
    expect(store.reads).toBe(2)
    // A different group is its own shard (the epoch snapshot is still fresh).
    await caches.fragmentCatalog.get('k', 'ws2', async () => [entry('a')])
    expect(store.reads).toBe(3)
  })

  it('a peer bag write becomes visible on the next probe', async () => {
    const store = new FakeGenerationStore()
    const writer = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    const reader = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    let readerLoads = 0
    const load = (id: string) => async () => {
      readerLoads += 1
      return [entry(id)]
    }
    const first = await reader.fragmentCatalog.get('k', 'ws1', load('v1'))
    expect(first.map((e) => e.id)).toEqual(['v1'])

    // The writer's invalidation bumps the shared directory; the reader's next probe
    // (window 0 ⇒ every read) applies the group invalidation locally and reloads.
    await writer.fragmentCatalog.invalidateGroup('ws1')
    const second = await reader.fragmentCatalog.get('k', 'ws1', load('v2'))
    expect(second.map((e) => e.id)).toEqual(['v2'])
    expect(readerLoads).toBe(2)
  })

  it('inside the window a peer write is not yet visible: the designed staleness bound', async () => {
    const store = new FakeGenerationStore()
    const writer = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    const reader = createAppCaches({ profile: coherentProfile(60_000), generationStore: store })
    let readerLoads = 0
    const load = async () => {
      readerLoads += 1
      return [entry('v1')]
    }
    await reader.fragmentCatalog.get('k', 'ws1', load)
    await writer.fragmentCatalog.invalidateGroup('ws1')
    // The reader's snapshot is inside its window, so this read serves the cached entry:
    // cross-isolate staleness is bounded by the window, deliberately not zero.
    await reader.fragmentCatalog.get('k', 'ws1', load)
    expect(readerLoads).toBe(1)
  })

  it("a bag's own bump does not re-invalidate what it just reloaded (self-echo)", async () => {
    const store = new FakeGenerationStore()
    const metrics = createOperationalMetricsCollector()
    const caches = createAppCaches({
      profile: coherentProfile(0),
      generationStore: store,
      operationalMetrics: metrics,
    })
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await caches.fragmentCatalog.invalidateGroup('ws1')
    // The local invalidation dropped the entry, so this read reloads (that is the write
    // path's own coherence)…
    await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(loads).toBe(2)
    // …but the probe that read the bumped counter must NOT treat the bag's own bump as a
    // peer's change: the reloaded entry stays served, and no coherency invalidation fired.
    await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(loads).toBe(2)
    const samples = metrics.drain()
    expect(
      samples.find((sample) => sample.counter === 'cache.coherency_invalidation'),
    ).toBeUndefined()
  })

  it("invalidateAll travels as the '*' epoch and clears every peer group", async () => {
    const store = new FakeGenerationStore()
    const writer = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    const reader = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    let readerLoads = 0
    const load = async () => {
      readerLoads += 1
      return [entry('a')]
    }
    await reader.fragmentCatalog.get('k', 'ws1', load)
    await reader.fragmentCatalog.get('k', 'ws2', load)
    expect(readerLoads).toBe(2)
    await writer.fragmentCatalog.invalidateAll()
    // Both groups reload: the epoch probe found the moved counter and applied the full clear.
    await reader.fragmentCatalog.get('k', 'ws1', load)
    await reader.fragmentCatalog.get('k', 'ws2', load)
    expect(readerLoads).toBe(4)
  })

  it('fences a load already in flight when the invalidation arrives (16.1 behaviour)', async () => {
    const store = new FakeGenerationStore()
    const writer = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    const reader = createAppCaches({ profile: coherentProfile(0), generationStore: store })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    // A slow load starts BEFORE the peer's write (awaiting `loadStarted` pins the ordering:
    // the load is registered and in flight before the bump lands)…
    const slowRead = reader.fragmentCatalog.get('k1', 'ws1', async () => {
      started()
      await gate
      return [entry('pre-invalidation')]
    })
    await loadStarted
    // …the peer invalidates, and a read of a SIBLING key probes the moved counter, applying
    // the group invalidation while the slow load is still in flight.
    await writer.fragmentCatalog.invalidateGroup('ws1')
    await reader.fragmentCatalog.get('k2', 'ws1', async () => [entry('other')])
    release()
    // The in-flight caller still gets its value…
    expect((await slowRead).map((e) => e.id)).toEqual(['pre-invalidation'])
    // …but the fence kept that pre-invalidation snapshot OUT of the cache: the next read
    // loads fresh instead of resurrecting it.
    const after = await reader.fragmentCatalog.get('k1', 'ws1', async () => [entry('fresh')])
    expect(after.map((e) => e.id)).toEqual(['fresh'])
  })

  it('a probe failure fails CLOSED: reads load fresh and re-probe until the store heals', async () => {
    const store = new FakeGenerationStore()
    const metrics = createOperationalMetricsCollector()
    const caches = createAppCaches({
      profile: coherentProfile(60_000),
      generationStore: store,
      operationalMetrics: metrics,
    })
    store.failReads = true
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry(`v${loads}`)]
    }
    // Every read during the outage degrades to pass-through: the failed probe invalidates
    // locally, the load runs, and no probe timestamp is recorded (so the next read probes
    // again rather than trusting a window that was never established).
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(loads).toBe(2)
    expect(
      metrics.drain().find((sample) => sample.counter === 'cache.coherency_probe_failure')?.value,
    ).toBeGreaterThan(0)
    // Store heals: the next probe succeeds against unmoved counters, so the value the LAST
    // outage read loaded (fresh from the source at that moment, cached after the failed
    // probe's invalidation) serves again, and the window is re-established.
    store.failReads = false
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(loads).toBe(2)
  })

  it('a bump failure fails OPEN: the write path resolves and the local drop still holds', async () => {
    const store = new FakeGenerationStore()
    const metrics = createOperationalMetricsCollector()
    const caches = createAppCaches({
      profile: coherentProfile(60_000),
      generationStore: store,
      operationalMetrics: metrics,
    })
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry(`v${loads}`)]
    }
    await caches.fragmentCatalog.get('k', 'ws1', load)
    store.failBumps = true
    // The directory is down, but the invalidation must not turn a committed write into a
    // thrown request: it resolves, having dropped the local entry.
    await expect(caches.fragmentCatalog.invalidateGroup('ws1')).resolves.toBeUndefined()
    const reread = await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(reread.map((e) => e.id)).toEqual(['v2'])
    expect(
      metrics.drain().find((sample) => sample.counter === 'cache.coherency_bump_failure'),
    ).toEqual({
      counter: 'cache.coherency_bump_failure',
      dimensions: { cache: 'fragment-catalog' },
      value: 1,
    })
  })

  it('refuses a coherent profile entry with no generation store wired', () => {
    // An enabled TTL'd cache of mutable state whose coherency window has nothing to probe
    // would serve stale after a peer's write, the exact bug the isolate-safe profile
    // exists to prevent, so construction refuses rather than degrades.
    expect(() => createAppCaches({ profile: coherentProfile(5_000) })).toThrow(
      /fragmentCatalog.*generationStore/,
    )
  })

  it('ignores a coherency window on a DISABLED (pass-through) entry', async () => {
    // The isolate-coherent profile spreads windows over entries a facade may still disable;
    // pass-through has nothing to keep coherent, so the window is inert rather than refused.
    const caches = createAppCaches({
      profile: {
        fragmentCatalog: {
          enabled: false,
          ttlInMsecs: 5 * 60_000,
          maxGroups: 10,
          maxItemsPerGroup: 4,
          coherencyWindowMsecs: 5_000,
        },
      },
    })
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(loads).toBe(2)
  })
})

describe('scheduleBackgroundWork', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('hands the preemptive refresh to the configured adopter, tagged with its reason', async () => {
    const adopted: BackgroundWorkMeta[] = []
    const settled: Promise<void>[] = []
    const caches = createAppCaches({
      profile: {
        fragmentCatalog: {
          enabled: true,
          ttlInMsecs: 600,
          maxGroups: 10,
          maxItemsPerGroup: 4,
          ttlLeftBeforeRefreshInMsecs: 450,
        },
      },
      scheduleBackgroundWork: (work, meta) => {
        adopted.push(meta)
        settled.push(work)
      },
    })
    const load = async () => [entry('a')]
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await sleep(250) // inside the refresh window
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await vi.waitFor(() => expect(adopted.length).toBeGreaterThan(0))
    expect(adopted[0]?.reason).toBe('refresh')
    expect(adopted[0]?.cacheId).toBe('fragment-catalog')
    // The contract the Worker's `ctx.waitUntil` relies on: the promise settles fulfilled.
    await expect(Promise.all(settled)).resolves.toBeDefined()
  })
})
