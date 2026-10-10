import type { GitHubRepo } from '@cat-factory/contracts'

// Which repo projection writes are directory changes (docs/initiatives/directory-sync.md). Repo
// sync re-upserts every row on every pass and re-stamps `synced_at`, so recording each upsert would
// flood the feed with changes nobody can observe. Both facades decide through this one rule.

/** The stored state of a projection row, as far as the directory publishes it. */
export interface StoredDirectoryRepo {
  githubId: number
  owner: string
  name: string
  defaultBranch: string | null
  private: boolean
  provider: 'github' | 'gitlab'
  tombstoned: boolean
}

/**
 * The provider ids among `incoming` whose upsert changes what the directory publishes: a new row,
 * a revived tombstone, or a different owner, name, default branch, visibility or provider.
 */
export function changedDirectoryRepoIds(
  stored: readonly StoredDirectoryRepo[],
  incoming: readonly GitHubRepo[],
): number[] {
  const byId = new Map(stored.map((row) => [row.githubId, row]))
  const changed = new Set<number>()
  for (const repo of incoming) {
    const row = byId.get(repo.githubId)
    if (
      !row ||
      row.tombstoned ||
      row.owner !== repo.owner ||
      row.name !== repo.name ||
      row.defaultBranch !== repo.defaultBranch ||
      row.private !== repo.private ||
      row.provider !== (repo.provider ?? 'github')
    ) {
      changed.add(repo.githubId)
    }
  }
  return [...changed]
}
