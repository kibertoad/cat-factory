import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  connectDocumentSourceSchema,
  documentBoardPlanSchema,
  documentConnectionSchema,
  documentSearchResultSchema,
  documentSourceDescriptorSchema,
  importDocumentSchema,
  linkDocumentForKindSchema,
  linkDocumentSchema,
  planDocumentSchema,
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
  result: v.object({ frames: v.number(), modules: v.number(), tasks: v.number() }),
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
