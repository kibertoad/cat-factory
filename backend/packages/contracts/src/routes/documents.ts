import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  connectDocumentSourceSchema,
  documentBoardPlanSchema,
  documentConnectionSchema,
  documentSearchResultSchema,
  documentSourceDescriptorSchema,
  documentSourceKindSchema,
  importDocumentSchema,
  linkDocumentForKindSchema,
  linkDocumentSchema,
  planDocumentSchema,
  refreshDocumentSchema,
  refreshedDocumentViewSchema,
  resolveDocumentRefSchema,
  resolvedDocumentRefSchema,
  searchDocumentsSchema,
  sourceDocumentSchema,
  spawnDocumentSchema,
  unlinkDocumentForKindSchema,
} from '../documents.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Document-source route contracts: source discovery, connection management,
// page import, document listing, structure planning/spawning, and linking a
// page to a block as agent context. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See DocumentSourceController.
// ---------------------------------------------------------------------------

const sourceParams = singleStringParam('source')

// Response wrappers that exist only inline in the controller today.
const documentSourcesViewSchema = v.object({
  sources: v.array(documentSourceDescriptorSchema),
  /**
   * The sources whose OAuth connect this DEPLOYMENT can actually run right now: a source
   * declaring an `oauth` descriptor half AND holding a registered client in the account's
   * deployment settings.
   *
   * Separate from the descriptor because it answers a different question, and the two disagree
   * in the ordinary case: Figma declares the half in code, and a deployment that has registered
   * no Figma app still connects by personal access token. Folding availability onto the
   * descriptor would render a "Connect with Figma" button that can only 503.
   */
  oauthSources: v.array(documentSourceKindSchema),
})
const documentOAuthUrlViewSchema = v.object({
  /** The vendor authorization URL to send the operator's browser to. */
  url: v.string(),
})
const documentConnectionsViewSchema = v.object({
  connections: v.array(documentConnectionSchema),
})
const documentListSchema = v.array(sourceDocumentSchema)
const documentSearchResultsViewSchema = v.object({
  results: v.array(documentSearchResultSchema),
})
const spawnDocumentResultSchema = v.object({
  plan: documentBoardPlanSchema,
  result: v.object({
    frames: v.number(),
    modules: v.number(),
    tasks: v.number(),
    // Planned modules whose tasks went into a module the target frame already had. Its own count
    // rather than part of `modules`, so a spawn that reused every one of them cannot report
    // "0 modules" against a preview that showed three.
    reusedModules: v.number(),
  }),
})

export const listDocumentSourcesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/document-sources',
  responsesByStatusCode: { 200: documentSourcesViewSchema, ...errorResponses },
})

export const listDocumentConnectionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/document-sources/connections',
  responsesByStatusCode: { 200: documentConnectionsViewSchema, ...errorResponses },
})

export const connectDocumentSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/connect`,
  requestBodySchema: connectDocumentSourceSchema,
  responsesByStatusCode: { 201: documentConnectionSchema, ...errorResponses },
})

// Begin an `authorization_code` connect: returns the vendor authorization URL to send the
// operator to. GET because it writes nothing durable — the in-flight request is signed into the
// `state` parameter the vendor hands back, so an abandoned consent screen leaves no row behind.
// Admin-tier for the same reason `connect` is: completing it stores a workspace credential.
export const documentSourceOAuthUrlContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/oauth/install-url`,
  responsesByStatusCode: { 200: documentOAuthUrlViewSchema, ...errorResponses },
})

export const disconnectDocumentSourceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/connection`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listDocumentsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/documents',
  responsesByStatusCode: { 200: documentListSchema, ...errorResponses },
})

export const importDocumentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/import`,
  requestBodySchema: importDocumentSchema,
  responsesByStatusCode: { 201: sourceDocumentSchema, ...errorResponses },
})

// Canonicalise a pasted URL/id WITHOUT importing it: the pre-flight an attach surface runs so a
// link the source cannot read is corrected before a task is saved, rather than surfacing as a
// failed import afterwards. POST because a ref carries slashes and query strings; pure, so it
// spends no upstream call and needs no connection.
export const resolveDocumentRefContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/resolve-ref`,
  requestBodySchema: resolveDocumentRefSchema,
  responsesByStatusCode: { 200: resolvedDocumentRefSchema, ...errorResponses },
})

// Re-confirm one stored document against its source NOW, and pull the new body if the page moved:
// the human dual of the refresh every dispatch runs. POST rather than GET because it writes (a
// moved page is re-imported) and because an `externalId` carries slashes.
//
// Deliberately per-document rather than a workspace-wide sweep: confirming costs a round trip to
// the source per page, so a "refresh everything" button on a board with fifty imported pages is a
// rate limit waiting to happen. The same reason listing documents does not probe.
export const refreshDocumentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/documents/refresh',
  requestBodySchema: refreshDocumentSchema,
  responsesByStatusCode: { 200: refreshedDocumentViewSchema, ...errorResponses },
})

export const searchDocumentsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/search`,
  requestBodySchema: searchDocumentsSchema,
  responsesByStatusCode: { 200: documentSearchResultsViewSchema, ...errorResponses },
})

export const planDocumentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/plan`,
  requestBodySchema: planDocumentSchema,
  responsesByStatusCode: { 200: documentBoardPlanSchema, ...errorResponses },
})

export const spawnDocumentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/document-sources/${source}/spawn`,
  requestBodySchema: spawnDocumentSchema,
  responsesByStatusCode: { 201: spawnDocumentResultSchema, ...errorResponses },
})

export const linkDocumentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/documents/link',
  requestBodySchema: linkDocumentSchema,
  responsesByStatusCode: { 201: sourceDocumentSchema, ...errorResponses },
})

// ---- Workspace+DocKind template / exemplar links (WS1 items 2–4) ----------
// Role-tagged links scoped to a workspace + document kind (not a block), reusing the same
// projected-document read path. A `template` link overrides the built-in skeleton for the kind;
// `exemplar` links are the good-example set the author agents are pointed at.

export const listDocumentRoleLinksContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/document-role-links',
  responsesByStatusCode: { 200: documentListSchema, ...errorResponses },
})

export const linkDocumentForKindContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/document-role-links',
  requestBodySchema: linkDocumentForKindSchema,
  responsesByStatusCode: { 201: sourceDocumentSchema, ...errorResponses },
})

// externalId can contain slashes (a GitHub `owner/repo:path`), so the target is carried in the
// body rather than the path — a POST-to-remove, mirroring the connect/import POST shapes.
export const unlinkDocumentForKindContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/document-role-links/remove',
  requestBodySchema: unlinkDocumentForKindSchema,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
