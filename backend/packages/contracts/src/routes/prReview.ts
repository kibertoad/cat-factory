import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { prReviewStepStateSchema, resolvePrReviewSchema } from '../prReview.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// PR deep-review route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. The read returns the run's active PR-review
// state (or null when no `pr-reviewer` step carries one); `resolve` records the human's
// curated finding selection and completes the read-only review. See PrReviewController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')

export const getPrReviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/pr-review`,
  responsesByStatusCode: { 200: v.nullable(prReviewStepStateSchema), ...errorResponses },
})

export const resolvePrReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/pr-review/resolve`,
  requestBodySchema: resolvePrReviewSchema,
  responsesByStatusCode: { 200: prReviewStepStateSchema, ...errorResponses },
})
