import { requestHumanTestFixSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

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
  app.post('/blocks/:blockId/human-test/confirm', async (c) => {
    const instance = await c
      .get('container')
      .executionService.confirmHumanTest(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(instance)
  })

  // Submit findings and request a fix: dispatch the fixer, rebuild the env, re-park.
  app.post(
    '/blocks/:blockId/human-test/request-fix',
    jsonBody(requestHumanTestFixSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.requestHumanTestFix(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').findings,
        )
      return c.json(instance)
    },
  )

  // Pull the repo default branch into the PR branch + redeploy. A clean merge rebuilds the
  // env; a conflict dispatches the conflict-resolver (then rebuilds on its completion).
  app.post('/blocks/:blockId/human-test/pull-main', async (c) => {
    const instance = await c
      .get('container')
      .executionService.pullMainHumanTest(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(instance)
  })

  // Rebuild the ephemeral environment on demand.
  app.post('/blocks/:blockId/human-test/recreate-env', async (c) => {
    const instance = await c
      .get('container')
      .executionService.recreateHumanTestEnv(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(instance)
  })

  // Destroy the ephemeral environment on demand (the run stays parked).
  app.post('/blocks/:blockId/human-test/destroy-env', async (c) => {
    const instance = await c
      .get('container')
      .executionService.destroyHumanTestEnv(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(instance)
  })

  return app
}
