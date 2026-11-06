import { resumePublicRunCredentialContract } from '@cat-factory/contracts'
import { ConflictError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { capabilityWaitResolves } from '../execution/capabilityWaitResolves.js'
import { authorize, refuse } from './publicApiAuth.js'

/**
 * `POST /api/v1/runs/{runId}/credential/resume`: resume a run parked on a missing capability
 * credential once someone has stored it, with the same re-check the app's resume runs. A lapsed
 * PERSONAL credential is not renewable here: only the run's initiator renews it, with their
 * password, in the app.
 */
export function publicCredentialWaitController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, resumePublicRunCredentialContract, async (c) => {
    const gate = await authorize(c, resumePublicRunCredentialContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const container = c.get('container')
    const instance = await container.executionService.credentialWait.resume(
      workspaceId,
      c.req.valid('param').runId,
      gate.auth.actsAsUserId ?? null,
      {
        renewPersonal: async () => {
          throw new ConflictError(
            "A lapsed personal credential is renewed in the app by the run's initiator",
            'credential_wait_personal_in_app',
          )
        },
        capabilityResolves: capabilityWaitResolves(container, workspaceId),
      },
    )
    return c.json({ runId: instance.id, status: instance.status }, 200)
  })

  return app
}
