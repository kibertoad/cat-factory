import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
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

/** Every configured service's validation checks in the workspace (the store's hydrate read). */
export const listServiceValidationConfigsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/validation-checks',
  responsesByStatusCode: {
    200: v.array(serviceValidationConfigSchema),
    ...errorResponses,
  },
})
