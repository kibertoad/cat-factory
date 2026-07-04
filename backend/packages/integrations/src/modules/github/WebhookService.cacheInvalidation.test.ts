import type { GitHubRepo, GroupCacheHandle } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { WebhookService, type WebhookServiceDependencies } from './WebhookService.js'

// Caching-initiative slice 3: an `installation_repositories` `removed` delivery tombstones
// the repo in every workspace that linked it — a repo-projection write — so each affected
// workspace's `AppCaches.repoProjection` group must be dropped. (The push/check_run events
// project OTHER tables the resolver never lists, so they don't invalidate it.)

function fakeCache(): { handle: GroupCacheHandle<GitHubRepo[]>; invalidated: string[] } {
  const invalidated: string[] = []
  return {
    handle: {
      get: async (_k, _g, load) => load(),
      invalidate: async () => {},
      invalidateGroup: async (group) => {
        invalidated.push(group)
      },
      invalidateAll: async () => {},
    },
    invalidated,
  }
}

const tracked = (githubId: number): GitHubRepo =>
  ({
    githubId,
    owner: 'acme',
    name: `repo-${githubId}`,
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    syncedAt: 0,
  }) as GitHubRepo

describe('WebhookService — repoProjection cache invalidation (slice 3)', () => {
  it('invalidates every workspace an installation-removed repo was tombstoned in', async () => {
    const { handle, invalidated } = fakeCache()
    const tombstoned: string[] = []
    const deps = {
      githubInstallationRepository: {
        getByInstallationId: async () => ({ installationId: 1, deletedAt: null }),
        listWorkspacesForInstallation: async () => ['ws-a', 'ws-b', 'ws-c'],
      },
      repoProjectionRepository: {
        // Only ws-a and ws-b link the removed repo (7).
        linkedWorkspaces: async (_id: number, candidates: string[]) =>
          candidates.filter((w) => w !== 'ws-c'),
        list: async (ws: string) => (ws === 'ws-a' ? [tracked(7), tracked(9)] : [tracked(7)]),
        tombstoneMissing: async (ws: string) => {
          tombstoned.push(ws)
        },
      },
      clock: { now: () => 0 },
      repoProjectionCache: handle,
    } as unknown as WebhookServiceDependencies

    await new WebhookService(deps).handle('installation_repositories', {
      action: 'removed',
      installation: { id: 1 },
      repositories_removed: [{ id: 7 }],
    })

    expect(tombstoned).toEqual(['ws-a', 'ws-b'])
    expect(invalidated).toEqual(['ws-a', 'ws-b'])
  })

  it('does not invalidate on a push event (a different projection table)', async () => {
    const { handle, invalidated } = fakeCache()
    const deps = {
      githubInstallationRepository: {
        getByInstallationId: async () => ({ installationId: 1, deletedAt: null }),
        listWorkspacesForInstallation: async () => ['ws-a'],
      },
      repoProjectionRepository: { linkedWorkspaces: async (_id: number, c: string[]) => c },
      branchProjectionRepository: { upsertMany: async () => {} },
      commitProjectionRepository: { upsertMany: async () => {} },
      clock: { now: () => 0 },
      repoProjectionCache: handle,
    } as unknown as WebhookServiceDependencies

    await new WebhookService(deps).handle('push', {
      installation: { id: 1 },
      repository: { id: 7 },
      ref: 'refs/heads/main',
      after: 'abc123',
      commits: [],
    })

    expect(invalidated).toEqual([])
  })
})
