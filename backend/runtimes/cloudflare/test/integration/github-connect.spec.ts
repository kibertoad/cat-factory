import type { GitHubConnection } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { githubDeps, makeApp, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '@cat-factory/conformance'

describe('github connect', () => {
  it('binds an installation to a workspace and reads it back', async () => {
    const client = new FakeGitHubClient()
    client.installation = { accountLogin: 'acme', targetType: 'Organization', appId: 'app-default' }
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
    // The App-only affordances the SPA offers (the installation settings page, the
    // repo-access grant) key off this, so the connect response and the read must agree
    // that this is an installation rather than a pasted token.
    expect(connected.body.method).toBe('app')
    // Where this connection's repositories can be opened, derived by the facade from the API
    // base it was configured with. The SPA renders every repo / PR / issue link from it, so a
    // facade that forgot to wire the resolver silently strips those links on that runtime only
    // — which is why the Node facade asserts the same thing against its own composition root.
    expect(connected.body.webUrl).toBe('https://github.com')

    const read = await app.call<{ connection: GitHubConnection | null }>(
      'GET',
      `/workspaces/${workspace.id}/github/connection`,
    )
    expect(read.body.connection?.installationId).toBe(installationId)
    expect(read.body.connection?.method).toBe('app')
    expect(read.body.connection?.webUrl).toBe('https://github.com')
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

  it('no longer rejects binding the same installation to another workspace', async () => {
    // One GitHub account → many boards. The old blanket cross-workspace guard is
    // gone: the boundary is now the *account*, so binding is only rejected across
    // different accounts. With auth disabled (the test path) both boards share the
    // unscoped (null) account, so the second bind is allowed. (Account-level
    // sharing across boards is exercised in the accounts integration test.)
    const app = makeApp(new FakeAgentExecutor(), githubDeps())
    const a = await app.createWorkspace()
    const b = await app.createWorkspace()
    const installationId = uniqueInstallationId()

    const first = await app.call('POST', `/workspaces/${a.workspace.id}/github/connect`, {
      installationId,
    })
    const second = await app.call('POST', `/workspaces/${b.workspace.id}/github/connect`, {
      installationId,
    })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
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
