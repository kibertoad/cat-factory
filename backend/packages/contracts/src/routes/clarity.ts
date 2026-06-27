import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  clarityReviewSchema,
  incorporateClaritySchema,
  replyClarityItemSchema,
  resolveClarityExceededSchema,
  updateClarityItemStatusSchema,
} from '../clarity.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Clarity-review (bug-report triage) route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. See
// ClarityReviewController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')
const reviewItemParams = withObjectKeys(v.object({ reviewId: v.string(), itemId: v.string() }))

export const getClarityReviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review`,
  responsesByStatusCode: { 200: v.nullable(clarityReviewSchema), ...errorResponses },
})

export const reviewClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: clarityReviewSchema, ...errorResponses },
})

export const replyClarityItemContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: reviewItemParams,
  pathResolver: ({ reviewId, itemId }) => `/clarity-reviews/${reviewId}/items/${itemId}/reply`,
  requestBodySchema: replyClarityItemSchema,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})

export const updateClarityItemStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: reviewItemParams,
  pathResolver: ({ reviewId, itemId }) => `/clarity-reviews/${reviewId}/items/${itemId}`,
  requestBodySchema: updateClarityItemStatusSchema,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})

export const incorporateClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review/incorporate`,
  requestBodySchema: incorporateClaritySchema,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})

export const reReviewClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})

export const proceedClarityContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})

export const resolveClarityExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/clarity-review/resolve-exceeded`,
  requestBodySchema: resolveClarityExceededSchema,
  responsesByStatusCode: { 200: clarityReviewSchema, ...errorResponses },
})
