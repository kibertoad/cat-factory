import { assessPublicPullRequestContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { authorize, refuse } from './publicApiAuth.js'

// The public PR assessment (`POST /api/v1/pr-assessments`): one synchronous model call that scores
// a pull request and says whether a risk policy would land it. Every rule lives in the service.

export function publicPrAssessmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, assessPublicPullRequestContract, async (c) => {
    const gate = await authorize(c, assessPublicPullRequestContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    // Same reason the risk-policy list answers with: the verdict is judged against that library.
    const { service } = requireCapability(
      c.get('container').prAssessment,
      'Risk policies are not configured',
      'risk_policies_unwired',
    )
    // A key bound to a person reads the PR and calls the model as them; an unbound key runs on
    // the workspace's credentials.
    const assessment = await service.assess(
      gate.auth.workspaceId,
      gate.auth.actsAsUserId,
      c.req.valid('json'),
    )
    return c.json(assessment, 200)
  })

  return app
}
