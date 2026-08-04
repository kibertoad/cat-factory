import type { GitHubClient } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { RepoTarget, ResolveRepoTarget } from './ContainerAgentExecutor.js'
import { makeResolveRunRepoContext } from './repoFiles.js'

const TARGET: RepoTarget = {
  installationId: 42,
  repoId: 'repo-123',
  owner: 'acme',
  name: 'maestro',
  baseBranch: 'main',
}

describe('makeResolveRunRepoContext', () => {
  it('surfaces the repo owner/name so a code adapter can key per-service config off the repo', async () => {
    const resolve = makeResolveRunRepoContext(
      {} as GitHubClient,
      (async () => TARGET) as ResolveRepoTarget,
    )
    const ctx = await resolve('ws', 'blk')
    expect(ctx).not.toBeNull()
    expect(ctx?.owner).toBe('acme')
    expect(ctx?.name).toBe('maestro')
    // The pre-existing fields are unchanged.
    expect(ctx?.baseBranch).toBe('main')
    expect(ctx?.repoId).toBe('repo-123')
  })

  it('returns null when no repo target resolves (GitHub not connected)', async () => {
    const resolve = makeResolveRunRepoContext(
      {} as GitHubClient,
      (async () => null) as ResolveRepoTarget,
    )
    expect(await resolve('ws', 'blk')).toBeNull()
  })
})
