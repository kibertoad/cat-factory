import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ConflictError } from '@cat-factory/kernel'
import type { GuidedReviewModule } from '@cat-factory/orchestration'
import { guidedReviewController } from './GuidedReviewController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// What the controller owns: who the caller is, and that a refusal reaches the client as the
// envelope the SPA maps (`details.reason`), not a 500. The service's own rules are its spec's.

function harness(opts: { user?: string } = {}) {
  const asked: unknown[][] = []
  const deleted: unknown[][] = []
  const service = {
    async ask(...args: unknown[]) {
      asked.push(args)
      throw new ConflictError('busy', 'thread_busy')
    },
    async deleteSession(...args: unknown[]) {
      deleted.push(args)
    },
    async listSessions() {
      return []
    },
  }
  const container = {
    guidedReview: { service } as unknown as GuidedReviewModule,
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    if (opts.user) c.set('user', { id: opts.user } as never)
    await next()
  })
  app.route('/workspaces/:workspaceId', guidedReviewController())
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/workspaces/ws_1${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: res.status === 204 ? null : await res.json() }
  }
  return { call, asked, deleted }
}

describe('guidedReviewController', () => {
  it('passes the caller and the route ids to the service and surfaces a busy thread as 409', async () => {
    const { call, asked } = harness({ user: 'usr_1' })
    const res = await call('POST', '/guided-reviews/grs_1/threads/grt_1/messages', {
      content: 'Why?',
    })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      error: { code: 'conflict', details: { reason: 'thread_busy' } },
    })
    expect(asked).toEqual([['ws_1', 'usr_1', 'grs_1', 'grt_1', { content: 'Why?' }]])
  })

  it('refuses a write with no signed-in user', async () => {
    const { call, asked } = harness()
    const res = await call('POST', '/guided-reviews/grs_1/threads/grt_1/messages', {
      content: 'Why?',
    })
    expect(res.status).toBe(401)
    expect(asked).toEqual([])
  })

  it('rejects an empty question before the service sees it', async () => {
    const { call, asked } = harness({ user: 'usr_1' })
    expect(
      (await call('POST', '/guided-reviews/grs_1/threads/grt_1/messages', { content: '  ' }))
        .status,
    ).toBe(400)
    expect(asked).toEqual([])
  })

  it('answers a delete with 204', async () => {
    const { call, deleted } = harness({ user: 'usr_1' })
    expect((await call('DELETE', '/guided-reviews/grs_1')).status).toBe(204)
    expect(deleted).toEqual([['ws_1', 'usr_1', 'grs_1']])
  })
})
