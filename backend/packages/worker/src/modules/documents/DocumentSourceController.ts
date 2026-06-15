import {
  connectDocumentSourceSchema,
  documentSourceKindSchema,
  importDocumentSchema,
  linkDocumentSchema,
  planDocumentSchema,
  spawnDocumentSchema,
  type DocumentSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { ValidationError, type DocumentsModule } from '@cat-factory/core'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Resolve the documents module or send a 503, returning null when unconfigured. */
function requireDocuments(c: Context<AppEnv>): DocumentsModule | null {
  return c.get('container').documents ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Document-source integration is not configured' } },
    503,
  )

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam(c: Context<AppEnv>): DocumentSourceKind {
  const source = param(c, 'source')
  if (!v.is(documentSourceKindSchema, source)) {
    throw new ValidationError(`Unknown document source '${source}'`)
  }
  return source
}

/**
 * Workspace-scoped, source-parameterized document endpoints: source discovery,
 * connection management, page import, document listing, structure
 * planning/spawning, and linking a page to a block as agent context. Mounted
 * under `/workspaces/:workspaceId`.
 */
export function documentSourceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- source discovery ---------------------------------------------------

  // The configured sources + their connect/import metadata (drives the UI). A
  // 503 here is how the frontend learns the integration is off.
  app.get('/document-sources', async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    return c.json({ sources: documents.connectionService.listSources() })
  })

  // ---- connections --------------------------------------------------------

  app.get('/document-sources/connections', async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const connections = await documents.connectionService.listConnections(param(c, 'workspaceId'))
    return c.json({ connections })
  })

  app.post(
    '/document-sources/:source/connect',
    jsonBody(connectDocumentSourceSchema),
    async (c) => {
      const documents = requireDocuments(c)
      if (!documents) return unavailable(c)
      const connection = await documents.connectionService.connect(
        param(c, 'workspaceId'),
        sourceParam(c),
        c.req.valid('json').credentials,
      )
      return c.json(connection, 201)
    },
  )

  app.delete('/document-sources/:source/connection', async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    await documents.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c))
    return c.body(null, 204)
  })

  // ---- documents ----------------------------------------------------------

  app.get('/documents', async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    return c.json(await documents.importService.listDocuments(param(c, 'workspaceId')))
  })

  app.post('/document-sources/:source/import', jsonBody(importDocumentSchema), async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const document = await documents.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
    )
    return c.json(document, 201)
  })

  // ---- planning / spawning ------------------------------------------------

  // Preview the board structure a page would expand into (no writes).
  app.post('/document-sources/:source/plan', jsonBody(planDocumentSchema), async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      c.req.valid('json').externalId,
    )
    return c.json(await documents.plannerService.plan(record))
  })

  // Apply a page's structure to the board (new frames, or into an existing one).
  app.post('/document-sources/:source/spawn', jsonBody(spawnDocumentSchema), async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const { externalId, frameId } = c.req.valid('json')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      externalId,
    )
    const plan = await documents.plannerService.plan(record)
    const result = await documents.linkService.spawn(workspaceId, plan, frameId)
    return c.json({ plan, result }, 201)
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported page to a block as extra agent context.
  app.post('/documents/link', jsonBody(linkDocumentSchema), async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const { source, externalId, blockId } = c.req.valid('json')
    const document = await documents.linkService.linkToBlock(
      param(c, 'workspaceId'),
      blockId,
      source,
      externalId,
    )
    return c.json(document, 201)
  })

  return app
}
