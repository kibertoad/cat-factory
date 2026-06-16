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

  it('discovers the App installations, annotating which are already bound', async () => {
    const client = new FakeGitHubClient()
    const mine = uniqueInstallationId()
    const theirs = uniqueInstallationId()
    const free = uniqueInstallationId()
    client.installations = [
      { installationId: mine, accountLogin: 'me', targetType: 'User', accountAvatarUrl: null },
      {
        installationId: theirs,
        accountLogin: 'org',
        targetType: 'Organization',
        accountAvatarUrl: null,
      },
      { installationId: free, accountLogin: 'free', targetType: 'User', accountAvatarUrl: null },
    ]
    const app = makeApp(new FakeAgentExecutor(), githubDeps({ client }))
    const a = await app.createWorkspace()
    const b = await app.createWorkspace()

    // `mine` is bound to workspace A; `theirs` to workspace B; `free` to nobody.
    await app.call('POST', `/workspaces/${a.workspace.id}/github/connect`, { installationId: mine })
    await app.call('POST', `/workspaces/${b.workspace.id}/github/connect`, {
      installationId: theirs,
    })

    const res = await app.call<{
      installations: { installationId: number; connected: 'this' | 'other' | 'none' }[]
    }>('GET', `/workspaces/${a.workspace.id}/github/installations`)
    expect(res.status).toBe(200)
    const byId = new Map(res.body.installations.map((i) => [i.installationId, i.connected]))
    expect(byId.get(mine)).toBe('this')
    expect(byId.get(theirs)).toBe('other')
    expect(byId.get(free)).toBe('none')
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

  it('rejects a setup callback with an invalid state for an unbound installation', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const res = await app.call(
      'GET',
      `/github/setup/callback?installation_id=${uniqueInstallationId()}&state=not-a-valid-state`,
    )
    expect(res.status).toBe(401)
  })

  it('accepts a stateless update callback for an already-bound installation', async () => {
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const { workspace } = await app.createWorkspace()
    const installationId = uniqueInstallationId()

    // Bind first (as the install-url → callback flow would).
    await app.call('POST', `/workspaces/${workspace.id}/github/connect`, { installationId })

    // GitHub's repo-access "update" redirect carries no state. Since the
    // installation is already bound, the callback recovers the workspace and
    // redirects instead of rejecting.
    const cb = await app.call(
      'GET',
      `/github/setup/callback?installation_id=${installationId}&setup_action=update`,
    )
    expect(cb.status).toBe(302)
  })
})
