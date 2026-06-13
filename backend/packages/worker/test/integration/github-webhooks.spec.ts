import type { GitHubPullRequest, WorkspaceSnapshot } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { githubDeps, uniqueInstallationId } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { WebCryptoWebhookVerifier } from '../../src/infrastructure/github/WebCryptoWebhookVerifier'

const SECRET = 'test-webhook-secret'
const BASE = 'https://cat-factory.test'

/** Compute a GitHub-style `sha256=<hex>` signature over the raw body. */
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256=${hex}`
}

function buildApp() {
  return createApp({
    overrides: {
      agentExecutor: new FakeAgentExecutor(),
      ...githubDeps({ verifier: new WebCryptoWebhookVerifier(SECRET) }),
    },
  })
}

type App = ReturnType<typeof buildApp>

async function json<T>(app: App, method: string, path: string, body?: unknown): Promise<T> {
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
  )
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

function pullRequestEvent(installationId: number, repoId: number) {
  return {
    action: 'opened',
    installation: { id: installationId },
    repository: { id: repoId, name: 'web', owner: { login: 'acme' } },
    pull_request: {
      id: 5001,
      number: 7,
      title: 'Hello from webhook',
      state: 'open',
      merged: false,
      updated_at: '2026-06-01T00:00:00Z',
      user: { login: 'dev' },
      head: { ref: 'feature', sha: 'sha-feat', repo: { id: repoId } },
      base: { ref: 'main', repo: { id: repoId } },
    },
  }
}

async function postWebhook(app: App, event: string, body: string, signature: string) {
  return app.fetch(
    new Request(`${BASE}/github/webhooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-hub-signature-256': signature,
      },
      body,
    }),
    env,
  )
}

describe('github webhooks', () => {
  it('accepts a correctly-signed delivery and projects it (inline, no queue)', async () => {
    const app = buildApp()
    const installationId = uniqueInstallationId()
    const ws = (await json<WorkspaceSnapshot>(app, 'POST', '/workspaces', {})).workspace.id
    await json(app, 'POST', `/workspaces/${ws}/github/connect`, { installationId })

    const body = JSON.stringify(pullRequestEvent(installationId, 202))
    const res = await postWebhook(app, 'pull_request', body, await sign(SECRET, body))
    expect(res.status).toBe(202)

    const pulls = await json<GitHubPullRequest[]>(app, 'GET', `/workspaces/${ws}/github/pulls`)
    expect(pulls).toHaveLength(1)
    expect(pulls[0]!.number).toBe(7)
    expect(pulls[0]!.title).toBe('Hello from webhook')
    expect(pulls[0]!.repoGithubId).toBe(202)
  })

  it('rejects a delivery with a bad signature and makes no projection change', async () => {
    const app = buildApp()
    const installationId = uniqueInstallationId()
    const ws = (await json<WorkspaceSnapshot>(app, 'POST', '/workspaces', {})).workspace.id
    await json(app, 'POST', `/workspaces/${ws}/github/connect`, { installationId })

    const body = JSON.stringify(pullRequestEvent(installationId, 202))
    const res = await postWebhook(app, 'pull_request', body, 'sha256=deadbeef')
    expect(res.status).toBe(401)

    const pulls = await json<GitHubPullRequest[]>(app, 'GET', `/workspaces/${ws}/github/pulls`)
    expect(pulls).toHaveLength(0)
  })

  it('rejects a delivery with a missing signature', async () => {
    const app = buildApp()
    const body = JSON.stringify(pullRequestEvent(uniqueInstallationId(), 202))
    const res = await app.fetch(
      new Request(`${BASE}/github/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
        body,
      }),
      env,
    )
    expect(res.status).toBe(401)
  })

  it('tombstones the installation on an uninstall event', async () => {
    const app = buildApp()
    const installationId = uniqueInstallationId()
    const ws = (await json<WorkspaceSnapshot>(app, 'POST', '/workspaces', {})).workspace.id
    await json(app, 'POST', `/workspaces/${ws}/github/connect`, { installationId })

    const body = JSON.stringify({ action: 'deleted', installation: { id: installationId } })
    const res = await postWebhook(app, 'installation', body, await sign(SECRET, body))
    expect(res.status).toBe(202)

    const read = await json<{ connection: unknown }>(
      app,
      'GET',
      `/workspaces/${ws}/github/connection`,
    )
    expect(read.connection).toBeNull()
  })
})
