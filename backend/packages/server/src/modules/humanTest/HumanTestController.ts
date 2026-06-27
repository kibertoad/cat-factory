import {
  confirmHumanTestContract,
  destroyHumanTestEnvContract,
  pullMainHumanTestContract,
  recreateHumanTestEnvContract,
  requestHumanTestFixContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped run-driving endpoints for the human-testing gate. Each acts on the block's
 * parked `human-test` step via the execution service: confirm (tear the env down + advance),
 * request a fix from findings (dispatch the Tester's `fixer`), pull latest main into the branch
 * + redeploy (conflict → conflict-resolver), recreate the env, or destroy it. They return the
 * updated execution instance (the step's `humanTest` state is read off it / the live stream).
 * Mounted under `/workspaces/:workspaceId`.
 */
export function humanTestController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The human validated the change in the env: tear it down and advance the pipeline.
  buildHonoRoute(app, confirmHumanTestContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.confirmHumanTest(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(instance, 200)
  })

  // Submit findings and request a fix: dispatch the fixer, rebuild the env, re-park.
  buildHonoRoute(app, requestHumanTestFixContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.requestHumanTestFix(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').findings,
      )
    return c.json(instance, 200)
  })

  // Pull the repo default branch into the PR branch + redeploy. A clean merge rebuilds the
  // env; a conflict dispatches the conflict-resolver (then rebuilds on its completion).
  buildHonoRoute(app, pullMainHumanTestContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.pullMainHumanTest(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(instance, 200)
  })

  // Rebuild the ephemeral environment on demand.
  buildHonoRoute(app, recreateHumanTestEnvContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.recreateHumanTestEnv(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(instance, 200)
  })

  // Destroy the ephemeral environment on demand (the run stays parked).
  buildHonoRoute(app, destroyHumanTestEnvContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.destroyHumanTestEnv(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(instance, 200)
  })

  return app
}
