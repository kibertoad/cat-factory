import { defineApiContract } from '@toad-contracts/valibot'
import { configuredProvidersResultSchema } from '../api-keys.js'
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

// The direct providers the caller's runs in this workspace can reach, from the same resolution the
// catalog and the run-start guard use. Readable by any workspace reader, viewers included, like the
// catalog: it names providers only, never a key.
export const listConfiguredProvidersContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: workspaceIdParams,
  pathResolver: ({ workspaceId }) => `/workspaces/${workspaceId}/configured-providers`,
  responsesByStatusCode: { 200: configuredProvidersResultSchema, ...errorResponses },
})
