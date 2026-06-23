import {
  connectTaskSourceSchema,
  createTaskFromIssueSchema,
  taskSourceKindSchema,
  importTaskSchema,
  linkTaskSchema,
  searchTasksSchema,
  type TaskSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { ValidationError } from '@cat-factory/kernel'
import type { TasksModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the tasks module or send a 503, returning null when unconfigured. */
function requireTasks(c: Context<AppEnv>): TasksModule | null {
  return c.get('container').tasks ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Task-source integration is not configured' } },
    503,
  )

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam(c: Context<AppEnv>): TaskSourceKind {
  const source = param(c, 'source')
  if (!v.is(taskSourceKindSchema, source)) {
    throw new ValidationError(`Unknown task source '${source}'`)
  }
  return source
}

/**
 * Workspace-scoped, source-parameterized task endpoints: source discovery,
 * connection management, issue import, issue listing, and linking an issue to a
 * block as agent context. Mounted under `/workspaces/:workspaceId`.
 */
export function taskSourceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- source discovery ---------------------------------------------------

  // The configured sources + their connect/import metadata (drives the UI). A
  // 503 here is how the frontend learns the integration is off.
  app.get('/task-sources', async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    return c.json({ sources: tasks.connectionService.listSources() })
  })

  // ---- connections --------------------------------------------------------

  app.get('/task-sources/connections', async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const connections = await tasks.connectionService.listConnections(param(c, 'workspaceId'))
    return c.json({ connections })
  })

  app.post('/task-sources/:source/connect', jsonBody(connectTaskSourceSchema), async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const connection = await tasks.connectionService.connect(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').credentials,
    )
    return c.json(connection, 201)
  })

  app.delete('/task-sources/:source/connection', async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    await tasks.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c))
    return c.body(null, 204)
  })

  // ---- issues -------------------------------------------------------------

  app.get('/tasks', async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    return c.json(await tasks.importService.listTasks(param(c, 'workspaceId')))
  })

  app.post('/task-sources/:source/import', jsonBody(importTaskSchema), async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const task = await tasks.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
    )
    return c.json(task, 201)
  })

  // Search a tracker's issues by free text (title/content), returning lean hits
  // the picker can import + link on selection.
  app.post('/task-sources/:source/search', jsonBody(searchTasksSchema), async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const results = await tasks.importService.search(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').query,
    )
    return c.json({ results })
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported issue to a block as extra agent context.
  app.post('/tasks/link', jsonBody(linkTaskSchema), async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const { source, externalId, blockId } = c.req.valid('json')
    const task = await tasks.linkService.linkToBlock(
      param(c, 'workspaceId'),
      blockId,
      source,
      externalId,
    )
    return c.json(task, 201)
  })

  // Materialise an imported issue as a new board task inside a container, linking
  // the issue to it for context. Returns the created block + the linked issue.
  app.post('/tasks/create-block', jsonBody(createTaskFromIssueSchema), async (c) => {
    const tasks = requireTasks(c)
    if (!tasks) return unavailable(c)
    const { source, externalId, containerId } = c.req.valid('json')
    const result = await tasks.linkService.createTaskFromIssue(
      param(c, 'workspaceId'),
      containerId,
      source,
      externalId,
    )
    return c.json(result, 201)
  })

  return app
}
