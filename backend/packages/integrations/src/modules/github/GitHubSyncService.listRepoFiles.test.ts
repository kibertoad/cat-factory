import type { GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// listRepoFiles backs the doc-context file picker's search box: the whole repo tree read in
// one recursive call (githubClient.listTree), reduced to FILE leaves only and sorted by path.
// The repo is already tracked here (repoProjectionRepository.get hits), so linkRepo returns
// immediately without the link/sync path.

const repo: GitHubRepo = {
  githubId: 7,
  owner: 'acme',
  name: 'app',
  defaultBranch: 'main',
  private: false,
  installationId: 1,
  syncedAt: 0,
} as GitHubRepo

function makeService(tree: Array<{ path: string; name: string; type: 'file' | 'dir' }>): {
  service: GitHubSyncService
  treeCalls: Array<{ gitRef?: string }>
} {
  const treeCalls: Array<{ gitRef?: string }> = []
  const deps = {
    githubInstallationRepository: {
      getByWorkspace: async () => ({ installationId: 1, deletedAt: null }),
    },
    repoProjectionRepository: {
      get: async () => repo,
    },
    githubClient: {
      listTree: async (_id: number, _ref: unknown, gitRef?: string) => {
        treeCalls.push({ gitRef })
        return tree.map((e) => ({ ...e, sha: 'x' }))
      },
    },
  } as unknown as GitHubSyncServiceDependencies
  return { service: new GitHubSyncService(deps), treeCalls }
}

describe('GitHubSyncService.listRepoFiles', () => {
  it('returns file leaves only, sorted by path, read on the default branch', async () => {
    const { service, treeCalls } = makeService([
      { path: 'src', name: 'src', type: 'dir' },
      { path: 'src/index.ts', name: 'index.ts', type: 'file' },
      { path: 'README.md', name: 'README.md', type: 'file' },
      { path: 'docs', name: 'docs', type: 'dir' },
      { path: 'docs/architecture.md', name: 'architecture.md', type: 'file' },
    ])
    const files = await service.listRepoFiles('ws', 7)
    expect(files.map((f) => f.path)).toEqual(['docs/architecture.md', 'README.md', 'src/index.ts'])
    expect(files.every((f) => f.type === 'file')).toBe(true)
    // Read pinned to the repo's default branch.
    expect(treeCalls).toEqual([{ gitRef: 'main' }])
  })

  it('returns [] when the workspace has no installation', async () => {
    const deps = {
      githubInstallationRepository: { getByWorkspace: async () => null },
    } as unknown as GitHubSyncServiceDependencies
    expect(await new GitHubSyncService(deps).listRepoFiles('ws', 7)).toEqual([])
  })
})
