import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { PublicApiScope } from '@cat-factory/contracts'
import type { GuidedReviewModule } from '@cat-factory/orchestration'
import { publicGuidedReviewController } from './PublicGuidedReviewController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// What the public controller alone decides: which scope each route needs, and WHO a key acts as.
// The guided-review rules themselves are the service's spec.

function harness(opts: { scope?: PublicApiScope; actsAsUserId?: string | null } = {}) {
  const calls: { method: string; args: unknown[] }[] = []
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return result
    }
  const service = {
    open: record('open', { id: 'grs_1' }),
    getSession: record('getSession', { session: { id: 'grs_1' }, threads: [], drafts: [] }),
    listSessions: record('listSessions', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
  }
  const container = {
    guidedReview: { service } as unknown as GuidedReviewModule,
    publicApiKeys: {
      authenticate: async (secret?: string) =>
        secret === 'good'
          ? {
              workspaceId: 'ws_1',
              scope: opts.scope ?? 'write',
              keyId: 'pak_1',
              actsAsUserId: opts.actsAsUserId ?? null,
            }
          : null,
    },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicGuidedReviewController())
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { call, calls }
}

const OPEN = { owner: 'acme', repo: 'shop', prNumber: 7 }

describe('publicGuidedReviewController', () => {
  it('opens a session as the person a bound key acts for', async () => {
    const { call, calls } = harness({ actsAsUserId: 'usr_9' })
    expect((await call('POST', '/guided-reviews', OPEN)).status).toBe(200)
    expect(calls[0]).toEqual({ method: 'open', args: ['ws_1', 'usr_9', OPEN] })
  })

  it('opens a session as the key itself when it is bound to nobody', async () => {
    const { call, calls } = harness()
    await call('POST', '/guided-reviews', OPEN)
    expect(calls[0]?.args[1]).toBe('pak_1')
  })

  it('refuses to open with a read key, because opening spends model budget', async () => {
    const { call, calls } = harness({ scope: 'read' })
    const res = await call('POST', '/guided-reviews', OPEN)
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('lists at most `limit` sessions, says more matched, and narrows `mine` to the key identity', async () => {
    const { call, calls } = harness({ scope: 'read' })
    const res = await call('GET', '/guided-reviews?limit=2&mine=true')
    expect(res.body).toEqual({ sessions: [{ id: 'a' }, { id: 'b' }], truncated: true })
    expect(calls[0]?.args).toEqual(['ws_1', { createdBy: 'pak_1', limit: 3 }])
  })
})
