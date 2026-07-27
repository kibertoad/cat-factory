import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  serviceAcceptanceCriterionSchema,
  createAcceptanceCriterionSchema,
  serviceAcceptanceCriteriaSchema,
  updateAcceptanceCriterionSchema,
} from '../acceptance-criteria.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-service ACCEPTANCE-CRITERIA route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. The
// `:blockId` is a SERVICE FRAME block (criteria are resolved up the frame chain at
// dispatch); a criterion is then addressed by its own stable id.
//
// These are MEMBER-tier writes — criteria are product knowledge a member curates, not
// operator configuration — so the controller mounts no admin permission gate and the
// RBAC viewer write floor is the whole authorization story. See
// AcceptanceCriteriaController.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')
const criterionIdParams = singleStringParam('criterionId')

export const getServiceAcceptanceCriteriaContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/acceptance-criteria`,
  responsesByStatusCode: { 200: serviceAcceptanceCriteriaSchema, ...errorResponses },
})

export const createServiceAcceptanceCriterionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/services/${blockId}/acceptance-criteria`,
  requestBodySchema: createAcceptanceCriterionSchema,
  responsesByStatusCode: { 201: serviceAcceptanceCriterionSchema, ...errorResponses },
})

export const updateAcceptanceCriterionContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: criterionIdParams,
  pathResolver: ({ criterionId }) => `/acceptance-criteria/${criterionId}`,
  requestBodySchema: updateAcceptanceCriterionSchema,
  responsesByStatusCode: { 200: serviceAcceptanceCriterionSchema, ...errorResponses },
})

export const deleteAcceptanceCriterionContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: criterionIdParams,
  pathResolver: ({ criterionId }) => `/acceptance-criteria/${criterionId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/** Every service frame's criteria in the workspace (the store's hydrate read). */
export const listServiceAcceptanceCriteriaContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/acceptance-criteria',
  responsesByStatusCode: {
    200: v.array(serviceAcceptanceCriteriaSchema),
    ...errorResponses,
  },
})
