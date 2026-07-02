import type { GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// Focused coverage for the server-side `owner/name` filter that backs the add-service repo
// picker's typeahead. Only the three ports `listAvailableRepos` touches are stubbed.

const repo = (githubId: number, owner: string, name: string): GitHubRepo =>
  ({
    githubId,
    owner,
    name,
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    syncedAt: 0,
  }) as GitHubRepo

const REPOS = [
  repo(1, 'acme', 'api-gateway'),
  repo(2, 'acme', 'web-app'),
  repo(3, 'globex', 'API-client'),
  repo(4, 'globex', 'billing'),
]

function makeService(items: GitHubRepo[]): GitHubSyncService {
  const deps = {
    githubInstallationRepository: {
      getByWorkspace: async () => ({ installationId: 1, deletedAt: null }),
    },
    githubClient: {
      listInstallationRepos: async () => ({ items }),
    },
    repoProjectionRepository: {
      list: async () => [],
    },
  } as unknown as GitHubSyncServiceDependencies
  return new GitHubSyncService(deps)
}

describe('GitHubSyncService.listAvailableRepos', () => {
  const service = makeService(REPOS)

  it('returns every accessible repo when no query is given (browse-all)', async () => {
    const result = await service.listAvailableRepos('ws')
    expect(result.map((r) => r.githubId)).toEqual([1, 2, 3, 4])
  })

  it('filters by a case-insensitive owner/name substring', async () => {
    const result = await service.listAvailableRepos('ws', { q: 'api' })
    // Matches `acme/api-gateway` and `globex/API-client`, not `web-app`/`billing`.
    expect(result.map((r) => r.githubId).sort()).toEqual([1, 3])
  })

  it('matches on the owner segment too', async () => {
    const result = await service.listAvailableRepos('ws', { q: 'globex' })
    expect(result.map((r) => r.githubId).sort()).toEqual([3, 4])
  })

  it('treats a blank/whitespace query as no filter', async () => {
    const result = await service.listAvailableRepos('ws', { q: '   ' })
    expect(result).toHaveLength(4)
  })

  it('returns an empty list when the query matches nothing', async () => {
    const result = await service.listAvailableRepos('ws', { q: 'nonexistent' })
    expect(result).toEqual([])
  })
})
