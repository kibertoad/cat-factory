import {
  connectDocumentSourceContract,
  disconnectDocumentSourceContract,
  documentSourceKindSchema,
  importDocumentContract,
  linkDocumentContract,
  linkDocumentForKindContract,
  listDocumentConnectionsContract,
  listDocumentRoleLinksContract,
  listDocumentSourcesContract,
  listDocumentsContract,
  planDocumentContract,
  searchDocumentsContract,
  spawnDocumentContract,
  unlinkDocumentForKindContract,
  type DocumentSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { ValidationError } from '@cat-factory/kernel'
import type { DocumentsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { blockEditActor, requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the documents module, or refuse with a 503 naming what isn't wired. */
function requireDocuments<E extends AppEnv>(c: Context<E>): DocumentsModule {
  return requireCapability(
    c.get('container').documents,
    'Document-source integration is not configured',
  )
}

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam<E extends AppEnv>(c: Context<E>): DocumentSourceKind {
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
  app.use('*', requireWorkspacePermission('integrations.manage'))

  // ---- source discovery ---------------------------------------------------

  // The configured sources + their connect/import metadata (drives the UI). A
  // 503 here is how the frontend learns the integration is off.
  buildHonoRoute(app, listDocumentSourcesContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json({ sources: documents.connectionService.listSources() }, 200)
  })

  // ---- connections --------------------------------------------------------

  buildHonoRoute(app, listDocumentConnectionsContract, async (c) => {
    const documents = requireDocuments(c)
    const connections = await documents.connectionService.listConnections(param(c, 'workspaceId'))
    return c.json({ connections }, 200)
  })

  buildHonoRoute(app, connectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    const connection = await documents.connectionService.connect(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').credentials,
    )
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    await documents.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c))
    return c.body(null, 204)
  })

  // ---- documents ----------------------------------------------------------

  buildHonoRoute(app, listDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(await documents.importService.listDocuments(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, importDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const document = await documents.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
    )
    return c.json(document, 201)
  })

  // Search a source's catalogue by free text (title/content), returning lean hits
  // the picker can import + link on selection.
  buildHonoRoute(app, searchDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    const results = await documents.importService.search(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').query,
    )
    return c.json({ results }, 200)
  })

  // ---- planning / spawning ------------------------------------------------

  // Preview the board structure a page would expand into (no writes).
  buildHonoRoute(app, planDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const workspaceId = param(c, 'workspaceId')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      c.req.valid('json').externalId,
    )
    return c.json(await documents.plannerService.plan(record), 200)
  })

  // Apply a page's structure to the board (new frames, or into an existing one).
  buildHonoRoute(app, spawnDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const workspaceId = param(c, 'workspaceId')
    const { externalId, frameId } = c.req.valid('json')
    const record = await documents.importService.requireDocument(
      workspaceId,
      sourceParam(c),
      externalId,
    )
    const plan = await documents.plannerService.plan(record)
    // The plan comes from an imported document, but the board write is the member's: they asked
    // for the spawn on their own board, so it is judged under their tier (ADR 0037).
    const result = await documents.linkService.spawn(workspaceId, plan, blockEditActor(c), frameId)
    return c.json({ plan, result }, 201)
  })

  // ---- context links ------------------------------------------------------

  // Attach an imported page to a block as extra agent context.
  buildHonoRoute(app, linkDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId, blockId } = c.req.valid('json')
    const document = await documents.linkService.linkToBlock(
      param(c, 'workspaceId'),
      blockId,
      source,
      externalId,
    )
    return c.json(document, 201)
  })

  // ---- workspace+DocKind template / exemplar links (WS1 items 2–4) --------

  // Every role-tagged document in the workspace (drives the template/exemplar management panel).
  buildHonoRoute(app, listDocumentRoleLinksContract, async (c) => {
    const documents = requireDocuments(c)
    return c.json(await documents.linkService.listRoleLinks(param(c, 'workspaceId')), 200)
  })

  // Tag an imported page as the workspace's template (singular per kind) or exemplar for a kind.
  buildHonoRoute(app, linkDocumentForKindContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId, role, docKind } = c.req.valid('json')
    const document = await documents.linkService.linkForKind(
      param(c, 'workspaceId'),
      source,
      externalId,
      role,
      docKind,
    )
    return c.json(document, 201)
  })

  // Clear a document's role tag (built-in template resumes for the kind / exemplar drops).
  buildHonoRoute(app, unlinkDocumentForKindContract, async (c) => {
    const documents = requireDocuments(c)
    const { source, externalId } = c.req.valid('json')
    await documents.linkService.unlinkForKind(param(c, 'workspaceId'), source, externalId)
    return c.body(null, 204)
  })

  return app
}
