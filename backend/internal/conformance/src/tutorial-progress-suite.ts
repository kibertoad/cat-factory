import type { TutorialProgress, TutorialProgressRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-USER in-app tutorial progress store. The service above it
// (`TutorialProgressService`, whose MERGE rules are unit-tested there) is runtime-neutral, but each
// facade persists the row in its own store: D1 on Cloudflare, Postgres via Drizzle on Node.
//
// What this suite is really about is the two id LISTS. They are stored as JSON text on both stores
// rather than as a join table (grow-only sets of at most a few dozen opaque ids, always read and
// written whole), and JSON-in-a-text-column is exactly the shape where two stores drift quietly: an
// order that survives one round trip and not the other, an empty list that comes back null on one
// side, a malformed value that throws on one and degrades on the other. None of those would fail
// anything else — the symptom is a finished walkthrough reappearing as un-taken, on one runtime.

const progress = (overrides: Partial<TutorialProgress> = {}): TutorialProgress => ({
  decision: null,
  completedTourIds: [],
  nudgedTourIds: [],
  ...overrides,
})

/**
 * Assert a runtime's {@link TutorialProgressRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; user ids are unique per case so the
 * shared database stays isolated.
 */
export function defineTutorialProgressSuite(
  name: string,
  makeRepo: () => TutorialProgressRepository,
): void {
  describe(`[${name}] per-user tutorial progress`, () => {
    it('reports no row for a user who has never saved one', async () => {
      // Distinct from a row of defaults, and the distinction is load-bearing: the service turns
      // "no row" into the defaults, and "Reset progress" restores exactly this state.
      await expect(makeRepo().get('usr_tutorial_absent')).resolves.toBeNull()
    })

    it('round-trips both id lists in order, and an empty one as empty', async () => {
      const repo = makeRepo()
      const userId = 'usr_tutorial_lists'
      await repo.upsert(
        userId,
        progress({
          decision: 'accepted',
          completedTourIds: ['board-basics', 'add-service', 'first-task'],
        }),
      )
      const read = await repo.get(userId)
      expect(read?.decision).toBe('accepted')
      // ORDER, not set equality: the client appends, and a store that reordered would make the
      // handoff's "next unfinished tour" pick differently on one runtime than the other.
      expect(read?.completedTourIds).toEqual(['board-basics', 'add-service', 'first-task'])
      // An empty list must come back as an empty ARRAY, never null: every reader indexes into it.
      expect(read?.nudgedTourIds).toEqual([])
    })

    it('replaces the whole row on upsert, including shrinking a list', async () => {
      // The repository is a dumb store: MERGING is the service's job, and a repo that merged on
      // its own would make the reset unimplementable.
      const repo = makeRepo()
      const userId = 'usr_tutorial_replace'
      await repo.upsert(userId, progress({ completedTourIds: ['a', 'b'], nudgedTourIds: ['x'] }))
      await repo.upsert(userId, progress({ decision: 'declined', completedTourIds: ['c'] }))
      const read = await repo.get(userId)
      expect(read).toEqual(progress({ decision: 'declined', completedTourIds: ['c'] }))
    })

    it('narrows the stored decision, reading an unrecognised value as never-answered', async () => {
      // The vocabulary is CLOSED and PERSISTED, so a retired member outlives the type. Both stores
      // must fall back to "never answered" rather than handing the SPA a value it has no branch for
      // — the launch prompt would otherwise neither appear nor be answerable.
      const repo = makeRepo()
      const userId = 'usr_tutorial_decision'
      await repo.upsert(userId, progress({ decision: 'sometime-later' as never }))
      expect((await repo.get(userId))?.decision).toBeNull()
    })

    it('removes the row entirely, so a reset is indistinguishable from a fresh user', async () => {
      const repo = makeRepo()
      const userId = 'usr_tutorial_reset'
      await repo.upsert(userId, progress({ decision: 'accepted', completedTourIds: ['a'] }))
      await repo.remove(userId)
      await expect(repo.get(userId)).resolves.toBeNull()
      // Idempotent: the SPA fires the DELETE fire-and-forget, so a retry must not throw.
      await expect(repo.remove(userId)).resolves.toBeUndefined()
    })
  })
}
