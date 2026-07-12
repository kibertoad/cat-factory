import type { CommitProjectionRepository, GitHubCommit } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the github_commits projection (the commit history the backfill
// steps write and the board reads). Each facade persists it in its own store (D1 on
// Cloudflare, Postgres via Drizzle on Node). This suite drives the SAME upsert → list →
// retention prune assertions through whichever real repository a runtime hands it, so a
// column mapped differently or a prune predicate built differently fails a test instead of
// shipping. Unlike the other projections this table has no `deleted_at` tombstone and grows
// step-wise during backfills, so the retention prune is the only thing that reclaims it: it
// must delete commits authored strictly before the cutoff and KEEP rows with no
// `authored_at` (they can't be placed in the retention window).

function commit(overrides: Partial<GitHubCommit> & Pick<GitHubCommit, 'sha'>): GitHubCommit {
  return {
    repoGithubId: 1,
    message: `msg-${overrides.sha}`,
    author: 'octocat',
    authoredAt: 1_000,
    syncedAt: 1,
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link CommitProjectionRepository} behaves identically to the others.
 * `makeRepo` returns a repo over the runtime's real store; workspace/repo ids are unique per
 * case so the shared database stays isolated between cases.
 */
export function defineCommitProjectionSuite(
  name: string,
  makeRepo: () => CommitProjectionRepository,
): void {
  describe(`[${name}] commit-projection repository parity`, () => {
    let seq = 0
    const scope = () => {
      seq += 1
      return { ws: `${name}-ws-${seq}-${Math.floor(Math.random() * 1e9)}`, repo: 100_000 + seq }
    }

    it('upserts commits and lists them scoped to a repo', async () => {
      const repo = makeRepo()
      const { ws, repo: repoId } = scope()
      const other = scope()
      await repo.upsertMany(ws, [
        commit({ sha: 'a', repoGithubId: repoId, authoredAt: 1_000 }),
        commit({ sha: 'b', repoGithubId: repoId, authoredAt: 2_000 }),
      ])
      // A different repo's commit must not bleed into the read.
      await repo.upsertMany(ws, [commit({ sha: 'z', repoGithubId: other.repo, authoredAt: 3_000 })])

      const rows = await repo.listByRepo(ws, repoId)
      // Ordered newest-authored first (both runtimes align NULLS LAST on DESC).
      expect(rows.map((c) => c.sha)).toEqual(['b', 'a'])
    })

    it('re-upsert of the same (repo, sha) updates in place rather than duplicating', async () => {
      const repo = makeRepo()
      const { ws, repo: repoId } = scope()
      await repo.upsertMany(ws, [commit({ sha: 'a', repoGithubId: repoId, message: 'first' })])
      await repo.upsertMany(ws, [commit({ sha: 'a', repoGithubId: repoId, message: 'second' })])
      const rows = await repo.listByRepo(ws, repoId)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.message).toBe('second')
    })

    it('prunes commits authored before the cutoff, keeping newer and null-authored rows', async () => {
      const repo = makeRepo()
      const { ws, repo: repoId } = scope()
      await repo.upsertMany(ws, [
        commit({ sha: 'old', repoGithubId: repoId, authoredAt: 1_000 }),
        commit({ sha: 'new', repoGithubId: repoId, authoredAt: 5_000 }),
        // Exactly ON the cutoff: the prune is exclusive (`authored_at < cutoff`), so this
        // must SURVIVE — a facade drifted to `<=` would delete it and fail here.
        commit({ sha: 'edge', repoGithubId: repoId, authoredAt: 2_000 }),
        // No authored_at: outside any retention window, must survive the prune.
        commit({ sha: 'undated', repoGithubId: repoId, authoredAt: null }),
      ])
      // Table-wide prune, so its count can include other cases' rows in the shared DB —
      // assert the scoped, deterministic survivors instead.
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      const survivors = new Set((await repo.listByRepo(ws, repoId)).map((c) => c.sha))
      expect(survivors).toEqual(new Set(['new', 'edge', 'undated']))
    })
  })
}
