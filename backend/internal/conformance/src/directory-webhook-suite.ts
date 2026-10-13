import type { DirectoryWebhookRecord, DirectoryWebhookRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the directory webhook endpoints (ADR 0067). The two
// properties a sequential test cannot see are the ones this suite races: the per-account cap under
// concurrent registrations (atomic in one SQLite statement on D1, an advisory lock on Postgres),
// and the delivery lease that keeps two sweepers from pushing overlapping pages.

export function defineDirectoryWebhookSuite(
  name: string,
  makeRepo: () => DirectoryWebhookRepository,
): void {
  describe(`[${name}] directory webhook repository parity`, () => {
    let n = 0
    const account = () => {
      n += 1
      return `acc-${name}-hook-${n}-${Math.floor(Math.random() * 1e9)}`
    }
    const record = (
      accountId: string,
      id: string,
      overrides: Partial<DirectoryWebhookRecord> = {},
    ): DirectoryWebhookRecord => ({
      accountId,
      id,
      url: 'https://hooks.example.com/dir',
      enabled: true,
      secretSealed: null,
      deliveredSeq: 5,
      updatedAt: 1,
      ...overrides,
    })

    it('round-trips an endpoint and keeps the delivery position on edit', async () => {
      const repo = makeRepo()
      const acc = account()
      expect(await repo.put(record(acc, 'a', { secretSealed: 'sealed' }), 10)).toBe('stored')
      expect(await repo.get(acc, 'a')).toEqual(record(acc, 'a', { secretSealed: 'sealed' }))

      // An edit carries a stale position; the stored one is the sweeper's and must survive.
      expect(await repo.claim(acc, 'a', 't1', 100, 200)).toBe(5)
      expect(await repo.complete(acc, 'a', 't1', 9)).toBe(true)
      await repo.put(record(acc, 'a', { url: 'https://other.example.com/', deliveredSeq: 0 }), 10)
      expect(await repo.get(acc, 'a')).toMatchObject({
        url: 'https://other.example.com/',
        deliveredSeq: 9,
      })

      await repo.put(record(acc, 'b', { enabled: false }), 10)
      expect((await repo.list(acc)).map((w) => w.id)).toEqual(['a', 'b'])
      const enabled = (await repo.listEnabled()).filter((w) => w.accountId === acc)
      expect(enabled.map((w) => w.id)).toEqual(['a'])

      await repo.delete(acc, 'a')
      expect(await repo.get(acc, 'a')).toBeNull()
    })

    it('admits at most the cap when registrations race, and still edits a full account', async () => {
      const repo = makeRepo()
      const acc = account()
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, i) => repo.put(record(acc, `h${i}`), 3)),
      )
      expect(outcomes.filter((o) => o === 'stored')).toHaveLength(3)
      expect(await repo.list(acc)).toHaveLength(3)
      const kept = (await repo.list(acc))[0]!.id
      expect(await repo.put(record(acc, kept, { enabled: false }), 3)).toBe('stored')
    })

    it('grants the lease to one concurrent claimer and moves the position only under it', async () => {
      const repo = makeRepo()
      const acc = account()
      await repo.put(record(acc, 'a'), 10)
      const claims = await Promise.all([
        repo.claim(acc, 'a', 'x', 100, 200),
        repo.claim(acc, 'a', 'y', 100, 200),
      ])
      expect(claims.filter((c) => c === 5)).toHaveLength(1)
      expect(claims.filter((c) => c === null)).toHaveLength(1)
      const loser = claims[0] === null ? 'x' : 'y'
      const winner = loser === 'x' ? 'y' : 'x'

      // The loser's token moves nothing and drops nothing.
      expect(await repo.complete(acc, 'a', loser, 9)).toBe(false)
      await repo.release(acc, 'a', loser)
      expect(await repo.claim(acc, 'a', 'z', 150, 250)).toBeNull()

      expect(await repo.complete(acc, 'a', winner, 8)).toBe(true)
      expect((await repo.get(acc, 'a'))?.deliveredSeq).toBe(8)
      expect(await repo.claim(acc, 'a', 'z', 150, 250)).toBe(8)
    })

    it('re-grants an expired lease, and refuses a disabled endpoint', async () => {
      const repo = makeRepo()
      const acc = account()
      await repo.put(record(acc, 'a'), 10)
      expect(await repo.claim(acc, 'a', 'dead', 100, 200)).toBe(5)
      expect(await repo.claim(acc, 'a', 'next', 199, 299)).toBeNull()
      expect(await repo.claim(acc, 'a', 'next', 200, 300)).toBe(5)
      // The expired holder can no longer complete; the new one can.
      expect(await repo.complete(acc, 'a', 'dead', 9)).toBe(false)
      await repo.release(acc, 'a', 'next')
      expect((await repo.get(acc, 'a'))?.deliveredSeq).toBe(5)

      await repo.put(record(acc, 'a', { enabled: false }), 10)
      expect(await repo.claim(acc, 'a', 'off', 400, 500)).toBeNull()
    })
  })
}
