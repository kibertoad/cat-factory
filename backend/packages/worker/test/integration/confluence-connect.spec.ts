import type { ConfluenceConnection } from '@cat-factory/core'
import { describe, expect, it } from 'vitest'
import { confluenceDeps, makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

const creds = {
  baseUrl: 'https://acme.atlassian.net',
  accountEmail: 'dev@acme.io',
  apiToken: 'secret-token',
}

describe('confluence connect', () => {
  it('connects a workspace and reads it back without leaking the token', async () => {
    const app = makeApp(new FakeAgentExecutor(), confluenceDeps())
    const { workspace } = await app.createWorkspace({ seed: false })

    const connected = await app.call<ConfluenceConnection>(
      'POST',
      `/workspaces/${workspace.id}/confluence/connect`,
      creds,
    )
    expect(connected.status).toBe(201)
    expect(connected.body.accountEmail).toBe('dev@acme.io')
    expect(connected.body.baseUrl).toBe('https://acme.atlassian.net')
    expect((connected.body as Record<string, unknown>).apiToken).toBeUndefined()

    const read = await app.call<{ connection: ConfluenceConnection | null }>(
      'GET',
      `/workspaces/${workspace.id}/confluence/connection`,
    )
    expect(read.body.connection?.accountEmail).toBe('dev@acme.io')
    expect((read.body.connection as Record<string, unknown>).apiToken).toBeUndefined()
  })

  it('normalizes a base URL that includes a trailing /wiki', async () => {
    const app = makeApp(new FakeAgentExecutor(), confluenceDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    const connected = await app.call<ConfluenceConnection>(
      'POST',
      `/workspaces/${workspace.id}/confluence/connect`,
      { ...creds, baseUrl: 'https://acme.atlassian.net/wiki/' },
    )
    expect(connected.body.baseUrl).toBe('https://acme.atlassian.net')
  })

  it('disconnects and allows reconnecting with a different account', async () => {
    const app = makeApp(new FakeAgentExecutor(), confluenceDeps())
    const { workspace } = await app.createWorkspace({ seed: false })
    await app.call('POST', `/workspaces/${workspace.id}/confluence/connect`, creds)

    const removed = await app.call('DELETE', `/workspaces/${workspace.id}/confluence/connection`)
    expect(removed.status).toBe(204)

    const afterDisconnect = await app.call<{ connection: unknown }>(
      'GET',
      `/workspaces/${workspace.id}/confluence/connection`,
    )
    expect(afterDisconnect.body.connection).toBeNull()

    const reconnect = await app.call<ConfluenceConnection>(
      'POST',
      `/workspaces/${workspace.id}/confluence/connect`,
      { ...creds, accountEmail: 'other@acme.io' },
    )
    expect(reconnect.status).toBe(201)
    expect(reconnect.body.accountEmail).toBe('other@acme.io')
  })

  it('returns 503 when the integration is not configured', async () => {
    const app = makeApp(new FakeAgentExecutor())
    const { workspace } = await app.createWorkspace({ seed: false })
    const res = await app.call('GET', `/workspaces/${workspace.id}/confluence/connection`)
    expect(res.status).toBe(503)
  })
})
