import { createScheduleSchema, updateScheduleSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RecurringModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the recurring-pipeline module or send a 503, returning null when unconfigured. */
function requireRecurring(c: Context<AppEnv>): RecurringModule | null {
  return c.get('container').recurring ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Recurring pipelines are not configured' } }, 503)

/**
 * CRUD + run history for a workspace's recurring pipelines (schedules that re-run a
 * pipeline against a service on a cadence). Mounted under `/workspaces/:workspaceId`.
 */
export function recurringPipelineController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/recurring-pipelines', async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    return c.json(await recurring.service.list(param(c, 'workspaceId')))
  })

  app.post('/recurring-pipelines', jsonBody(createScheduleSchema), async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(schedule, 201)
  })

  app.patch('/recurring-pipelines/:scheduleId', jsonBody(updateScheduleSchema), async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.update(
      param(c, 'workspaceId'),
      param(c, 'scheduleId'),
      c.req.valid('json'),
    )
    return c.json(schedule)
  })

  app.delete('/recurring-pipelines/:scheduleId', async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    await recurring.service.remove(param(c, 'workspaceId'), param(c, 'scheduleId'))
    return c.body(null, 204)
  })

  app.get('/recurring-pipelines/:scheduleId/runs', async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    return c.json(
      await recurring.service.listRuns(param(c, 'workspaceId'), param(c, 'scheduleId')),
    )
  })

  app.post('/recurring-pipelines/:scheduleId/run-now', async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.runNow(
      param(c, 'workspaceId'),
      param(c, 'scheduleId'),
    )
    return c.json(schedule)
  })

  return app
}
