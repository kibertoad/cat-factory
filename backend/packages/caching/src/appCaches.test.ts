import { describe, expect, it, vi } from 'vitest'
import type { ResolvedCatalogEntry } from '@cat-factory/kernel'
import { AbstractNotificationConsumer } from 'layered-loader/dist/lib/notifications/AbstractNotificationConsumer.js'
import type { InMemoryGroupCache } from 'layered-loader/dist/lib/memory/InMemoryGroupCache.js'
import {
  DEFAULT_APP_CACHES_PROFILE,
  ISOLATE_SAFE_APP_CACHES_PROFILE,
  createAppCaches,
} from './appCaches.js'
import type { GroupCacheNotifications, GroupNotificationPairFactory } from './appCaches.js'

// The seam-level behaviour every consuming service relies on: read-through with
// in-flight dedup, group/key/full invalidation, the pass-through (Worker
// isolate-safe) profile, and — via a fake notification pair sharing an in-memory
// bus (the RedisWebSocketPropagator tests' fake-client pattern) — cross-instance
// invalidation without a live Redis.

function entry(id: string): ResolvedCatalogEntry {
  return {
    id,
    version: '1.0.0',
    title: id,
    category: null,
    summary: `${id} summary`,
    body: `${id} body`,
    appliesTo: null,
    tags: null,
    source: null,
    documentRef: null,
    docViaWorkspaceId: null,
    resolvedAt: null,
    tier: 'workspace',
  }
}

