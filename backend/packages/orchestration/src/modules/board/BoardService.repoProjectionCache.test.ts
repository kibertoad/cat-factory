import type { GitHubRepo, GroupCacheHandle } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { BoardService, type BoardServiceDependencies } from './BoardService.js'

// Caching-initiative slice 3: `addServiceFromRepo` flips a repo's monorepo flag directly on
// the projection (not via `GitHubSyncService`), and that flag decides whether
// `resolveRepoTarget` hands agents the service subdirectory — a resolver-visible field. So the
// write MUST drop the workspace's `AppCaches.repoProjection` group, or a warmed entry keeps
// serving the old flag until its TTL and the agent runs at the repo root instead of the pin.

const WS = 'ws_1'

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

const repo = (isMonorepo: boolean): GitHubRepo =>
  ({
    githubId: 1,
    owner: 'acme',
    name: 'platform',
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    isMonorepo,
    syncedAt: 0,
  }) as GitHubRepo

function build(handle: GroupCacheHandle<GitHubRepo[]>, stored: GitHubRepo) {
  const deps = {
    workspaceRepository: { get: async (id: string) => ({ id }) },
    blockRepository: {
      listByWorkspace: async () => [],
      insert: async () => {},
    },
    // No serviceRepository wired → the duplicate-service guards are skipped and
    // registerService is a no-op, keeping this focused on the cache invalidation.
    repoProjectionRepository: {
      get: async () => stored,
      setMonorepo: async () => {},
    },
    repoProjectionCache: handle,
    idGenerator: { next: (prefix: string) => `${prefix}_new` },
    clock: { now: () => 0 },
    executionEventPublisher: {
      async executionChanged() {},
      async boardChanged() {},
      async bootstrapChanged() {},
      async notificationChanged() {},
      async llmCallObserved() {},
    },
  } as unknown as BoardServiceDependencies
  return new BoardService(deps)
}

describe('BoardService.addServiceFromRepo — repoProjection cache invalidation (slice 3)', () => {
  it('drops the workspace group when it flips the monorepo flag', async () => {
    const { handle, invalidated } = fakeCache()
    const service = build(handle, repo(false))
    await service.addServiceFromRepo(WS, {
      repoGithubId: 1,
      isMonorepo: true,
      directory: 'services/foo',
    })
    expect(invalidated).toEqual([WS])
  })

  it('does not invalidate when the flag is unchanged (no projection write)', async () => {
    const { handle, invalidated } = fakeCache()
    const service = build(handle, repo(false))
    // isMonorepo omitted → no setMonorepo write, so nothing to invalidate.
    await service.addServiceFromRepo(WS, { repoGithubId: 1 })
    expect(invalidated).toEqual([])
  })
})
