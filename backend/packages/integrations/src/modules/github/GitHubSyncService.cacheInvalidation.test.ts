import type { GitHubRepo, GroupCacheHandle } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// Caching-initiative slice 3: every GitHubSyncService write that mutates a workspace's
// projected repos must drop that workspace's `AppCaches.repoProjection` group so the
// block→repo resolver re-lists fresh. These tests capture the `invalidateGroup` calls
// through a fake handle and assert each write path fires one. A facade that forgot to
// wire the cache would see no calls, but the wiring lives in the shared composition root
// (createGitHubModule), so this guards the service contract itself.

const repo = (githubId: number, name: string): GitHubRepo =>
  ({
    githubId,
    owner: 'acme',
    name,
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    syncedAt: 0,
  }) as GitHubRepo

function fakeCache(): { handle: GroupCacheHandle<GitHubRepo[]>; invalidated: string[] } {
  const invalidated: string[] = []
  const handle: GroupCacheHandle<GitHubRepo[]> = {
    get: async (_k, _g, load) => load(),
    invalidate: async () => {},
    invalidateGroup: async (group) => {
      invalidated.push(group)
    },
    invalidateAll: async () => {},
  }
  return { handle, invalidated }
}

const installation = {
  installationId: 1,
  deletedAt: null,
  accountLogin: 'acme',
  targetType: 'Organization' as const,
}

describe('GitHubSyncService — repoProjection cache invalidation (slice 3)', () => {
  it('setRepoMonorepo invalidates the workspace after flipping the flag', async () => {
    const { handle, invalidated } = fakeCache()
    const deps = {
      githubInstallationRepository: { getByWorkspace: async () => installation },
      repoProjectionRepository: {
        // linkRepo short-circuits on the already-tracked repo, so no sync fires.
        get: async () => repo(1, 'platform'),
        setMonorepo: async () => {},
      },
      clock: { now: () => 0 },
      repoProjectionCache: handle,
    } as unknown as GitHubSyncServiceDependencies

    await new GitHubSyncService(deps).setRepoMonorepo('ws', 1, true)
    expect(invalidated).toEqual(['ws'])
  })

  it('setLinkedRepos invalidates even on a full deselect (tombstone, no sync)', async () => {
    const { handle, invalidated } = fakeCache()
    const deps = {
      githubInstallationRepository: { getByWorkspace: async () => installation },
      githubClient: {
        listInstallationRepos: async () => ({ items: [repo(1, 'a'), repo(2, 'b')] }),
      },
      repoProjectionRepository: {
        upsertMany: async () => {},
        tombstoneMissing: async () => {},
        list: async () => [],
      },
      clock: { now: () => 0 },
      repoProjectionCache: handle,
    } as unknown as GitHubSyncServiceDependencies

    // Deselect everything: selected is empty, so no upsert/sync runs — only the tombstone.
    await new GitHubSyncService(deps).setLinkedRepos('ws', [])
    expect(invalidated).toEqual(['ws'])
  })

  const syncRepoDeps = (handle: GroupCacheHandle<GitHubRepo[]>) => {
    const empty = { items: [] as never[] }
    return {
      githubInstallationRepository: {
        listWorkspacesForInstallation: async () => ['ws-a', 'ws-b'],
      },
      githubClient: {
        listBranches: async () => empty,
        listPullRequests: async () => empty,
        listIssues: async () => empty,
        listCommits: async () => empty,
        listCheckRuns: async () => empty,
      },
      repoProjectionRepository: {
        linkedWorkspaces: async (_id: number, candidates: string[]) => candidates,
        getCursor: async () => null,
        setCursor: async () => {},
        upsertMany: async () => {},
      },
      branchProjectionRepository: { upsertMany: async () => {} },
      pullRequestProjectionRepository: { upsertMany: async () => {} },
      issueProjectionRepository: { upsertMany: async () => {} },
      commitProjectionRepository: { upsertMany: async () => {} },
      checkRunProjectionRepository: { upsertMany: async () => {} },
      clock: { now: () => 0 },
      repoProjectionCache: handle,
    } as unknown as GitHubSyncServiceDependencies
  }

  it('syncRepo invalidates every fanned-out workspace on a full (link-time) pass', async () => {
    const { handle, invalidated } = fakeCache()
    // A full pass carries freshly-fetched metadata that a sharing workspace may have stale.
    await new GitHubSyncService(syncRepoDeps(handle)).syncRepo(repo(1, 'platform'), { full: true })
    expect(invalidated).toEqual(['ws-a', 'ws-b'])
  })

  it('syncRepo does NOT invalidate on an incremental resync (only syncedAt re-stamped)', async () => {
    const { handle, invalidated } = fakeCache()
    // full=false: the repo came from the stored projection, so no resolver-visible field
    // changes — invalidating would only churn the cache the poll ticks reuse.
    await new GitHubSyncService(syncRepoDeps(handle)).syncRepo(repo(1, 'platform'))
    expect(invalidated).toEqual([])
  })

  it('is a no-op when no cache is wired (tests / Worker pass-through)', async () => {
    const deps = {
      githubInstallationRepository: { getByWorkspace: async () => installation },
      repoProjectionRepository: {
        get: async () => repo(1, 'platform'),
        setMonorepo: async () => {},
      },
      clock: { now: () => 0 },
    } as unknown as GitHubSyncServiceDependencies
    // No repoProjectionCache — the invalidation helper falls through cleanly.
    await expect(new GitHubSyncService(deps).setRepoMonorepo('ws', 1, true)).resolves.toBeDefined()
  })
})
