import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { PublicApiScope } from '@cat-factory/contracts'
import type { PrAssessmentModule } from '@cat-factory/orchestration'
import { publicPrAssessmentController } from './PublicPrAssessmentController.js'
import { handleError } from '../../http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../../http/env.js'

// What the controller alone decides: the scope, who the call runs as and under which role, and
// the 503 when no risk-policy library is wired. The assessment rules are the service's spec.

const RESULT = {
  provider: 'github',
  owner: 'acme',
  repo: 'shop',
  prNumber: 7,
  headSha: 'abc',
  changeClass: 'docs',
  changedFileCount: 1,
  assessment: { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'Docs.' },
  model: 'fake:fake',
  policy: { policyId: 'rp_1', name: 'Balanced' },
  verdict: { outcome: 'within_policy', reason: 'within_thresholds', exceededAxes: [] },
  assessedAt: 1,
}

function harness(
  opts: { scope?: PublicApiScope; wired?: boolean; actsAsUserId?: string; allowed?: boolean } = {},
) {
  const calls: unknown[][] = []
  const service = {
    assess: async (...args: unknown[]) => {
      calls.push(args)
      return RESULT
    },
  }
  const container = {
    ...(opts.wired === false ? {} : { prAssessment: { service } as unknown as PrAssessmentModule }),
    // The bound person's access, as the shared workspace-access cache answers it.
    caches: {
      workspaceAccess: {
        get: async () => ({ access: { allowed: opts.allowed ?? true, role: 'member' } }),
      },
    },
    publicApiKeys: {
      authenticate: async () => ({
        workspaceIds: ['ws_1'],
        scope: opts.scope ?? 'write',
        keyId: 'pak_1',
        actsAsUserId: opts.actsAsUserId ?? null,
      }),
    },
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', publicPrAssessmentController())
  const post = async (body: unknown) => {
    const res = await app.request('/api/v1/pr-assessments', {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { post, calls }
}

const BODY = { owner: ' acme ', repo: 'shop', prNumber: 7, riskPolicyId: 'rp_1' }

describe('publicPrAssessmentController', () => {
  it('assesses as the person a bound key acts for, under their role, with the trimmed body', async () => {
    const { post, calls } = harness({ actsAsUserId: 'usr_9' })
    const res = await post(BODY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(RESULT)
    expect(calls).toEqual([
      ['ws_1', { userId: 'usr_9', role: 'member' }, { ...BODY, owner: 'acme' }],
    ])
  })

  it('pins no role for a bound person whose access no longer resolves', async () => {
    const { post, calls } = harness({ actsAsUserId: 'usr_9', allowed: false })
    await post(BODY)
    expect(calls[0]?.[1]).toEqual({ userId: 'usr_9', role: null })
  })

  it('assesses on the workspace credentials, with no role, for a key bound to nobody', async () => {
    const { post, calls } = harness()
    await post(BODY)
    expect(calls[0]?.[1]).toEqual({ userId: null, role: null })
  })

  it('refuses a read key, because an assessment spends model budget', async () => {
    const { post, calls } = harness({ scope: 'read' })
    expect((await post(BODY)).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('names the missing risk-policy library', async () => {
    const { post } = harness({ wired: false })
    const res = await post(BODY)
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: { details: { reason: 'risk_policies_unwired' } } })
  })
})
