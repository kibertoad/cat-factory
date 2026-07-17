import type { GitHubBranch, GitHubIssue, GitHubPullRequest, GitHubRepo } from '@cat-factory/kernel'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { githubDeps, makeApp, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '@cat-factory/conformance'
import { D1GitHubInstallationRepository } from '../../src/infrastructure/repositories/D1GitHubInstallationRepository'

function seededClient(installationId: number): FakeGitHubClient {
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
    { repoGithubId: 101, name: 'feature', headSha: 'sha-feat', protected: false, syncedAt: 0 },
  ]
  client.pulls = [
    {
      repoGithubId: 101,
      number: 7,
      githubId: 5001,
      title: 'Add feature',
      state: 'open',
      headRef: 'feature',
      baseRef: 'main',
      headSha: 'sha-feat',
      merged: false,
      author: 'dev',
      updatedAt: 1000,
      syncedAt: 0,
    },
  ]
  client.issues = [
    {
      repoGithubId: 101,
      number: 3,
      githubId: 6001,
      title: 'A bug',
      state: 'open',
      author: 'reporter',
      labels: ['bug'],
      updatedAt: 900,
      syncedAt: 0,
    },
  ]
  client.commits = [
    {
      repoGithubId: 101,
      sha: 'sha-main',
      message: 'init',
      author: 'dev',
      authoredAt: 800,
      syncedAt: 0,
    },
  ]
  client.checks = [
    {
      repoGithubId: 101,
      githubId: 7001,
      headSha: 'sha-main',
      name: 'ci',
      status: 'completed',
      conclusion: 'success',
      syncedAt: 0,
    },
  ]
  return client
}

describe('github sync', () => {
  it('projects repos, branches, pulls and issues for the linked repo', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    // Explicitly link repo 101 — this projects and deep-syncs just that repo.
    const link = await app.call('PUT', `/workspaces/${ws}/github/repos`, { repoGithubIds: [101] })
    expect(link.status).toBe(200)
    const resync = await app.call('POST', `/workspaces/${ws}/github/resync`, {})
    expect(resync.status).toBe(200)

    const repos = (await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)).body
    expect(repos).toHaveLength(1)
    expect(repos[0]!.githubId).toBe(101)
    expect(repos[0]!.defaultBranch).toBe('main')

    const branches = (
      await app.call<GitHubBranch[]>('GET', `/workspaces/${ws}/github/repos/101/branches`)
    ).body
    expect(branches.map((b) => b.name).sort()).toEqual(['feature', 'main'])

    const pulls = (await app.call<GitHubPullRequest[]>('GET', `/workspaces/${ws}/github/pulls`))
      .body
    expect(pulls).toHaveLength(1)
    expect(pulls[0]!.number).toBe(7)
    expect(pulls[0]!.baseRef).toBe('main')

    const issues = (await app.call<GitHubIssue[]>('GET', `/workspaces/${ws}/github/issues`)).body
    expect(issues).toHaveLength(1)
    expect(issues[0]!.labels).toEqual(['bug'])
  })

  it('unlinking a repo tombstones it for the workspace', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    await app.call('PUT', `/workspaces/${ws}/github/repos`, { repoGithubIds: [101] })
    expect(
      (await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)).body,
    ).toHaveLength(1)

    // Deselect the repo: linking an empty set tombstones it.
    await app.call('PUT', `/workspaces/${ws}/github/repos`, { repoGithubIds: [] })
    expect(
      (await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)).body,
    ).toHaveLength(0)
  })

  it('resyncs a single repo on demand', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    await app.call('PUT', `/workspaces/${ws}/github/repos`, { repoGithubIds: [101] })

    const single = await app.call<{ status: string }>('POST', `/workspaces/${ws}/github/resync`, {
      repoGithubId: 101,
    })
    expect(single.status).toBe(200)
    expect(single.body.status).toBe('synced')
  })

  it('bounds the initial commit backfill to the retention horizon', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    await app.call('PUT', `/workspaces/${ws}/github/repos`, { repoGithubIds: [101] })

    // The first sync has no commit cursor, so it must pass a `since` floor (the
    // default 90-day horizon) rather than fetching the repo's full history.
    expect(client.commitListOpts.length).toBeGreaterThanOrEqual(1)
    const firstSince = client.commitListOpts[0]!.since
    expect(firstSince).toBeTruthy()
    const horizonMs = Date.now() - Date.parse(firstSince!)
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
    // Roughly 90 days back, allowing slack for test execution time.
    expect(horizonMs).toBeGreaterThan(ninetyDaysMs - 60_000)
    expect(horizonMs).toBeLessThan(ninetyDaysMs + 60_000)
  })

  it('returns 503 from read endpoints when GitHub is not configured', async () => {
    const app = makeApp() // no github deps → no github module
    const { workspace } = await app.createWorkspace()
    const res = await app.call('GET', `/workspaces/${workspace.id}/github/repos`)
    expect(res.status).toBe(503)
  })

  it('listByInstallationIds batches the connect-UI annotation read (tombstones included)', async () => {
    const repo = new D1GitHubInstallationRepository({ db: env.DB })
    const first = uniqueInstallationId()
    const second = uniqueInstallationId()
    const installation = (installationId: number) => ({
      installationId,
      // github_installations.workspace_id is UNIQUE — one binding per workspace.
      workspaceId: `ws_conn_${installationId}`,
      accountId: null,
      accountLogin: 'octo',
      targetType: 'Organization' as const,
      appId: null,
      provider: 'github' as const,
      cachedToken: null,
      tokenExpiresAt: null,
      createdAt: 1000,
      deletedAt: null,
    })
    await repo.upsert(installation(first))
    await repo.upsert(installation(second))
    await repo.softDelete(second, 2000)

    // The batched read mirrors the point read: tombstoned rows included, unknown ids absent.
    // 2_000_000_001 is above uniqueInstallationId's range, so it is never a real row.
    const found = await repo.listByInstallationIds([first, second, 2_000_000_001])
    expect(found.map((i) => i.installationId).sort()).toEqual([first, second].sort())
    expect(found.find((i) => i.installationId === second)?.deletedAt).toBe(2000)
    expect(await repo.listByInstallationIds([])).toEqual([])
  })
})
