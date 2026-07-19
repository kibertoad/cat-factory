import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultVcsRegistry, VcsProviderRegistry } from '@cat-factory/kernel'
import type { VcsConnectionRef, VcsWebhookEvent } from '@cat-factory/kernel'
import { vcsWebhookController } from './VcsWebhookController.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// Exercises the neutral ingest route's behaviour (resolve provider → verify → map → sink)
// against a FAKE provider bundle registered on an injected `vcsRegistry` — the concrete GitLab
// adapter is covered in @cat-factory/gitlab.

function appWith(container: Partial<ServerContainer>) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', { vcsRegistry, ...container } as ServerContainer)
    await next()
  })
  app.route('/vcs', vcsWebhookController())
  return app
}

let vcsRegistry: VcsProviderRegistry

const gitlabConfig = {
  enabled: true,
  apiBase: 'https://gitlab.com/api/v4',
  connectionId: 'conn-1',
  webhookSecret: 'secret',
}

let mapped: VcsConnectionRef | null

beforeEach(() => {
  vcsRegistry = defaultVcsRegistry()
  mapped = null
  vcsRegistry.register({
    provider: 'gitlab',
    client: {} as never,
    webhookVerifier: { verify: async (_raw, sig) => sig === 'secret' },
    webhookMapper: {
      map: (connection, delivery): VcsWebhookEvent | null => {
        if (delivery.eventName !== 'Merge Request Hook') return null
        mapped = connection
        return {
          kind: 'pull-request',
          connection,
          repo: { repoId: '1', owner: 'g', repo: 'p' },
          pullRequest: {
            repoGithubId: 1,
            number: 3,
            githubId: 100,
            title: 't',
            state: 'open',
            headRef: 'feat',
            baseRef: 'main',
            headSha: 'abc',
            merged: false,
            author: 'alice',
            updatedAt: 0,
            syncedAt: 0,
          },
        }
      },
    },
  })
})

describe('vcsWebhookController', () => {
  it('rejects an invalid signature with 401', async () => {
    const events: VcsWebhookEvent[] = []
    const app = appWith({
      config: { gitlab: gitlabConfig } as never,
      vcsWebhookSink: { handle: async (e) => void events.push(e) },
    })
    const res = await app.request('/vcs/gitlab/webhooks', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'wrong', 'x-gitlab-event': 'Merge Request Hook' },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(events).toHaveLength(0)
  })

  it('verifies, maps with the resolved connection, and hands the event to the sink', async () => {
    const events: VcsWebhookEvent[] = []
    const app = appWith({
      config: { gitlab: gitlabConfig } as never,
      vcsWebhookSink: { handle: async (e) => void events.push(e) },
    })
    const res = await app.request('/vcs/gitlab/webhooks', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'secret', 'x-gitlab-event': 'Merge Request Hook' },
      body: JSON.stringify({ project: { id: 1 } }),
    })
    expect(res.status).toBe(202)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'pull-request' })
    // The connection is resolved from config BEFORE mapping and stamped onto the event.
    expect(mapped).toEqual({ provider: 'gitlab', connectionId: 'conn-1' })
  })

  it('acks (202) an unrecognised delivery without invoking the sink', async () => {
    const events: VcsWebhookEvent[] = []
    const app = appWith({
      config: { gitlab: gitlabConfig } as never,
      vcsWebhookSink: { handle: async (e) => void events.push(e) },
    })
    const res = await app.request('/vcs/gitlab/webhooks', {
      method: 'POST',
      headers: { 'x-gitlab-token': 'secret', 'x-gitlab-event': 'Wiki Page Hook' },
      body: JSON.stringify({ project: { id: 1 } }),
    })
    expect(res.status).toBe(202)
    expect(events).toHaveLength(0)
  })

  it('404s an unknown provider and 503s an unregistered/unconfigured one', async () => {
    const app = appWith({ config: { gitlab: gitlabConfig } as never })
    expect(
      (await app.request('/vcs/bitbucket/webhooks', { method: 'POST', body: '{}' })).status,
    ).toBe(404)
    // An empty registry (the provider was never registered) 503s the neutral route.
    const emptyApp = appWith({
      config: { gitlab: gitlabConfig } as never,
      vcsRegistry: defaultVcsRegistry(),
    })
    expect(
      (
        await emptyApp.request('/vcs/gitlab/webhooks', {
          method: 'POST',
          headers: { 'x-gitlab-token': 'secret' },
          body: '{}',
        })
      ).status,
    ).toBe(503)
  })
})
