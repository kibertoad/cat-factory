import type { DirectoryWebhookRecord, DirectoryWebhookRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the directory webhook endpoints (directory sync slice 4). The two
// properties a sequential test cannot see are the ones this suite races: the per-account cap under
// concurrent registrations (atomic in one SQLite statement on D1, an advisory lock on Postgres),
// and the delivery compare-and-swap that keeps two sweepers from pushing the same page.

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
      await repo.advance(acc, 'a', 5, 9)
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

    it('moves the delivery position only from the expected value', async () => {
      const repo = makeRepo()
      const acc = account()
      await repo.put(record(acc, 'a'), 10)
      const claims = await Promise.all([repo.advance(acc, 'a', 5, 8), repo.advance(acc, 'a', 5, 8)])
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(await repo.advance(acc, 'a', 5, 9)).toBe(false)
      expect(await repo.advance(acc, 'a', 8, 5)).toBe(true)
      expect((await repo.get(acc, 'a'))?.deliveredSeq).toBe(5)
    })
  })
}
