import type { WritebackPostKey, WritebackPostRepository } from '@cat-factory/kernel'
import { WRITEBACK_POST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the tracker writeback's exactly-once markers: the rows that keep a
// replaying durable driver, a double click or two concurrent requests from leaving a second copy of
// a comment on the issue a human is reading.
//
// The contract this pins is `claim`: ONE atomic statement that both decides and REPORTS the
// outcome (`claimed`, `posted`, `held`). D1 and Postgres express it with the same
// `ON CONFLICT ... DO UPDATE SET col = CASE ...` shape but different dialects, so a runtime that
// degraded it to a read-then-write, got the reclaim predicate wrong, or misreported who won would
// double-post on one store and not the other.

/**
 * Assert a runtime's {@link WritebackPostRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so a
 * shared database stays isolated between cases.
 */
export function defineWritebackPostSuite(
  name: string,
  makeRepo: () => WritebackPostRepository,
): void {
  describe(`[${name}] writeback post marker parity`, () => {
    let seq = 0
    const nextKey = (over: Partial<WritebackPostKey> = {}): WritebackPostKey => {
      seq += 1
      return {
        workspaceId: `ws-${name}-wb-${seq}-${Math.floor(Math.random() * 1e9)}`,
        kind: 'review_questions',
        subjectId: 'rr_1',
        issueRef: 'github:acme/api#42',
        discriminator: '1',
        ...over,
      }
    }

    /** A claim taken at `now` with the standard abandonment window. */
    const at = (now: number) => ({ now, reclaimPendingBefore: now - WRITEBACK_POST_CLAIM_TTL_MS })
    /** A claim taken at `now` by a caller that never re-takes a pending row. */
    const never = (now: number) => ({ now, reclaimPendingBefore: null })

    it('claims an unseen key exactly once and reports the live claim as held', async () => {
      const repo = makeRepo()
      const key = nextKey()
      expect(await repo.claim(key, at(100))).toBe('claimed')
      expect(await repo.claim(key, at(200))).toBe('held')
      expect(await repo.get(key)).toMatchObject({ status: 'pending', attempts: 1, updatedAt: 100 })
    })

    it('lets exactly one of several concurrent claims win', async () => {
      const repo = makeRepo()
      const key = nextKey()
      const results = await Promise.all(Array.from({ length: 6 }, () => repo.claim(key, at(5))))
      expect(results.filter((r) => r === 'claimed')).toHaveLength(1)
      expect(results.filter((r) => r === 'held')).toHaveLength(5)
      expect((await repo.get(key))?.attempts).toBe(1)
    })

    it('reports a posted marker as posted, however old, and never re-claims it', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'posted' }, 2)
      expect(await repo.claim(key, at(1_000 * WRITEBACK_POST_CLAIM_TTL_MS))).toBe('posted')
      expect(await repo.get(key)).toMatchObject({ status: 'posted', error: null, updatedAt: 2 })
    })

    it('re-claims a failed marker, counting the attempt and clearing the old error', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'failed', error: 'tracker down' }, 2)
      expect((await repo.get(key))?.error).toBe('tracker down')
      expect(await repo.claim(key, never(3))).toBe('claimed')
      expect(await repo.get(key)).toMatchObject({ status: 'pending', attempts: 2, error: null })
    })

    it('holds a fresh pending claim and re-takes an abandoned one', async () => {
      const repo = makeRepo()
      const key = nextKey()
      const start = 10 * WRITEBACK_POST_CLAIM_TTL_MS
      await repo.claim(key, at(start))
      expect(await repo.claim(key, at(start + WRITEBACK_POST_CLAIM_TTL_MS - 1))).toBe('held')
      expect((await repo.get(key))?.attempts).toBe(1)
      const after = start + WRITEBACK_POST_CLAIM_TTL_MS
      expect(await repo.claim(key, at(after))).toBe('claimed')
      expect(await repo.get(key)).toMatchObject({ attempts: 2, updatedAt: after })
      expect(await repo.claim(key, at(after))).toBe('held')
    })

    it('never re-takes a pending claim when the caller passes no cutoff', async () => {
      const repo = makeRepo()
      const key = nextKey({ kind: 'refined_requirements', discriminator: 'a'.repeat(64) })
      await repo.claim(key, never(1))
      expect(await repo.claim(key, never(1_000 * WRITEBACK_POST_CLAIM_TTL_MS))).toBe('held')
      expect(await repo.get(key)).toMatchObject({ status: 'pending', attempts: 1, updatedAt: 1 })
    })

    it('keys on all five parts', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'posted' }, 1)
      expect(await repo.claim({ ...key, discriminator: '2' }, at(2))).toBe('claimed')
      expect(await repo.claim({ ...key, issueRef: 'jira:ENG-7' }, at(2))).toBe('claimed')
      expect(await repo.claim({ ...key, subjectId: 'rr_2' }, at(2))).toBe('claimed')
      expect(await repo.claim({ ...key, kind: 'refined_requirements' }, at(2))).toBe('claimed')
      expect(await repo.get(key)).toMatchObject({ status: 'posted' })
    })

    it('reads null for an unseen key, and settling one conjures no marker', async () => {
      const repo = makeRepo()
      const key = nextKey()
      expect(await repo.get(key)).toBeNull()
      await repo.settle(key, { status: 'posted' }, 1)
      expect(await repo.get(key)).toBeNull()
    })
  })
}
