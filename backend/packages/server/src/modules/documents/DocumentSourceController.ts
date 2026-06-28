import {
  connectDocumentSourceContract,
  disconnectDocumentSourceContract,
  documentSourceKindSchema,
  importDocumentContract,
  linkDocumentContract,
  listDocumentConnectionsContract,
  listDocumentSourcesContract,
  listDocumentsContract,
  planDocumentContract,
  searchDocumentsContract,
  spawnDocumentContract,
  type DocumentSourceKind,
} from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { ValidationError } from '@cat-factory/kernel'
import type { DocumentsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the documents module or send a 503, returning null when unconfigured. */
function requireDocuments<E extends AppEnv>(c: Context<E>): DocumentsModule | null {
  return c.get('container').documents ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Document-source integration is not configured' } },
    503,
  )

/** Read + validate the `:source` path param as a known source kind. */
function sourceParam<E extends AppEnv>(c: Context<E>): DocumentSourceKind {
  const source = param(c, 'source')
  if (!v.is(documentSourceKindSchema, source)) {
    throw new ValidationError(`Unknown document source '${source}'`)
  }
  return source
}

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage document sources' } }, 401)

/**
 * The acting user's id, used to scope a personal (`credentialScope: 'user'`) source's
 * credential — e.g. a Claude Design PAT. Returns the signed-in user's id; `''` ONLY when
 * auth is disabled (dev-open / single-user local mode) so those deployments still connect
 * a personal source. Returns `null` when auth is ENABLED but no user is present so the
 * caller fails closed with a 401 instead of silently reading/writing the shared empty-user
 * bucket (a cross-user credential exposure). Workspace-scoped sources ignore the value.
 */
function actingUserId<E extends AppEnv>(c: Context<E>): string | null {
  const user = c.get('user')
  if (user?.id) return user.id
  return c.get('container').config.auth.enabled ? null : ''
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
  buildHonoRoute(app, listDocumentSourcesContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    return c.json({ sources: documents.connectionService.listSources() }, 200)
  })

  // ---- connections --------------------------------------------------------

  buildHonoRoute(app, listDocumentConnectionsContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const userId = actingUserId(c)
    if (userId === null) return signInRequired(c)
    const connections = await documents.connectionService.listConnections(
      param(c, 'workspaceId'),
      userId,
    )
    return c.json({ connections }, 200)
  })

  buildHonoRoute(app, connectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const userId = actingUserId(c)
    if (userId === null) return signInRequired(c)
    const connection = await documents.connectionService.connect(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').credentials,
      userId,
    )
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectDocumentSourceContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const userId = actingUserId(c)
    if (userId === null) return signInRequired(c)
    await documents.connectionService.disconnect(param(c, 'workspaceId'), sourceParam(c), userId)
    return c.body(null, 204)
  })

  // ---- documents ----------------------------------------------------------

  buildHonoRoute(app, listDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    return c.json(await documents.importService.listDocuments(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, importDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const userId = actingUserId(c)
    if (userId === null) return signInRequired(c)
    const document = await documents.importService.import(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').ref,
      userId,
    )
    return c.json(document, 201)
  })

  // Search a source's catalogue by free text (title/content), returning lean hits
  // the picker can import + link on selection.
  buildHonoRoute(app, searchDocumentsContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
    const userId = actingUserId(c)
    if (userId === null) return signInRequired(c)
    const results = await documents.importService.search(
      param(c, 'workspaceId'),
      sourceParam(c),
      c.req.valid('json').query,
      userId,
    )
    return c.json({ results }, 200)
  })

  // ---- planning / spawning ------------------------------------------------

  // Preview the board structure a page would expand into (no writes).
  buildHonoRoute(app, planDocumentContract, async (c) => {
    const documents = requireDocuments(c)
    if (!documents) return unavailable(c)
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
  buildHonoRoute(app, linkDocumentContract, async (c) => {
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
