import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  detectedValidationChecksSchema,
  serviceValidationConfigSchema,
  upsertServiceValidationConfigSchema,
} from '../validation-checks.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Pre-PR validation-check route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. The blockId is a SERVICE FRAME
// block (the checks are resolved up the frame chain at dispatch). See
// ValidationConfigController.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

export const getServiceValidationConfigContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/validation-checks`,
  responsesByStatusCode: { 200: serviceValidationConfigSchema, ...errorResponses },
})

export const setServiceValidationConfigContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/validation-checks`,
  requestBodySchema: upsertServiceValidationConfigSchema,
  responsesByStatusCode: { 200: serviceValidationConfigSchema, ...errorResponses },
})

export const deleteServiceValidationConfigContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/validation-checks`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Suggest checks for a service frame by reading its repo's root manifests (the inspector's
 * "Detect" button). A pure READ — it inspects the repo's default branch and returns
 * suggestions; the operator still saves them through the `put` above. GET, so it stays
 * available to a reader of the panel and cannot be mistaken for a write.
 */
export const detectServiceValidationChecksContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/validation-checks/detect`,
  responsesByStatusCode: { 200: detectedValidationChecksSchema, ...errorResponses },
})

/** Every configured service's validation checks in the workspace (the store's hydrate read). */
export const listServiceValidationConfigsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/validation-checks',
  responsesByStatusCode: {
    200: v.array(serviceValidationConfigSchema),
    ...errorResponses,
  },
})
