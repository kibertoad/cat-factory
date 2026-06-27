import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  openRouterCatalogSchema,
  openRouterRefreshResultSchema,
  upsertOpenRouterCatalogSchema,
} from '../openrouter.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace OpenRouter dynamic-catalog route contracts. The
// OpenRouterCatalogController is mounted at `/`, so the paths are absolute and
// `workspaceId` IS a path param. See OpenRouterCatalogController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const workspaceIdParams = singleStringParam('workspaceId')

export const getOpenRouterCatalogContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/openrouter/catalog`,
  responsesByStatusCode: { 200: openRouterCatalogSchema, ...errorResponses },
})

export const upsertOpenRouterCatalogContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/openrouter/catalog`,
  requestBodySchema: upsertOpenRouterCatalogSchema,
  responsesByStatusCode: { 200: openRouterCatalogSchema, ...errorResponses },
})

export const refreshOpenRouterCatalogContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/openrouter/refresh`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: openRouterRefreshResultSchema, ...errorResponses },
})
