import type { Block, GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { githubDeps, makeApp, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

/** A client whose installation can access one repo (`acme/web`, id 101). */
function clientWithRepo(installationId: number): FakeGitHubClient {
  const client = new FakeGitHubClient()
  client.repos = [
    {
      githubId: 101,
      installationId,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      private: true,
      syncedAt: 0,
    },
  ]
  client.branches = [
    { repoGithubId: 101, name: 'main', headSha: 'sha-main', protected: true, syncedAt: 0 },
  ]
  return client
}

describe('add service from existing repo', () => {
  it('creates a ready service frame linked to a repo the App can access', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    // The workspace doesn't link repo 101 yet — import links + syncs it, no bootstrap.
    const res = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
    })
    expect(res.status).toBe(201)
    expect(res.body.level).toBe('frame')
    expect(res.body.parentId).toBeNull()
    expect(res.body.type).toBe('service')
    expect(res.body.status).toBe('ready')
    expect(res.body.title).toBe('web')

    // The repo is now tracked, and the frame's account-owned Service binds it to the repo
    // (the sole repo↔frame linkage).
    const repos = await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)
    expect(repos.body.find((r) => r.githubId === 101)).toBeTruthy()
    const snap = await app.call<{
      serviceCatalog?: { frameBlockId: string; repoGithubId: number | null }[]
    }>('GET', `/workspaces/${ws}`)
    expect(
      snap.body.serviceCatalog?.find((s) => s.frameBlockId === res.body.id)?.repoGithubId,
    ).toBe(101)
  })

  it('rejects importing a repo that is already on the board', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    const first = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
    })
    expect(first.status).toBe(201)

    const again = await app.call('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
    })
    expect(again.status).toBe(422)
  })

  it('unlinks the repo when its service frame is deleted, so it can be re-added', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    const first = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
    })
    expect(first.status).toBe(201)

    // Delete the service frame — its Service (the repo link) must be reclaimed, not dangling.
    const del = await app.call('DELETE', `/workspaces/${ws}/blocks/${first.body.id}`)
    expect(del.status).toBe(204)
    // The account-owned service for THAT frame is gone (scope by frame id: the catalog is
    // account-scoped, so a sibling workspace may legitimately still back repo 101).
    const snap = await app.call<{
      serviceCatalog?: { frameBlockId: string }[]
    }>('GET', `/workspaces/${ws}`)
    expect(snap.body.serviceCatalog?.some((s) => s.frameBlockId === first.body.id)).toBeFalsy()

    // The repo is addable again now that nothing claims it.
    const again = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
    })
    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(first.body.id)
  })

  it('flags a linked repo as a monorepo via PATCH', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    await app.call('POST', `/workspaces/${ws}/blocks/from-repo`, { repoGithubId: 101 })

    // Toggle the monorepo flag — this PATCH writes `github_repos.is_monorepo`, so it
    // exercises the column added by migration 0044 (a missing column 500s the update).
    const patched = await app.call<GitHubRepo>('PATCH', `/workspaces/${ws}/github/repos/101`, {
      isMonorepo: true,
    })
    expect(patched.status).toBe(200)
    expect(patched.body.isMonorepo).toBe(true)

    const repos = await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)
    expect(repos.body.find((r) => r.githubId === 101)?.isMonorepo).toBe(true)
  })

  it('flags the repo as a monorepo via the add request and pins each service to a directory', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    // Adding the first service flags the repo a monorepo (no separate PATCH) and pins
    // it to a subdirectory — the frame is titled after the directory's base name.
    const first = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
      isMonorepo: true,
      directory: 'packages/api',
    })
    expect(first.status).toBe(201)
    expect(first.body.title).toBe('api')

    // The repo is now flagged a monorepo, so it can back further services (each service is
    // its own Service row pinned to a subdirectory).
    const repos = await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)
    const repo = repos.body.find((r) => r.githubId === 101)
    expect(repo?.isMonorepo).toBe(true)

    // A second subdirectory adds a second service from the same repo.
    const second = await app.call<Block>('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
      isMonorepo: true,
      directory: 'packages/web',
    })
    expect(second.status).toBe(201)
    expect(second.body.title).toBe('web')

    // The same subdirectory can't back two services.
    const dup = await app.call('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
      isMonorepo: true,
      directory: 'packages/api',
    })
    expect(dup.status).toBe(422)
  })

  it('rejects a monorepo add request with no directory', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    const res = await app.call('POST', `/workspaces/${ws}/blocks/from-repo`, {
      repoGithubId: 101,
      isMonorepo: true,
    })
    expect(res.status).toBe(422)
  })

  it('409s when the App cannot access the requested repo', async () => {
    const installationId = uniqueInstallationId()
    const app = makeApp(
      new FakeAgentExecutor(),
      githubDeps({ client: clientWithRepo(installationId) }),
    )
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id
    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })

    const res = await app.call<{ error: { code: string } }>(
      'POST',
      `/workspaces/${ws}/blocks/from-repo`,
      { repoGithubId: 999 },
    )
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('repo_not_accessible')
  })
})
