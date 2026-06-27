import {
  createScheduleContract,
  deleteScheduleContract,
  listScheduleRunsContract,
  listSchedulesContract,
  runScheduleNowContract,
  updateScheduleContract,
} from '@cat-factory/contracts'
import type { RecurringModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the recurring-pipeline module or send a 503, returning null when unconfigured. */
function requireRecurring<E extends AppEnv>(c: Context<E>): RecurringModule | null {
  return c.get('container').recurring ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Recurring pipelines are not configured' } }, 503)

/**
 * CRUD + run history for a workspace's recurring pipelines (schedules that re-run a
 * pipeline against a service on a cadence). Mounted under `/workspaces/:workspaceId`.
 */
export function recurringPipelineController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listSchedulesContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    return c.json(await recurring.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createScheduleContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(schedule, 201)
  })

  buildHonoRoute(app, updateScheduleContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').scheduleId,
      c.req.valid('json'),
    )
    return c.json(schedule, 200)
  })

  buildHonoRoute(app, deleteScheduleContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    await recurring.service.remove(param(c, 'workspaceId'), c.req.valid('param').scheduleId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, listScheduleRunsContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    return c.json(
      await recurring.service.listRuns(param(c, 'workspaceId'), c.req.valid('param').scheduleId),
      200,
    )
  })

  buildHonoRoute(app, runScheduleNowContract, async (c) => {
    const recurring = requireRecurring(c)
    if (!recurring) return unavailable(c)
    const schedule = await recurring.service.runNow(
      param(c, 'workspaceId'),
      c.req.valid('param').scheduleId,
    )
    return c.json(schedule, 200)
  })

  return app
}
