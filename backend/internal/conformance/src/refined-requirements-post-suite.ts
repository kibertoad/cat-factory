import type {
  RefinedRequirementsPostKey,
  RefinedRequirementsPostRepository,
} from '@cat-factory/kernel'
import { REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the refined-requirements post markers: the rows that keep a repeated
// request from leaving a second copy of a requirements document on a customer's tracker issue.
// `claim` must be one atomic statement on both facades (D1's `ON CONFLICT … DO UPDATE … WHERE …
// RETURNING` and Drizzle's `onConflictDoUpdate({ setWhere })`), so a dialect that degraded it to a
// read-then-write, or got the retry predicate wrong, fails here rather than on a customer issue.

/** Assert a runtime's {@link RefinedRequirementsPostRepository} behaves like the others. */
export function defineRefinedRequirementsPostSuite(
  name: string,
  makeRepo: () => RefinedRequirementsPostRepository,
): void {
  describe(`[${name}] refined requirements post marker parity`, () => {
    let seq = 0
    const nextKey = (
      over: Partial<RefinedRequirementsPostKey> = {},
    ): RefinedRequirementsPostKey => {
      seq += 1
      return {
        workspaceId: `ws-${name}-rr-${seq}-${Math.floor(Math.random() * 1e9)}`,
        reviewId: 'rrv_1',
        issueRef: 'jira:ENG-7',
        documentHash: 'a'.repeat(64),
        ...over,
      }
    }
    const at = (now: number) => ({
      now,
      reclaimPendingBefore: now - REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS,
    })

    it('claims an unseen key exactly once', async () => {
      const repo = makeRepo()
      const key = nextKey()
      expect(await repo.claim(key, at(100))).toBe(true)
      expect(await repo.claim(key, at(200))).toBe(false)
      expect(await repo.get(key)).toMatchObject({ status: 'pending', attempts: 1, updatedAt: 100 })
    })

    it('never re-claims a posted marker, however old', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'posted' }, 2)
      expect(await repo.claim(key, at(1_000 * REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS))).toBe(false)
      expect(await repo.get(key)).toMatchObject({ status: 'posted', error: null, updatedAt: 2 })
    })

    it('re-claims a failed marker, counting the attempt and clearing the old error', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'failed', error: 'tracker down' }, 2)
      expect((await repo.get(key))?.error).toBe('tracker down')
      expect(await repo.claim(key, at(3))).toBe(true)
      expect(await repo.get(key)).toMatchObject({ status: 'pending', attempts: 2, error: null })
    })

    it('holds a fresh pending claim and re-takes an abandoned one', async () => {
      const repo = makeRepo()
      const key = nextKey()
      const start = 10 * REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS
      await repo.claim(key, at(start))
      expect(await repo.claim(key, at(start + REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS - 1))).toBe(
        false,
      )
      const after = start + REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS
      expect(await repo.claim(key, at(after))).toBe(true)
      expect(await repo.get(key)).toMatchObject({ attempts: 2, updatedAt: after })
    })

    it('keys on all four parts: a revised document or another issue posts independently', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'posted' }, 1)
      expect(await repo.claim({ ...key, documentHash: 'b'.repeat(64) }, at(2))).toBe(true)
      expect(await repo.claim({ ...key, issueRef: 'github:acme/web#3' }, at(2))).toBe(true)
      expect(await repo.claim({ ...key, reviewId: 'rrv_2' }, at(2))).toBe(true)
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
