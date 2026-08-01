import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  apiContractDocumentSchema,
  createFoundationalServiceSchema,
  foundationalServiceSchema,
  foundationalServiceSourceSchema,
  foundationalServiceSourceStatusSchema,
  foundationalServiceSyncResultSchema,
  linkFoundationalServiceSourceSchema,
  resolvedFoundationalServiceSchema,
  updateFoundationalServiceSchema,
} from '../foundational-services.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Foundational-services route contracts. See FoundationalServiceController in
// @cat-factory/server. Like the prompt-fragment library, the controller is mounted
// TWICE — under `/accounts/:accountId` and `/workspaces/:workspaceId` — from one
// factory, so these literals are RELATIVE to whichever prefix it is mounted under
// and the owner id is read by the handler, not declared as a contract param.
//
// Service ids are lower-kebab slugs (never slash-bearing), so a plain `:serviceId`
// (Hono's default `[^/]+`) matches them.
// ---------------------------------------------------------------------------

const foundationalServiceListSchema = v.array(foundationalServiceSchema)
const resolvedFoundationalServiceListSchema = v.array(resolvedFoundationalServiceSchema)
const contractDocumentListSchema = v.array(apiContractDocumentSchema)
const sourceListSchema = v.array(foundationalServiceSourceSchema)
const serviceIdParams = singleStringParam('serviceId')
const sourceIdParams = singleStringParam('id')

// ---- services (this tier, raw — not merged) -------------------------------

export const listFoundationalServicesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/foundational-services',
  responsesByStatusCode: { 200: foundationalServiceListSchema, ...errorResponses },
})

export const createFoundationalServiceContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/foundational-services',
  requestBodySchema: createFoundationalServiceSchema,
  responsesByStatusCode: { 201: foundationalServiceSchema, ...errorResponses },
})

export const updateFoundationalServiceContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/foundational-services/${serviceId}`,
  requestBodySchema: updateFoundationalServiceSchema,
  responsesByStatusCode: { 200: foundationalServiceSchema, ...errorResponses },
})

export const deleteFoundationalServiceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/foundational-services/${serviceId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * The LAZY contract read: the full documents for one service. Deliberately its own
 * endpoint rather than a field on the list — the whole point of the catalog is that a
 * design-time reader pays for identity + operation names, and only a consumer that has
 * settled on a service pays for its documents.
 */
export const getFoundationalServiceContractsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/foundational-services/${serviceId}/contracts`,
  responsesByStatusCode: { 200: contractDocumentListSchema, ...errorResponses },
})

/**
 * The MERGED catalog an agent actually sees (account ⊕ workspace, workspace winning).
 * Workspace-mount only — an account has no other tier to merge with.
 */
export const resolvedFoundationalServicesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/foundational-services/resolved',
  responsesByStatusCode: { 200: resolvedFoundationalServiceListSchema, ...errorResponses },
})

// ---- repo sources ---------------------------------------------------------

export const listFoundationalServiceSourcesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/foundational-service-sources',
  responsesByStatusCode: { 200: sourceListSchema, ...errorResponses },
})

export const linkFoundationalServiceSourceContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/foundational-service-sources',
  requestBodySchema: linkFoundationalServiceSourceSchema,
  responsesByStatusCode: { 201: foundationalServiceSourceSchema, ...errorResponses },
})

export const unlinkFoundationalServiceSourceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/foundational-service-sources/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const foundationalServiceSourceStatusContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/foundational-service-sources/${id}/status`,
  responsesByStatusCode: { 200: foundationalServiceSourceStatusSchema, ...errorResponses },
})

export const syncFoundationalServiceSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/foundational-service-sources/${id}/sync`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: foundationalServiceSyncResultSchema, ...errorResponses },
})
