import type { GitHubConnection } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { githubDeps, makeApp, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '../fakes/FakeGitHubClient'

describe('github connect', () => {
  it('binds an installation to a workspace and reads it back', async () => {
    const client = new FakeGitHubClient()
    client.installation = { accountLogin: 'acme', targetType: 'Organization' }
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const { workspace } = await app.createWorkspace()
    const installationId = uniqueInstallationId()

    const connected = await app.call<GitHubConnection>(
      'POST',
      `/workspaces/${workspace.id}/github/connect`,
      { installationId },
    )
    expect(connected.status).toBe(201)
    expect(connected.body.installationId).toBe(installationId)
    expect(connected.body.accountLogin).toBe('acme')

    const read = await app.call<{ connection: GitHubConnection | null }>(
      'GET',
      `/workspaces/${workspace.id}/github/connection`,
    )
    expect(read.body.connection?.installationId).toBe(installationId)
  })

  it('disconnects a workspace', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const { workspace } = await app.createWorkspace()
    await app.call('POST', `/workspaces/${workspace.id}/github/connect`, {
      installationId: uniqueInstallationId(),
    })

    const removed = await app.call('DELETE', `/workspaces/${workspace.id}/github/connection`)
    expect(removed.status).toBe(204)

    const read = await app.call<{ connection: unknown }>(
      'GET',
      `/workspaces/${workspace.id}/github/connection`,
    )
    expect(read.body.connection).toBeNull()
  })

  it('rejects binding an installation already owned by another workspace', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const a = await app.createWorkspace()
    const b = await app.createWorkspace()
    const installationId = uniqueInstallationId()

    await app.call('POST', `/workspaces/${a.workspace.id}/github/connect`, { installationId })
    const conflict = await app.call('POST', `/workspaces/${b.workspace.id}/github/connect`, {
      installationId,
    })
    expect(conflict.status).toBe(409)
  })

  it('binds via the signed setup callback (install-url → callback)', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const { workspace } = await app.createWorkspace()
    const installationId = uniqueInstallationId()

    // Obtain the signed install URL and extract the `state` we issued.
    const urlRes = await app.call<{ url: string }>(
      'GET',
      `/workspaces/${workspace.id}/github/install-url`,
    )
    expect(urlRes.status).toBe(200)
    const state = new URL(urlRes.body.url).searchParams.get('state')!
    expect(state).toBeTruthy()

    const cb = await app.call(
      'GET',
      `/github/setup/callback?installation_id=${installationId}&state=${encodeURIComponent(state)}`,
    )
    // Redirects to the configured frontend target on success.
    expect(cb.status).toBe(302)

    const read = await app.call<{ connection: { installationId: number } | null }>(
      'GET',
      `/workspaces/${workspace.id}/github/connection`,
    )
    expect(read.body.connection?.installationId).toBe(installationId)
  })

  it('rejects a setup callback with an invalid state', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const res = await app.call(
      'GET',
      `/github/setup/callback?installation_id=${uniqueInstallationId()}&state=not-a-valid-state`,
    )
    expect(res.status).toBe(401)
  })
})