describe('createAppCaches (bare in-memory)', () => {
  it('read-through caches: the second get of a key does not re-run the load', async () => {
    const caches = createAppCaches()
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    const first = await caches.fragmentCatalog.get('k', 'ws1', load)
    const second = await caches.fragmentCatalog.get('k', 'ws1', load)
    expect(first.map((e) => e.id)).toEqual(['a'])
    expect(second.map((e) => e.id)).toEqual(['a'])
    expect(loads).toBe(1)
  })

  it('deduplicates concurrent loads of the same key', async () => {
    const caches = createAppCaches()
    let loads = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = async () => {
      loads += 1
      await gate
      return [entry('a')]
    }
    const [first, second] = [
      caches.fragmentCatalog.get('k', 'ws1', load),
      caches.fragmentCatalog.get('k', 'ws1', load),
    ]
    release()
    await Promise.all([first, second])
    expect(loads).toBe(1)
  })

  it('a load error propagates and is not cached', async () => {
    const caches = createAppCaches()
    let loads = 0
    await expect(
      caches.fragmentCatalog.get('k', 'ws1', async () => {
        loads += 1
        throw new Error('source down')
      }),
    ).rejects.toThrow('source down')
    const recovered = await caches.fragmentCatalog.get('k', 'ws1', async () => {
      loads += 1
      return [entry('a')]
    })
    expect(recovered).toHaveLength(1)
    expect(loads).toBe(2)
  })

  it('invalidateGroup drops only that group', async () => {
    const caches = createAppCaches()
    const loads = { ws1: 0, ws2: 0 }
    const loadFor = (ws: 'ws1' | 'ws2') => async () => {
      loads[ws] += 1
      return [entry(ws)]
    }
    await caches.fragmentCatalog.get('k', 'ws1', loadFor('ws1'))
    await caches.fragmentCatalog.get('k', 'ws2', loadFor('ws2'))
    await caches.fragmentCatalog.invalidateGroup('ws1')
    await caches.fragmentCatalog.get('k', 'ws1', loadFor('ws1'))
    await caches.fragmentCatalog.get('k', 'ws2', loadFor('ws2'))
    expect(loads).toEqual({ ws1: 2, ws2: 1 })
  })

  it('invalidate drops one key; invalidateAll drops everything', async () => {
    const caches = createAppCaches()
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    await caches.fragmentCatalog.get('k1', 'ws1', load)
    await caches.fragmentCatalog.get('k2', 'ws1', load)
    await caches.fragmentCatalog.invalidate('k1', 'ws1')
    await caches.fragmentCatalog.get('k1', 'ws1', load)
    await caches.fragmentCatalog.get('k2', 'ws1', load)
    expect(loads).toBe(3)
    await caches.fragmentCatalog.invalidateAll()
    await caches.fragmentCatalog.get('k1', 'ws1', load)
    await caches.fragmentCatalog.get('k2', 'ws1', load)
    expect(loads).toBe(5)
  })

  it('the isolate-safe (pass-through) profile runs the load on every get', async () => {
    const caches = createAppCaches({ profile: ISOLATE_SAFE_APP_CACHES_PROFILE })
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

// ---------------------------------------------------------------------------
// The staleness probe on in-memory-only loaders (layered-loader ≥ 14.5.3): an
// entry hit inside the preemptive-refresh window runs the caller's cheap
// `isStillCurrent` probe in the background — TTL bump on true (no reload),
// full background reload on false, blind reload when no probe was passed.
// ---------------------------------------------------------------------------

describe('staleness probe (preemptive in-memory refresh)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // Wide margins so scheduler jitter can't flake the window checks: entries
  // enter the refresh window 150ms after a load (600 - 450) and expire at 600ms.
  const PROBED_PROFILE = {
    fragmentCatalog: {
      enabled: true,
      ttlInMsecs: 600,
      maxGroups: 10,
      maxItemsPerGroup: 4,
      ttlLeftBeforeRefreshInMsecs: 450,
    },
  }

  it('bumps the TTL on a current probe instead of re-running the load', async () => {
    const caches = createAppCaches({ profile: PROBED_PROFILE })
    let loads = 0
    let probes = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    const stillCurrent = async () => {
      probes += 1
      return true
    }
    await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    await sleep(250) // inside the refresh window (≈350ms TTL left < 450)
    await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    await vi.waitFor(() => expect(probes).toBe(1))
    // Probe said current → TTL bumped, no reload; the entry outlives its
    // ORIGINAL 600ms expiry without ever re-running the load.
    await sleep(250) // ≈500ms after first load; original expiry would be 600ms
    const served = await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    expect(served.map((e) => e.id)).toEqual(['a'])
    expect(loads).toBe(1)
  })

  it('falls back to a full background reload when the probe reports stale', async () => {
    const caches = createAppCaches({ profile: PROBED_PROFILE })
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry(`v${loads}`)]
    }
    const stillCurrent = async () => false
    await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    await sleep(250) // enter the window
    const inWindow = await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    expect(inWindow.map((e) => e.id)).toEqual(['v1']) // reader never blocks on the refresh
    await vi.waitFor(() => expect(loads).toBe(2)) // background reload ran
    const refreshed = await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    expect(refreshed.map((e) => e.id)).toEqual(['v2'])
  })

  it('a read without a probe degrades to the blind background reload', async () => {
    const caches = createAppCaches({ profile: PROBED_PROFILE })
    let loads = 0
    const load = async () => {
      loads += 1
      return [entry('a')]
    }
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await sleep(250) // enter the window
    await caches.fragmentCatalog.get('k', 'ws1', load)
    await vi.waitFor(() => expect(loads).toBe(2))
  })

  it('a profile without a refresh window never probes (probe arg is inert)', async () => {
    const caches = createAppCaches() // default profile: no ttlLeftBeforeRefreshInMsecs
    let probes = 0
    const load = async () => [entry('a')]
    const stillCurrent = async () => {
      probes += 1
      return true
    }
    await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    await caches.fragmentCatalog.get('k', 'ws1', load, stillCurrent)
    expect(probes).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-instance invalidation through a fake notification pair: two AppCaches
// instances ("nodes") share an in-memory bus that mirrors the Redis group
// notification protocol (delete-from-group / delete-group / clear envelopes
// tagged with an origin id so a node ignores its own echoes).
// ---------------------------------------------------------------------------

type BusCommand =
  | { actionId: 'DELETE_FROM_GROUP'; key: string; group: string; originUuid: string }
  | { actionId: 'DELETE_GROUP'; group: string; originUuid: string }
  | { actionId: 'CLEAR'; originUuid: string }

class FakeBus {
  private readonly subscribers: ((command: BusCommand) => void)[] = []
  publish(command: BusCommand): void {
    for (const subscriber of this.subscribers) subscriber(command)
  }
  subscribe(handler: (command: BusCommand) => void): void {
    this.subscribers.push(handler)
  }
}

class FakeGroupConsumer<T> extends AbstractNotificationConsumer<T, InMemoryGroupCache<T>> {
  constructor(
    private readonly bus: FakeBus,
    serverUuid: string,
  ) {
    super(serverUuid)
  }
  async subscribe(): Promise<void> {
    this.bus.subscribe((command) => {
      if (command.originUuid === this.serverUuid) return // own echo
      if (command.actionId === 'DELETE_FROM_GROUP') {
        this.targetCache.deleteFromGroup(command.key, command.group)
      } else if (command.actionId === 'DELETE_GROUP') {
        this.targetCache.deleteGroup(command.group)
      } else {
        this.targetCache.clear()
      }
    })
  }
  async close(): Promise<void> {}
}

function fakePairFactory(bus: FakeBus, nodeId: string): GroupNotificationPairFactory {
  return <T>(cacheName: string): GroupCacheNotifications<T> => {
    const serverUuid = `${nodeId}:${cacheName}`
    return {
      consumer: new FakeGroupConsumer<T>(bus, serverUuid),
      publisher: {
        channel: `test:${cacheName}`,
        errorHandler: () => {},
        subscribe: async () => {},
        close: async () => {},
        deleteFromGroup: async (key: string, group: string) =>
          bus.publish({ actionId: 'DELETE_FROM_GROUP', key, group, originUuid: serverUuid }),
        deleteGroup: async (group: string) =>
          bus.publish({ actionId: 'DELETE_GROUP', group, originUuid: serverUuid }),
        clear: async () => bus.publish({ actionId: 'CLEAR', originUuid: serverUuid }),
      },
    }
  }
}

describe('createAppCaches (notification pair across two instances)', () => {
  function twoNodes() {
    const bus = new FakeBus()
    const nodeA = createAppCaches({ notificationPairFactory: fakePairFactory(bus, 'a') })
    const nodeB = createAppCaches({ notificationPairFactory: fakePairFactory(bus, 'b') })
    const loads = { a: 0, b: 0 }
    const loadFor = (node: 'a' | 'b') => async () => {
      loads[node] += 1
      return [entry(node)]
    }
    return { nodeA, nodeB, loads, loadFor }
  }

  it('an invalidateGroup on one node evicts the peer, and never itself twice', async () => {
    const { nodeA, nodeB, loads, loadFor } = twoNodes()
    await nodeA.fragmentCatalog.get('k', 'ws1', loadFor('a'))
    await nodeB.fragmentCatalog.get('k', 'ws1', loadFor('b'))
    expect(loads).toEqual({ a: 1, b: 1 })

    await nodeA.fragmentCatalog.invalidateGroup('ws1')
    // The peer dropped its entry and reloads; the origin reloads once (its own
    // local eviction), not twice (its echo is suppressed by origin id).
    await nodeA.fragmentCatalog.get('k', 'ws1', loadFor('a'))
    await nodeB.fragmentCatalog.get('k', 'ws1', loadFor('b'))
    expect(loads).toEqual({ a: 2, b: 2 })
  })

  it('a single-key invalidation reaches the peer without touching other keys', async () => {
    const { nodeA, nodeB, loads, loadFor } = twoNodes()
    await nodeB.fragmentCatalog.get('k1', 'ws1', loadFor('b'))
    await nodeB.fragmentCatalog.get('k2', 'ws1', loadFor('b'))
    await nodeA.fragmentCatalog.invalidate('k1', 'ws1')
    await nodeB.fragmentCatalog.get('k1', 'ws1', loadFor('b'))
    await nodeB.fragmentCatalog.get('k2', 'ws1', loadFor('b'))
    expect(loads.b).toBe(3)
  })

  it('invalidateAll clears every peer', async () => {
    const { nodeA, nodeB, loads, loadFor } = twoNodes()
    await nodeB.fragmentCatalog.get('k', 'ws1', loadFor('b'))
    await nodeB.fragmentCatalog.get('k', 'ws2', loadFor('b'))
    await nodeA.fragmentCatalog.invalidateAll()
    await nodeB.fragmentCatalog.get('k', 'ws1', loadFor('b'))
    await nodeB.fragmentCatalog.get('k', 'ws2', loadFor('b'))
    expect(loads.b).toBe(4)
  })
})

describe('profiles', () => {
  it('the isolate-safe profile only flips the DB-backed catalog to pass-through', () => {
    expect(ISOLATE_SAFE_APP_CACHES_PROFILE.fragmentCatalog).toEqual({
      ...DEFAULT_APP_CACHES_PROFILE.fragmentCatalog,
      enabled: false,
    })
  })

  it('keeps the self-verifying document-body cache enabled on the isolate-safe profile', () => {
    // Its entries are external page content re-validated by a cheap version probe,
    // so a Worker isolate can hold a real TTL without a cross-isolate bus.
    expect(ISOLATE_SAFE_APP_CACHES_PROFILE.fragmentDocumentBody).toEqual(
      DEFAULT_APP_CACHES_PROFILE.fragmentDocumentBody,
    )
    expect(ISOLATE_SAFE_APP_CACHES_PROFILE.fragmentDocumentBody.enabled).toBe(true)
  })

  it('makes the repo projection pass-through on the isolate-safe profile (mutable D1 state)', () => {
    expect(ISOLATE_SAFE_APP_CACHES_PROFILE.repoProjection).toEqual({
      ...DEFAULT_APP_CACHES_PROFILE.repoProjection,
      enabled: false,
    })
    expect(DEFAULT_APP_CACHES_PROFILE.repoProjection.enabled).toBe(true)
  })
})

describe('repoProjection cache (slice 3)', () => {
  const repos = (name: string) => [{ githubId: 1, owner: 'acme', name } as never]

  it('reads through per workspace and invalidateGroup drops that group', async () => {
    const caches = createAppCaches()
    let calls = 0
    const load = (name: string) => async () => {
      calls++
      return repos(name)
    }

    const first = await caches.repoProjection.get('ws1', 'ws1', load('a'))
    await caches.repoProjection.get('ws1', 'ws1', load('a'))
    expect((first[0] as { name: string }).name).toBe('a')
    expect(calls).toBe(1) // second read served from cache

    await caches.repoProjection.invalidateGroup('ws1')
    const third = await caches.repoProjection.get('ws1', 'ws1', load('b'))
    expect((third[0] as { name: string }).name).toBe('b')
    expect(calls).toBe(2) // re-listed after invalidation
  })

  it('is pass-through under the isolate-safe profile (loads on every get)', async () => {
    const caches = createAppCaches({ profile: ISOLATE_SAFE_APP_CACHES_PROFILE })
    let calls = 0
    const load = async () => {
      calls++
      return repos('a')
    }
    await caches.repoProjection.get('ws1', 'ws1', load)
    await caches.repoProjection.get('ws1', 'ws1', load)
    expect(calls).toBe(2)
  })
})
