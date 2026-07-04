import { describe, expect, it } from 'vitest'
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
  it('the isolate-safe profile only flips enabled off, keeping the tuning intact', () => {
    expect(ISOLATE_SAFE_APP_CACHES_PROFILE.fragmentCatalog).toEqual({
      ...DEFAULT_APP_CACHES_PROFILE.fragmentCatalog,
      enabled: false,
    })
  })
})
