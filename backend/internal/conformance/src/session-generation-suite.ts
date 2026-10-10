import type { UserRecord, UserRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-user SESSION GENERATION — the column that makes a stateless
// session token revocable.
//
// The comparison itself is runtime-neutral (one number against another, in `verifySession`), but
// everything that could make it WRONG is per-store: the default a fresh row carries, whether the
// increment is evaluated by the database or read-modify-written in JS, whether the new value is
// actually returned, and what happens for a user id no row matches. Each of those has an obvious
// implementation that passes a single-runtime test and diverges across the two — a `+ 1` computed
// in the repository, for instance, works perfectly until two revocations race, which is exactly
// the moment somebody is being offboarded.
//
// The security property under test is stated once here: a revocation must never report success
// without having moved the row, and the value it returns must be the value the row now holds.

/**
 * Assert a runtime's session-generation half of {@link UserRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids are unique per case so the
 * shared database stays isolated between them.
 */
export function defineSessionGenerationSuite(name: string, makeRepo: () => UserRepository): void {
  describe(`[${name}] session-generation parity`, () => {
    let seq = 0
    const nextId = () => {
      seq += 1
      return `usr-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
    }

    const user = (id: string): UserRecord => ({
      id,
      name: 'Ada Lovelace',
      // Null rather than an address: `users.email` is uniquely indexed where non-null, so a fixed
      // value here would collide between cases on the shared database.
      email: null,
      avatarUrl: null,
      createdAt: 1_000,
    })

    it('starts a freshly created user at generation 0', async () => {
      // The DEFAULT is load-bearing: it is what every pre-existing row got at migration time, and
      // a store that defaulted to null instead would refuse every session it ever minted.
      const repo = makeRepo()
      const id = nextId()
      await repo.create(user(id))

      expect(await repo.sessionGeneration(id)).toBe(0)
    })

    it('answers NULL for a user with no row, distinctly from generation 0', async () => {
      // The two must not collapse. `0` admits a token stamped 0; `null` is what refuses a deleted
      // user's still-unexpired bearer, and a store returning 0 for a missing row would keep
      // authenticating somebody the platform no longer has.
      const repo = makeRepo()

      expect(await repo.sessionGeneration(nextId())).toBeNull()
    })

    it('advances by one per bump and returns the value the row now holds', async () => {
      const repo = makeRepo()
      const id = nextId()
      await repo.create(user(id))

      expect(await repo.bumpSessionGeneration(id)).toBe(1)
      expect(await repo.sessionGeneration(id)).toBe(1)
      expect(await repo.bumpSessionGeneration(id)).toBe(2)
      expect(await repo.sessionGeneration(id)).toBe(2)
    })

    it('gives concurrent revocations distinct generations, never the same successor', async () => {
      // The regression this exists for: computing `current + 1` in the repository. Two admins
      // offboarding at once would both read the same value and both write the same successor, so
      // one revocation's returned generation would name a row state that never existed — and a
      // session minted against it would be admitted. Evaluating the increment in the STORE is what
      // makes the returned values a permutation of 1..N instead.
      const repo = makeRepo()
      const id = nextId()
      await repo.create(user(id))

      const returned = await Promise.all([
        repo.bumpSessionGeneration(id),
        repo.bumpSessionGeneration(id),
        repo.bumpSessionGeneration(id),
      ])

      expect([...returned].sort((a, b) => a - b)).toEqual([1, 2, 3])
      expect(await repo.sessionGeneration(id)).toBe(3)
    })

    it('REJECTS a bump for a user with no row rather than reporting a revocation', async () => {
      // Matching no row is not success. An offboarding tool that reported one would tell an
      // operator that access was withdrawn when nothing was touched.
      const repo = makeRepo()

      await expect(repo.bumpSessionGeneration(nextId())).rejects.toThrow()
    })

    it('scopes a bump to the one user, leaving everybody else signed in', async () => {
      // A revocation is per person. A predicate-less UPDATE would pass every assertion above and
      // sign out the whole deployment.
      const repo = makeRepo()
      const target = nextId()
      const bystander = nextId()
      await repo.create(user(target))
      await repo.create(user(bystander))

      await repo.bumpSessionGeneration(target)

      expect(await repo.sessionGeneration(target)).toBe(1)
      expect(await repo.sessionGeneration(bystander)).toBe(0)
    })
  })
}
