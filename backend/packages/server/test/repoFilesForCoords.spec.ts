import { describe, expect, it, vi } from 'vitest'
import type {
  GitHubClient,
  GitHubInstallationRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { makeResolveRepoFilesForCoords } from '../src/agents/repoFiles.js'

// makeResolveRepoFilesForCoords is the block-less repo resolver the environments module
// uses to validate / bootstrap a provider's config file in a repo the operator names. It
// matches the workspace's projected repos by owner+name and binds a checkout-free
// RepoFiles over the wired GitHubClient — degrading to null (→ "no VCS connection") when
// GitHub isn't connected or the repo isn't projected.

const REF = { owner: 'acme', repo: 'widgets' }

function fakeClient(): GitHubClient {
  return {
    getFileContent: vi.fn(async () => ({ content: 'x', sha: 's' })),
  } as unknown as GitHubClient
}

const installationRepo = (installationId: number | null) =>
  ({
    getByWorkspace: vi.fn(async () => (installationId == null ? null : { installationId })),
  }) as unknown as Pick<GitHubInstallationRepository, 'getByWorkspace'>

const projectionRepo = (repos: { owner: string; name: string; defaultBranch?: string }[]) =>
  ({
    list: vi.fn(async () => repos),
  }) as unknown as Pick<RepoProjectionRepository, 'list'>

describe('makeResolveRepoFilesForCoords', () => {
  it('returns null when GitHub has no installation for the workspace', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      installationRepo(null),
      projectionRepo([{ owner: 'acme', name: 'widgets' }]),
    )
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets' })).toBeNull()
  })

  it('returns null when the named repo is not projected', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'other' }]),
    )
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets' })).toBeNull()
  })

  it('binds a RepoFiles to the matched repo and its default branch', async () => {
    const client = fakeClient()
    const resolve = makeResolveRepoFilesForCoords(
      client,
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'widgets', defaultBranch: 'trunk' }]),
    )
    const ctx = await resolve('ws1', { owner: 'acme', repo: 'widgets' })
    expect(ctx?.baseBranch).toBe('trunk')
    await ctx?.repo.getFile('.kargo.yml')
    expect(client.getFileContent).toHaveBeenCalledWith(42, REF, '.kargo.yml', undefined)
  })

  it('defaults the base branch to main when the projection carries none', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'widgets' }]),
    )
    const ctx = await resolve('ws1', { owner: 'acme', repo: 'widgets' })
    expect(ctx?.baseBranch).toBe('main')
  })
})
