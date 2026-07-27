import type { ReviewQuestionPostKey, ReviewQuestionPostRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the headless clarification loop's question-writeback markers — the
// rows that keep a REPLAYING durable driver from re-posting a parked review's findings onto the
// tracker issue a human is reading (docs/initiatives/headless-clarification-loop.md, D8).
//
// The contract this pins is `claim`, and it is the whole reason the suite exists: it must be ONE
// atomic statement whose insert-or-conditional-update reports whether the caller now owns the
// post. Both facades express that differently — D1's `ON CONFLICT … DO UPDATE … WHERE … RETURNING`
// versus Drizzle's `onConflictDoUpdate({ setWhere })` — so a runtime that quietly degraded it to a
// read-then-write, or that got the `failed`-only retry predicate wrong, would double-post on one
// store and not the other. That is exactly the drift a shared suite has to catch: the failure is
// invisible in code review and only shows up as a spammed customer issue.

/**
 * Assert a runtime's {@link ReviewQuestionPostRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so a
 * shared database stays isolated between cases.
 */
export function defineReviewQuestionPostSuite(
  name: string,
  makeRepo: () => ReviewQuestionPostRepository,
): void {
  describe(`[${name}] review question post marker parity`, () => {
    let seq = 0
    const nextKey = (over: Partial<ReviewQuestionPostKey> = {}): ReviewQuestionPostKey => {
      seq += 1
      return {
        workspaceId: `ws-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`,
        reviewId: 'rr_1',
        iteration: 1,
        issueRef: 'github:acme/api#42',
        ...over,
      }
    }

    it('claims an unseen key exactly once', async () => {
      const repo = makeRepo()
      const key = nextKey()
      expect(await repo.claim(key, 100)).toBe(true)
      // The second caller is a driver replay: it must NOT be told to post.
      expect(await repo.claim(key, 200)).toBe(false)

      const stored = await repo.get(key)
      expect(stored?.status).toBe('pending')
      expect(stored?.attempts).toBe(1)
      expect(stored?.updatedAt).toBe(100)
    })

    it('refuses to re-claim a posted marker (the iteration is done)', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, 1)
      await repo.settle(key, { status: 'posted' }, 2)

      expect(await repo.claim(key, 3)).toBe(false)
      const stored = await repo.get(key)
      expect(stored?.status).toBe('posted')
      expect(stored?.error).toBeNull()
      expect(stored?.updatedAt).toBe(2)
    })

    it('re-claims a FAILED marker, so a tracker outage is retried and the attempt counted', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, 1)
      await repo.settle(key, { status: 'failed', error: 'tracker down' }, 2)
      expect((await repo.get(key))?.error).toBe('tracker down')

      expect(await repo.claim(key, 3)).toBe(true)
      const retried = await repo.get(key)
      expect(retried?.status).toBe('pending')
      expect(retried?.attempts).toBe(2)
      // The previous failure's message is cleared with the retry, so a later `failed` row always
      // carries the error that actually caused it.
      expect(retried?.error).toBeNull()

      await repo.settle(key, { status: 'posted' }, 4)
      expect((await repo.get(key))?.status).toBe('posted')
    })

    it('keys on all four parts — a new iteration or a second issue posts independently', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, 1)
      await repo.settle(key, { status: 'posted' }, 1)

      // A re-review bumps the iteration: its findings are new questions and must be asked.
      const nextIteration = { ...key, iteration: 2 }
      expect(await repo.claim(nextIteration, 2)).toBe(true)

      // A second linked issue on the same review + iteration gets its own comment.
      const otherIssue = { ...key, issueRef: 'jira:ENG-7' }
      expect(await repo.claim(otherIssue, 2)).toBe(true)

      // …and a different review is independent of both.
      expect(await repo.claim({ ...key, reviewId: 'rr_2' }, 2)).toBe(true)
    })

    it('returns null for a key that was never claimed', async () => {
      const repo = makeRepo()
      expect(await repo.get(nextKey())).toBeNull()
    })

    it('settling an unclaimed key is a harmless no-op', async () => {
      // `settle` follows a successful `claim` on every real path; a lost row must not throw and
      // must not conjure a marker that would then suppress a legitimate post.
      const repo = makeRepo()
      const key = nextKey()
      await repo.settle(key, { status: 'posted' }, 1)
      expect(await repo.get(key)).toBeNull()
    })
  })
}
