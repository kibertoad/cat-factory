import type { RequirementReview } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

/**
 * The requirements-review STORE's own optimistic concurrency, asserted at the repository layer
 * rather than through the engine: the hazards are lost updates and split rows, and only real D1
 * and real Postgres can show that the rev guard and the one-live-row unique index behave the same
 * on both. A sibling file of `execution-review.ts` (which drives the same feature through HTTP)
 * because it is a different LAYER, and because that file is at its size budget.
 */
export function defineReviewStoreConcurrencyConformance(harness: ConformanceHarness): void {
  // Race-audit 2.5: the review store's own optimistic concurrency. A review is ONE JSON blob
  // holding every finding, so the lost-update hazard is structural — two humans answering
  // different findings, or a dismissal landing inside the (slow) incorporation LLM call, each
  // wrote the whole row back from a stale read and the loser's edit vanished. Asserted at the
  // repository layer so D1 and Postgres are proven to behave identically.
  describe('requirements-review optimistic concurrency', () => {
    function review(over: Partial<RequirementReview> = {}): RequirementReview {
      return {
        id: 'rrv_cas',
        blockId: 'blk_review_cas',
        status: 'ready',
        items: [],
        model: 'fake:fake',
        incorporatedRequirements: null,
        iteration: 1,
        maxIterations: 3,
        recommendations: [],
        rev: 0,
        createdAt: 1,
        updatedAt: 1,
        ...over,
      }
    }

    it('refuses a stale compareAndSwap while a force upsert still bumps rev', async () => {
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()

      await repo.upsert(workspace.id, review())
      expect((await repo.get(workspace.id, 'rrv_cas'))?.rev).toBe(0)

      // Two people opened the review window on the same revision.
      const writerA = (await repo.get(workspace.id, 'rrv_cas'))!
      const writerB = (await repo.get(workspace.id, 'rrv_cas'))!

      // The first answer lands and bumps the in-memory + stored rev.
      writerA.incorporatedRequirements = 'A'
      expect(await repo.compareAndSwap(workspace.id, writerA)).toBe(true)
      expect(writerA.rev).toBe(1)

      // The second, from the now-stale revision, is refused with NO write — so the service
      // reloads and re-applies its edit on top of A's instead of erasing it.
      writerB.incorporatedRequirements = 'B'
      expect(await repo.compareAndSwap(workspace.id, writerB)).toBe(false)
      const afterCas = (await repo.get(workspace.id, 'rrv_cas'))!
      expect(afterCas.incorporatedRequirements).toBe('A')
      expect(afterCas.rev).toBe(1)

      // The force upsert (seeding / the initial insert) always lands AND keeps rev monotonic,
      // so a later compareAndSwap still detects that the row moved.
      afterCas.status = 'merged'
      await repo.upsert(workspace.id, afterCas)
      const afterForce = (await repo.get(workspace.id, 'rrv_cas'))!
      expect(afterForce.status).toBe('merged')
      expect(afterForce.rev).toBe(2)
    })

    it('compareAndSwap never resurrects a review a fresh run replaced', async () => {
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()

      await repo.upsert(workspace.id, review())
      // A window (or the durable driver) loaded the review…
      const held = (await repo.get(workspace.id, 'rrv_cas'))!
      // …then a fresh review run replaced the block's review under a NEW id.
      await repo.replaceForBlock(workspace.id, review({ id: 'rrv_cas_2' }))

      held.incorporatedRequirements = 'stale'
      expect(await repo.compareAndSwap(workspace.id, held)).toBe(false)
      // The superseded review stays gone — never re-inserted alongside the live one.
      expect(await repo.get(workspace.id, 'rrv_cas')).toBeNull()
      expect((await repo.getByBlock(workspace.id, 'blk_review_cas'))?.id).toBe('rrv_cas_2')
    })

    it('keeps the recorded issue writeback across whole-row writes, and clears it on replace', async () => {
      // The writeback outcome is its own column, written by its own statement: a review edit that
      // re-writes the whole row from a snapshot taken before the writeback must not drop it.
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()
      await repo.upsert(workspace.id, review())
      const stale = (await repo.get(workspace.id, 'rrv_cas'))!

      const record = {
        trigger: 'automatic' as const,
        at: 42,
        issues: [{ source: 'jira', externalId: 'ENG-7', outcome: 'updated' as const }],
      }
      await repo.recordIssueWriteback(workspace.id, 'rrv_cas', record)
      expect((await repo.get(workspace.id, 'rrv_cas'))?.issueWriteback).toEqual(record)

      stale.status = 'incorporated'
      expect(await repo.compareAndSwap(workspace.id, stale)).toBe(true)
      await repo.upsert(workspace.id, { ...stale, updatedAt: 2 })
      expect((await repo.getByBlock(workspace.id, 'blk_review_cas'))?.issueWriteback).toEqual(
        record,
      )

      await repo.replaceForBlock(workspace.id, review({ id: 'rrv_cas_next' }))
      expect((await repo.getByBlock(workspace.id, 'blk_review_cas'))?.issueWriteback).toBeNull()
      // Recording against a review that no longer exists writes nothing.
      await repo.recordIssueWriteback(workspace.id, 'rrv_cas', record)
      expect(await repo.get(workspace.id, 'rrv_cas')).toBeNull()
    })

    it('round-trips the finding floor through every whole-row write', async () => {
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()
      const first = {
        severity: 'high' as const,
        basis: 'estimate' as const,
        score: 0.2,
        suppressed: 3,
      }
      await repo.replaceForBlock(workspace.id, review({ findingFloor: first }))
      const stored = (await repo.getByBlock(workspace.id, 'blk_review_cas'))!
      expect(stored.findingFloor).toEqual(first)

      // A re-review pass records its own floor, and what the follow-up bar dropped, through the
      // rev-guarded write; its findings carry the answer each one follows up on.
      const next = {
        severity: 'medium' as const,
        basis: 'no_estimate' as const,
        score: null,
        suppressed: 0,
        followUpSuppressed: 2,
      }
      const followUp = {
        id: 'rri_follow_up',
        category: 'gap' as const,
        severity: 'medium' as const,
        title: 'Which formats does an export offer?',
        detail: 'The answer allows exports but names no format.',
        status: 'open' as const,
        reply: null,
        followsUpOn: 'Who can export?',
        createdAt: 1,
        updatedAt: 1,
      }
      expect(
        await repo.compareAndSwap(workspace.id, {
          ...stored,
          findingFloor: next,
          items: [followUp],
        }),
      ).toBe(true)
      const reReviewed = await repo.get(workspace.id, 'rrv_cas')
      expect(reReviewed?.findingFloor).toEqual(next)
      expect(reReviewed?.items[0]?.followsUpOn).toBe('Who can export?')

      await repo.upsert(workspace.id, { ...stored, findingFloor: null, updatedAt: 3 })
      expect((await repo.get(workspace.id, 'rrv_cas'))?.findingFloor).toBeNull()
    })

    it('replaceForBlock leaves exactly one live review per block', async () => {
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()

      // Two review runs for the same block (a double-submitted gate / a manual run racing the
      // engine's). Whichever lands last is the block's only review, so the window and the parked
      // run's decision can no longer key to different reviews.
      await repo.replaceForBlock(workspace.id, review({ id: 'rrv_run_1' }))
      await repo.replaceForBlock(workspace.id, review({ id: 'rrv_run_2' }))

      expect(await repo.get(workspace.id, 'rrv_run_1')).toBeNull()
      expect((await repo.getByBlock(workspace.id, 'blk_review_cas'))?.id).toBe('rrv_run_2')
      // A replace restarts the rev clock, so the superseded run's revision can't be mistaken for
      // the new review's.
      expect((await repo.get(workspace.id, 'rrv_run_2'))?.rev).toBe(0)
    })

    // The invariant above, asserted the way it actually BREAKS. Awaiting the two replaces in
    // sequence proves nothing about interleaving: the hazard is two runs in flight at once, and a
    // store that wrapped a DELETE-then-INSERT in a transaction would pass the sequential test
    // while still splitting the block in two under READ COMMITTED (a DELETE takes no predicate
    // lock, so both transactions delete nothing and both insert). Only the UNIQUE index on the
    // block key makes this hold, which is why it is asserted against real D1 and real Postgres
    // rather than reasoned about.
    it('replaceForBlock stays single-live under CONCURRENT review runs', async () => {
      const app = harness.makeApp()
      const repo = app.requirementReviewRepository()
      const { workspace } = await app.createWorkspace()

      const ids = ['rrv_par_1', 'rrv_par_2', 'rrv_par_3', 'rrv_par_4']
      const settled = await Promise.allSettled(
        ids.map((id) => repo.replaceForBlock(workspace.id, review({ id }))),
      )
      // A loser may legitimately be REFUSED by the constraint (that is the invariant holding, and
      // the caller is a fresh review run that has nothing to lose by failing) — but it must never
      // succeed into a second live row.
      expect(settled.some((r) => r.status === 'fulfilled')).toBe(true)

      const live = await repo.getByBlock(workspace.id, 'blk_review_cas')
      expect(live).not.toBeNull()
      // Exactly ONE of the four ids survives; every other one is gone rather than parked beside it.
      const survivors = (await Promise.all(ids.map((id) => repo.get(workspace.id, id)))).filter(
        (r) => r !== null,
      )
      expect(survivors).toHaveLength(1)
      expect(survivors[0]!.id).toBe(live!.id)
    })
  })
}
