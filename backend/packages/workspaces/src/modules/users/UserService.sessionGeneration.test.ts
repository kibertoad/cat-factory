import { describe, expect, it } from 'vitest'
import type { GroupCacheHandle, UserRepository } from '@cat-factory/kernel'
import { UserService } from './UserService.js'

// The two reads of a user's session generation, and why they are two.
//
// `sessionGeneration` gates ONE request and tolerates a bounded stale window by design — that is
// the whole reason the cache is here, since the check now runs on every authenticated request.
// `refreshSessionGeneration` serves a token MINT, where the value read is stamped into a bearer
// that outlives the cache entry: a stale read there does not cost a stale answer, it issues a
// token every replica refuses for its whole TTL, and one that gets MORE refused as the caches
// still agreeing with it expire. There is no waiting it out; the user is in a sign-in loop.
//
// The shape guarded here is the multi-replica one. A replica that missed a peer's invalidation
// (no Redis bus wired, or a bus hiccup) still holds the pre-bump number, and a login landing on
// it inside the TTL is exactly the case.

interface Cached {
  generation: number | null
}

/** A cache handle recording what it was asked, so the read path can be asserted, not inferred. */
function fakeCache() {
  const store = new Map<string, Cached>()
  const invalidated: string[] = []
  const handle = {
    get: async (key: string, _group: string, load: () => Promise<Cached>) => {
      const hit = store.get(key)
      if (hit) return hit
      const loaded = await load()
      store.set(key, loaded)
      return loaded
    },
    invalidate: async (key: string) => {
      invalidated.push(key)
      store.delete(key)
    },
    invalidateGroup: async () => {},
    invalidateAll: async () => {},
  } as unknown as GroupCacheHandle<Cached>
  /** Plant a value as a peer replica's missed invalidation would leave it: stale, unnoticed. */
  const seedStale = (key: string, generation: number) => store.set(key, { generation })
  return { handle, invalidated, seedStale, store }
}

function makeService(storedGeneration: number, cache = fakeCache()) {
  const reads: string[] = []
  const repository = {
    sessionGeneration: (userId: string) => {
      reads.push(userId)
      return Promise.resolve(storedGeneration)
    },
  } as unknown as UserRepository
  const service = new UserService({
    userRepository: repository,
    sessionGenerationCache: cache.handle,
  } as unknown as ConstructorParameters<typeof UserService>[0])
  return { service, cache, reads }
}

describe('UserService.sessionGeneration vs refreshSessionGeneration', () => {
  it('serves the per-request check from the cache, stale entry and all', async () => {
    // Not a defect: this is the accepted trade that keeps a stateless token revocable without a
    // store read per request, bounded by the TTL. It is asserted so the contrast below is a
    // deliberate difference rather than an accident of which method someone reached for.
    const { service, reads } = makeService(9, seededWith(4))

    expect(await service.sessionGeneration('usr_1')).toBe(4)
    expect(reads).toEqual([])
  })

  it('reads PAST a stale cache entry when the value is going into a token', async () => {
    // The bug this closes: minting from the stale `4` stamps a token the row (at `9`) refuses,
    // on this replica and every other, until it expires. The user signs in and is immediately
    // 401'd, and signing in again does the same thing.
    const { service, reads } = makeService(9, seededWith(4))

    expect(await service.refreshSessionGeneration('usr_1')).toBe(9)
    expect(reads).toEqual(['usr_1'])
  })

  it('leaves the cache holding what it read, so the token it minted verifies here', async () => {
    // Reading past the cache is only half. Without the repopulation, this replica's own
    // `verifySession` would go on answering `4` and refuse the token it has just issued — the
    // same sign-in loop, arrived at from the other side.
    const cache = seededWith(4)
    const { service } = makeService(9, cache)

    await service.refreshSessionGeneration('usr_1')

    expect(await service.sessionGeneration('usr_1')).toBe(9)
    expect(cache.invalidated).toEqual(['usr_1'])
  })

  it('reports an absent user as null rather than a generation', async () => {
    // `null` is "no such user" and `0` is "a fresh row"; flattening them is what would let a
    // deleted user's unexpired bearer go on being admitted.
    const { service } = makeService(null as unknown as number)

    expect(await service.refreshSessionGeneration('usr_gone')).toBeNull()
  })
})

function seededWith(generation: number) {
  const cache = fakeCache()
  cache.seedStale('usr_1', generation)
  return cache
}
