import type { GitHubBranch, GitHubIssue, GitHubPullRequest, GitHubRepo } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { githubDeps, makeApp, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

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
      blockId: null,
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
  it('projects repos, branches, pulls and issues on an incremental resync', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
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

  it('tombstones repos that disappear from the installation', async () => {
    const installationId = uniqueInstallationId()
    const client = seededClient(installationId)
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const ws = workspace.id

    await app.call('POST', `/workspaces/${ws}/github/connect`, { installationId })
    await app.call('POST', `/workspaces/${ws}/github/resync`, {})
    expect(
      (await app.call<GitHubRepo[]>('GET', `/workspaces/${ws}/github/repos`)).body,
    ).toHaveLength(1)

    // The repo is no longer accessible to the installation.
    client.repos = []
    await app.call('POST', `/workspaces/${ws}/github/resync`, {})
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
    await app.call('POST', `/workspaces/${ws}/github/resync`, {})

    const single = await app.call<{ status: string }>('POST', `/workspaces/${ws}/github/resync`, {
      repoGithubId: 101,
    })
    expect(single.status).toBe(200)
    expect(single.body.status).toBe('synced')
  })

  it('returns 503 from read endpoints when GitHub is not configured', async () => {
    const app = makeApp() // no github deps → no github module
    const { workspace } = await app.createWorkspace()
    const res = await app.call('GET', `/workspaces/${workspace.id}/github/repos`)
    expect(res.status).toBe(503)
  })
})
