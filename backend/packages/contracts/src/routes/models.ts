import { defineApiContract } from '@toad-contracts/valibot'
import { modelCatalogSchema } from '../entities.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Model picker catalog route contracts. The ModelController is mounted at `/`,
// so both paths are absolute and `workspaceId` IS a path param. See
// ModelController in @cat-factory/server.
// ---------------------------------------------------------------------------

const workspaceIdParams = singleStringParam('workspaceId')

// Deployment-level catalog (no workspace context).
export const listModelsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/models',
  responsesByStatusCode: { 200: modelCatalogSchema, ...errorResponses },
})

// Per-workspace catalog: selectability reflects the workspace's (+ account's + caller's)
// configured keys and subscription tokens, plus the caller's local + OpenRouter models.
export const listWorkspaceModelsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/models`,
  responsesByStatusCode: { 200: modelCatalogSchema, ...errorResponses },
})
