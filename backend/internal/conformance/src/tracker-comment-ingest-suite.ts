import type { TrackerCommentIngestKey, TrackerCommentIngestRepository } from '@cat-factory/kernel'
import { TRACKER_COMMENT_INGEST_CLAIM_TTL_MS } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the INBOUND tracker-comment ingest markers — the rows that keep a
// redelivered reporter comment from answering the same review finding twice
// (backend/docs/adr/0032-tracker-webhook-intake.md, D4).
//
// The contract this pins is `claim`, and it is the whole reason the suite exists: it must be ONE
// atomic statement whose insert-or-conditional-update reports whether the caller now owns the
// apply. Both facades express that differently — D1's `ON CONFLICT … DO UPDATE … WHERE …
// RETURNING` versus Drizzle's `onConflictDoUpdate({ setWhere })` — so a runtime that quietly
// degraded it to a read-then-write, or got the `failed`-only retry predicate wrong, would
// double-apply on one store and not the other. The failure is invisible in code review and shows
// up only as a run whose requirements absorbed a reporter's answer twice.
//
// Deliberately the same shape as `review-question-post-suite.ts`: the two markers guard the two
// DIRECTIONS of one loop (questions out, answers in), and keeping the suites aligned is what makes
// a divergence between them obvious.

/**
 * Assert a runtime's {@link TrackerCommentIngestRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace ids are unique per run so a
 * shared database stays isolated between cases.
 */
export function defineTrackerCommentIngestSuite(
  name: string,
  makeRepo: () => TrackerCommentIngestRepository,
): void {
  describe(`[${name}] tracker comment ingest marker parity`, () => {
    let seq = 0
    const nextKey = (over: Partial<TrackerCommentIngestKey> = {}): TrackerCommentIngestKey => {
      seq += 1
      return {
        workspaceId: `ws-${name}-${seq}-${Math.floor(Math.random() * 1e9)}`,
        source: 'github',
        externalId: 'acme/api#42',
        commentId: 'c-1',
        ...over,
      }
    }

    /** A claim taken at `now`, with the standard abandonment window the service applies. */
    const at = (now: number) => ({
      now,
      reclaimPendingBefore: now - TRACKER_COMMENT_INGEST_CLAIM_TTL_MS,
    })

    it('claims an unseen comment exactly once', async () => {
      const repo = makeRepo()
      const key = nextKey()
      expect(await repo.claim(key, at(100))).toBe(true)
      // The second caller is the tracker's redelivery: it must NOT apply the commands again.
      expect(await repo.claim(key, at(200))).toBe(false)

      const stored = await repo.get(key)
      expect(stored?.status).toBe('pending')
      expect(stored?.attempts).toBe(1)
      expect(stored?.updatedAt).toBe(100)
    })

    it('refuses to re-claim an APPLIED comment (its answers already landed)', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'applied' }, 2)

      expect(await repo.claim(key, at(3))).toBe(false)
      const stored = await repo.get(key)
      expect(stored?.status).toBe('applied')
      expect(stored?.error).toBeNull()
      expect(stored?.updatedAt).toBe(2)
    })

    it('re-claims a FAILED marker, so a transient failure is retried and the attempt counted', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'failed', error: 'review service down' }, 2)
      expect((await repo.get(key))?.error).toBe('review service down')

      expect(await repo.claim(key, at(3))).toBe(true)
      const retried = await repo.get(key)
      expect(retried?.status).toBe('pending')
      expect(retried?.attempts).toBe(2)
      // The previous failure's message is cleared with the retry, so a later `failed` row always
      // carries the error that actually caused it.
      expect(retried?.error).toBeNull()

      await repo.settle(key, { status: 'applied' }, 4)
      expect((await repo.get(key))?.status).toBe('applied')
    })

    it('holds a FRESH pending claim — an apply in flight must never run twice', async () => {
      const repo = makeRepo()
      const key = nextKey()
      const start = 10 * TRACKER_COMMENT_INGEST_CLAIM_TTL_MS
      expect(await repo.claim(key, at(start))).toBe(true)

      // One millisecond short of the abandonment window: the first ingester may still be mid-apply
      // (a reply can drive an incorporation LLM call), so stealing here is exactly the
      // double-answer the marker exists to prevent.
      expect(await repo.claim(key, at(start + TRACKER_COMMENT_INGEST_CLAIM_TTL_MS - 1))).toBe(false)
      expect((await repo.get(key))?.attempts).toBe(1)
    })

    it('re-claims an ABANDONED pending claim, so an ingester killed mid-apply self-heals', async () => {
      // The failure this covers: a claim is taken, then the process dies before it can settle (an
      // evicted isolate, an expired queue job). Without a takeover window that row is terminal in
      // practice — the reporter's answer is never applied AND nothing ever retries, which is a
      // silent never-apply traded for a double-apply. Both dialects must agree on when the row
      // becomes stealable, or one store self-heals and the other quietly drops the answer.
      const repo = makeRepo()
      const key = nextKey()
      const start = 10 * TRACKER_COMMENT_INGEST_CLAIM_TTL_MS
      await repo.claim(key, at(start))

      const afterWindow = start + TRACKER_COMMENT_INGEST_CLAIM_TTL_MS
      expect(await repo.claim(key, at(afterWindow))).toBe(true)
      const retaken = await repo.get(key)
      expect(retaken?.status).toBe('pending')
      expect(retaken?.attempts).toBe(2)
      expect(retaken?.updatedAt).toBe(afterWindow)

      // The takeover is itself a claim, so it is equally protected against a concurrent redelivery.
      expect(await repo.claim(key, at(afterWindow))).toBe(false)
    })

    it('never re-claims an APPLIED marker, however old — age steals nothing that succeeded', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'applied' }, 2)

      expect(await repo.claim(key, at(1_000 * TRACKER_COMMENT_INGEST_CLAIM_TTL_MS))).toBe(false)
      expect((await repo.get(key))?.status).toBe('applied')
    })

    it('keys on all four parts — a second comment, issue or tracker ingests independently', async () => {
      const repo = makeRepo()
      const key = nextKey()
      await repo.claim(key, at(1))
      await repo.settle(key, { status: 'applied' }, 1)

      // A follow-up comment on the same issue is a new answer and must be applied.
      expect(await repo.claim({ ...key, commentId: 'c-2' }, at(2))).toBe(true)

      // A different issue in the same workspace is independent…
      expect(await repo.claim({ ...key, externalId: 'acme/api#43' }, at(2))).toBe(true)

      // …and so is a different tracker, which is why `source` is part of the key at all: two
      // trackers can legitimately hand out the same comment id.
      expect(await repo.claim({ ...key, source: 'jira' }, at(2))).toBe(true)
    })

    it('returns null for a comment that was never claimed', async () => {
      const repo = makeRepo()
      expect(await repo.get(nextKey())).toBeNull()
    })

    it('settling an unclaimed key is a harmless no-op', async () => {
      // `settle` follows a successful `claim` on every real path; a lost row must not throw and
      // must not conjure a marker that would then suppress a legitimate apply.
      const repo = makeRepo()
      const key = nextKey()
      await repo.settle(key, { status: 'applied' }, 1)
      expect(await repo.get(key)).toBeNull()
    })
  })
}
