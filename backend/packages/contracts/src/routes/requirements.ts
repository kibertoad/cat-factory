import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  incorporateRequirementsSchema,
  refinedRequirementsWritebackResultSchema,
  reRequestRecommendationSchema,
  replyReviewItemSchema,
  requestRecommendationsSchema,
  requirementReviewSchema,
  resolveRequirementsExceededSchema,
  updateReviewItemStatusSchema,
} from '../requirements.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Requirements-review route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See RequirementReviewController
// in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')
const reviewItemParams = withObjectKeys(v.object({ reviewId: v.string(), itemId: v.string() }))
const reviewRecParams = withObjectKeys(v.object({ reviewId: v.string(), recId: v.string() }))

export const getRequirementReviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review`,
  responsesByStatusCode: { 200: v.nullable(requirementReviewSchema), ...errorResponses },
})

export const reviewRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: requirementReviewSchema, ...errorResponses },
})

export const replyRequirementItemContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: reviewItemParams,
  pathResolver: ({ reviewId, itemId }) => `/requirement-reviews/${reviewId}/items/${itemId}/reply`,
  requestBodySchema: replyReviewItemSchema,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const updateRequirementItemStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: reviewItemParams,
  pathResolver: ({ reviewId, itemId }) => `/requirement-reviews/${reviewId}/items/${itemId}`,
  requestBodySchema: updateReviewItemStatusSchema,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const incorporateRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/incorporate`,
  requestBodySchema: incorporateRequirementsSchema,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const reReviewRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const proceedRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const requestRequirementRecommendationsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/recommend`,
  requestBodySchema: requestRecommendationsSchema,
  responsesByStatusCode: { 200: v.nullable(requirementReviewSchema), ...errorResponses },
})

export const acceptRequirementRecommendationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: reviewRecParams,
  pathResolver: ({ reviewId, recId }) =>
    `/requirement-reviews/${reviewId}/recommendations/${recId}/accept`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const rejectRequirementRecommendationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: reviewRecParams,
  pathResolver: ({ reviewId, recId }) =>
    `/requirement-reviews/${reviewId}/recommendations/${recId}/reject`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const reRequestRequirementRecommendationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: reviewRecParams,
  pathResolver: ({ reviewId, recId }) =>
    `/requirement-reviews/${reviewId}/recommendations/${recId}/re-request`,
  requestBodySchema: reRequestRecommendationSchema,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

export const resolveRequirementsExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/resolve-exceeded`,
  requestBodySchema: resolveRequirementsExceededSchema,
  responsesByStatusCode: { 200: requirementReviewSchema, ...errorResponses },
})

/**
 * Write the block's refined requirements into the description of each linked tracker issue.
 * Idempotent by content: an issue whose description already holds the document reports
 * `already_current` and is not written.
 */
export const writeRefinedRequirementsContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/requirement-review/update-linked-issues`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: refinedRequirementsWritebackResultSchema, ...errorResponses },
})
