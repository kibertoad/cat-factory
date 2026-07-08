import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { serviceTestSecretsViewSchema, upsertServiceTestSecretsSchema } from '../test-secrets.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Sensitive per-service test-secret route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// The blockId is a SERVICE FRAME block. Values are write-only (never read back);
// the view returns only the configured keys + descriptions. See TestSecretsController.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

export const getServiceTestSecretsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/test-secrets`,
  responsesByStatusCode: { 200: serviceTestSecretsViewSchema, ...errorResponses },
})

export const setServiceTestSecretsContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/test-secrets`,
  requestBodySchema: upsertServiceTestSecretsSchema,
  responsesByStatusCode: { 200: serviceTestSecretsViewSchema, ...errorResponses },
})

export const deleteServiceTestSecretsContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/test-secrets`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
