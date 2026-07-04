import { EventEmitter } from 'node:events'
import { createAppCaches } from '@cat-factory/caching'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CACHE_CHANNEL_PREFIX,
  buildCacheNotifications,
  type CacheRedisClient,
} from '../src/cacheNotifications.js'

// Drives the REAL layered-loader Redis notification classes (publisher envelope,
// consumer parsing, origin-uuid echo suppression) through the facade's
// buildCacheNotifications wiring — over fake ioredis clients sharing an in-memory
// bus, so no Redis server is needed (the redisPropagator tests' pattern). Two
// AppCaches instances stand in for two Node replicas.

const log = { info: () => {}, warn: () => {} }

class FakeBus extends EventEmitter {}

function fakeRedisClient(bus: FakeBus): CacheRedisClient {
  const listeners = new Map<(...args: never[]) => void, (...args: unknown[]) => void>()
  const subscribed = new Set<string>()
  return {
    status: 'ready',
    async publish(channel, message) {
      bus.emit('publish', channel, message)
      return 1
    },
    async subscribe(channel) {
      subscribed.add(channel)
      return 1
    },
    async unsubscribe(channel) {
      subscribed.delete(channel)
      return 1
    },
    on(event, listener) {
      if (event !== 'message') return
      const wrapped = (channel: unknown, message: unknown) => {
        if (subscribed.has(channel as string)) {
          ;(listener as unknown as (c: unknown, m: unknown) => void)(channel, message)
        }
      }
      listeners.set(listener, wrapped)
      bus.on('publish', wrapped)
    },
    removeListener(_event, listener) {
      const wrapped = listeners.get(listener)
      if (wrapped) bus.removeListener('publish', wrapped)
    },
    async quit(callback) {
      callback?.(null, 'OK')
      return 'OK'
    },
    disconnect() {},
  }
}

async function makeNode(bus: FakeBus, env: NodeJS.ProcessEnv = { REDIS_URL: 'redis://fake' }) {
  const factory = await buildCacheNotifications(env, log, {
    connect: () => fakeRedisClient(bus),
  })
  return createAppCaches({ notificationPairFactory: factory })
}

describe('buildCacheNotifications', () => {
  it('returns undefined (bare in-memory caches) when REDIS_URL is unset', async () => {
    expect(await buildCacheNotifications({}, log)).toBeUndefined()
  })

  it('propagates a group invalidation from one node to the other, suppressing own echoes', async () => {
    const bus = new FakeBus()
    const nodeA = await makeNode(bus)
    const nodeB = await makeNode(bus)
    const loads = { a: 0, b: 0 }
    const load = (node: 'a' | 'b') => async () => {
      loads[node] += 1
      return []
    }
    await nodeA.fragmentCatalog.get('ws1', 'ws1', load('a'))
    await nodeB.fragmentCatalog.get('ws1', 'ws1', load('b'))
    expect(loads).toEqual({ a: 1, b: 1 })

    // A write on node A drops the group locally and broadcasts it; node B must
    // reload while node A reloads exactly once (its own echo is suppressed).
    await nodeA.fragmentCatalog.invalidateGroup('ws1')
    await nodeA.fragmentCatalog.get('ws1', 'ws1', load('a'))
    await nodeB.fragmentCatalog.get('ws1', 'ws1', load('b'))
    expect(loads).toEqual({ a: 2, b: 2 })
    await nodeA.close()
    await nodeB.close()
  })

  it('leaves other groups untouched on the peer', async () => {
    const bus = new FakeBus()
    const nodeA = await makeNode(bus)
    const nodeB = await makeNode(bus)
    let bLoads = 0
    const load = async () => {
      bLoads += 1
      return []
    }
    await nodeB.fragmentCatalog.get('ws1', 'ws1', load)
    await nodeB.fragmentCatalog.get('ws2', 'ws2', load)
    await nodeA.fragmentCatalog.invalidateGroup('ws1')
    await nodeB.fragmentCatalog.get('ws1', 'ws1', load)
    await nodeB.fragmentCatalog.get('ws2', 'ws2', load)
    expect(bLoads).toBe(3)
  })

  it('publishes on the per-cache channel under the (overridable) prefix', async () => {
    const bus = new FakeBus()
    const channels: string[] = []
    bus.on('publish', (channel: string) => channels.push(channel))

    const nodeDefault = await makeNode(bus)
    await nodeDefault.fragmentCatalog.invalidateGroup('ws1')
    expect(channels.pop()).toBe(`${DEFAULT_CACHE_CHANNEL_PREFIX}:fragment-catalog`)

    const nodeCustom = await makeNode(bus, {
      REDIS_URL: 'redis://fake',
      REDIS_CACHE_CHANNEL_PREFIX: 'acme:cache',
    })
    await nodeCustom.fragmentCatalog.invalidateGroup('ws1')
    expect(channels.pop()).toBe('acme:cache:fragment-catalog')
  })
})
