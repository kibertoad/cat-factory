import {
  connectConfluenceSchema,
  importConfluenceSchema,
  linkConfluenceTaskSchema,
  spawnConfluenceSchema,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ConfluenceModule } from '@cat-factory/core'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

const linkBlockSchema = v.object({ blockId: v.pipe(v.string(), v.minLength(1)) })

/** Resolve the Confluence module or send a 503, returning null when unconfigured. */
function requireConfluence(c: Context<AppEnv>): ConfluenceModule | null {
  return c.get('container').confluence ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Confluence integration is not configured' } },
    503,
  )

/**
 * Workspace-scoped Confluence endpoints: connection management, page import,
 * document listing, structure planning/spawning, and linking a page to a block
 * as agent context. Mounted under `/workspaces/:workspaceId`.
 */
export function confluenceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- connection ---------------------------------------------------------

  app.get('/confluence/connection', async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const connection = await confluence.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection })
  })

  app.post('/confluence/connect', jsonBody(connectConfluenceSchema), async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const connection = await confluence.connectionService.connect(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(connection, 201)
  })

  app.delete('/confluence/connection', async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    await confluence.connectionService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // ---- documents ----------------------------------------------------------

  app.get('/confluence/documents', async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    return c.json(await confluence.importService.listDocuments(param(c, 'workspaceId')))
  })

  app.post('/confluence/import', jsonBody(importConfluenceSchema), async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const document = await confluence.importService.import(
      param(c, 'workspaceId'),
      c.req.valid('json').page,
    )
    return c.json(document, 201)
  })

  // ---- planning / spawning ------------------------------------------------

  // Preview the board structure a page would expand into (no writes).
  app.post('/confluence/plan', jsonBody(linkConfluenceTaskSchema), async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const record = await confluence.importService.requireDocument(
      workspaceId,
      c.req.valid('json').pageId,
    )
    return c.json(await confluence.plannerService.plan(record))
  })

  // Apply a page's structure to the board (new frames, or into an existing one).
  app.post('/confluence/spawn', jsonBody(spawnConfluenceSchema), async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { pageId, frameId } = c.req.valid('json')
    const record = await confluence.importService.requireDocument(workspaceId, pageId)
    const plan = await confluence.plannerService.plan(record)
    const result = await confluence.linkService.spawn(workspaceId, plan, frameId)
    return c.json({ plan, result }, 201)
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported page to a block as extra agent context.
  app.post('/confluence/documents/:pageId/link', jsonBody(linkBlockSchema), async (c) => {
    const confluence = requireConfluence(c)
    if (!confluence) return unavailable(c)
    const document = await confluence.linkService.linkToBlock(
      param(c, 'workspaceId'),
      c.req.valid('json').blockId,
      param(c, 'pageId'),
    )
    return c.json(document, 201)
  })

  return app
}
