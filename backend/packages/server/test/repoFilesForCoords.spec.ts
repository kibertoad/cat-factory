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
// the workspace has no connection, the repo isn't projected, the repo resolves to a provider
// the BOUND client does not speak, or the caller named a provider the projection disagrees with.

const REF = { owner: 'acme', repo: 'widgets' }

function fakeClient(): GitHubClient {
  return {
    getFileContent: vi.fn(async () => ({ content: 'x', sha: 's' })),
  } as unknown as GitHubClient
}

const installationRepo = (
  installationId: number | null,
  provider: 'github' | 'gitlab' = 'github',
) =>
  ({
    getByWorkspace: vi.fn(async () =>
      installationId == null ? null : { installationId, provider },
    ),
  }) as unknown as Pick<GitHubInstallationRepository, 'getByWorkspace'>

const projectionRepo = (
  repos: { owner: string; name: string; defaultBranch?: string; provider?: 'github' | 'gitlab' }[],
) =>
  ({
    list: vi.fn(async () => repos),
  }) as unknown as Pick<RepoProjectionRepository, 'list'>

describe('makeResolveRepoFilesForCoords', () => {
  it('returns null when the workspace has no VCS connection', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      'github',
      installationRepo(null),
      projectionRepo([{ owner: 'acme', name: 'widgets' }]),
    )
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets' })).toBeNull()
  })

  it('returns null when the named repo is not projected', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      'github',
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'other' }]),
    )
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets' })).toBeNull()
  })

  it('binds a RepoFiles to the matched repo and its default branch', async () => {
    const client = fakeClient()
    const resolve = makeResolveRepoFilesForCoords(
      client,
      'github',
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'widgets', defaultBranch: 'trunk' }]),
    )
    const ctx = await resolve('ws1', { owner: 'acme', repo: 'widgets' })
    expect(ctx?.baseBranch).toBe('trunk')
    await ctx?.repo.getFile('.acme-envs.yml')
    expect(client.getFileContent).toHaveBeenCalledWith(42, REF, '.acme-envs.yml', undefined)
  })

  it('defaults the base branch to main when the projection carries none', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      'github',
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'widgets' }]),
    )
    const ctx = await resolve('ws1', { owner: 'acme', repo: 'widgets' })
    expect(ctx?.baseBranch).toBe('main')
  })

  // The GitLab half of the seam. A GitLab-only deployment wires this over the GitLab-backed
  // engine client, so a compose layer that names its provider must RESOLVE rather than be read
  // as an absent connection, which is what the blanket `provider !== 'github'` refusal did.
  it('resolves a repo the caller names as gitlab when the projection agrees', async () => {
    const client = fakeClient()
    const resolve = makeResolveRepoFilesForCoords(
      client,
      'gitlab',
      installationRepo(7, 'gitlab'),
      projectionRepo([{ owner: 'group/sub', name: 'widgets', provider: 'gitlab' }]),
    )
    const ctx = await resolve('ws1', { owner: 'group/sub', repo: 'widgets', provider: 'gitlab' })
    expect(ctx?.provider).toBe('gitlab')
    await ctx?.repo.getFile('compose.yml')
    expect(client.getFileContent).toHaveBeenCalledWith(
      7,
      { owner: 'group/sub', repo: 'widgets' },
      'compose.yml',
      undefined,
    )
  })

  // A row written before the provider column reads as its CONNECTION's provider, not as the
  // historical `github` default: the connection is what projected it.
  it('falls back to the connection provider for a row that carries none', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      'gitlab',
      installationRepo(7, 'gitlab'),
      projectionRepo([{ owner: 'acme', name: 'widgets' }]),
    )
    expect((await resolve('ws1', { owner: 'acme', repo: 'widgets' }))?.provider).toBe('gitlab')
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets', provider: 'github' })).toBeNull()
  })

  it('refuses coordinates whose named provider the projection disagrees with', async () => {
    const resolve = makeResolveRepoFilesForCoords(
      fakeClient(),
      'github',
      installationRepo(42),
      projectionRepo([{ owner: 'acme', name: 'widgets', provider: 'github' }]),
    )
    expect(await resolve('ws1', { owner: 'acme', repo: 'widgets', provider: 'gitlab' })).toBeNull()
  })

  // The mixed deployment: a GitHub App is what the facade binds here, and a GitLab-connected
  // workspace's repo is not reachable through it whether or not the caller names the provider.
  // Reading it would mint an App token for a GitLab host, or hit a same-named GitHub project.
  it('refuses a repo the bound client cannot read, however the caller names it', async () => {
    const client = fakeClient()
    const resolve = makeResolveRepoFilesForCoords(
      client,
      'github',
      installationRepo(7, 'gitlab'),
      projectionRepo([{ owner: 'group/sub', name: 'widgets', provider: 'gitlab' }]),
    )
    const coords = { owner: 'group/sub', repo: 'widgets' }
    expect(await resolve('ws1', coords)).toBeNull()
    expect(await resolve('ws1', { ...coords, provider: 'gitlab' })).toBeNull()
    expect(await resolve('ws1', { ...coords, provider: 'github' })).toBeNull()
    expect(client.getFileContent).not.toHaveBeenCalled()
  })
})
