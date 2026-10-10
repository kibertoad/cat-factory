import type { UserRepoAccessRecord, UserRepoAccessRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the per-user "repos my PAT can reach" projection. The board's
// fail-closed redaction (a `linkedVia:'user_pat'` frame is hidden from members not recorded
// here) and the repo-picker expansion are runtime-neutral, but each facade persists this in its
// own store — D1 on Cloudflare, Drizzle/Postgres on Node. This suite drives the SAME
// replace / record / batch-read / remove assertions through whichever real repository a runtime
// hands it, so a chunked `IN` read or an upsert mapped differently fails a test instead of
// shipping (and one facade forgetting the symmetric change is caught).
//
// `makeRepo` returns a repo over the runtime's real store; user ids are unique per run so the
// shared store stays isolated across the two facades' parallel invocations.
export function defineUserRepoAccessSuite(
  name: string,
  makeRepo: () => UserRepoAccessRepository,
): void {
  const uid = () => `usr_${Math.random().toString(36).slice(2)}`
  const rec = (userId: string, repoGithubId: number): UserRepoAccessRecord => ({
    userId,
    repoGithubId,
    owner: 'acme',
    name: `r${repoGithubId}`,
    defaultBranch: 'main',
    private: true,
    syncedAt: 1,
  })

  describe(`[${name}] user-repo-access repository parity`, () => {
    it('replaceForUser sets the set; listAccessibleRepoIds filters to it', async () => {
      const repo = makeRepo()
      const u = uid()
      await repo.replaceForUser(u, [rec(u, 1), rec(u, 2), rec(u, 3)])
      expect((await repo.listAccessibleRepoIds(u, [1, 2, 3, 4])).sort((a, b) => a - b)).toEqual([
        1, 2, 3,
      ])
      // A full re-enumeration drops repos the PAT can no longer reach.
      await repo.replaceForUser(u, [rec(u, 2)])
      expect(await repo.listAccessibleRepoIds(u, [1, 2, 3])).toEqual([2])
    })

    it('recordAccessible upserts additively (no delete of other rows)', async () => {
      const repo = makeRepo()
      const u = uid()
      await repo.replaceForUser(u, [rec(u, 10)])
      await repo.recordAccessible(u, [rec(u, 11)])
      expect((await repo.listAccessibleRepoIds(u, [10, 11])).sort((a, b) => a - b)).toEqual([
        10, 11,
      ])
    })

    it('scopes grants per user; removeForUser clears only that user', async () => {
      const repo = makeRepo()
      const a = uid()
      const b = uid()
      await repo.replaceForUser(a, [rec(a, 20)])
      await repo.replaceForUser(b, [rec(b, 20)])
      await repo.removeForUser(a)
      expect(await repo.listAccessibleRepoIds(a, [20])).toEqual([])
      expect(await repo.listAccessibleRepoIds(b, [20])).toEqual([20])
    })

    it('handles empty inputs', async () => {
      const repo = makeRepo()
      const u = uid()
      expect(await repo.listAccessibleRepoIds(u, [])).toEqual([])
      await repo.recordAccessible(u, [])
      await repo.replaceForUser(u, [])
      expect(await repo.listByUser(u)).toEqual([])
    })
  })
}
