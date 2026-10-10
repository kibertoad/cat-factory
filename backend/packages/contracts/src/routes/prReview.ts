import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  challengePrReviewFindingSchema,
  prReviewStepStateSchema,
  resolvePrReviewSchema,
  resumePrReviewSchema,
} from '../prReview.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// PR deep-review route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. The read returns the run's active PR-review
// state (or null when no `pr-reviewer` step carries one); `resolve` records the human's
// curated finding selection and completes the read-only review. The per-finding
// `dismiss` / `challenge` endpoints let a human drop a finding entirely, or dispatch the
// Challenge Investigator to re-examine it (strengthen or retract). See PrReviewController
// in @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')
const findingParams = withObjectKeys(v.object({ executionId: v.string(), findingId: v.string() }))

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

/**
 * Re-trigger a review stuck mid-`reviewing`, re-reviewing ONLY the slices that never reported.
 * Takes no body: what to redo is derived from the step's own `sliceReviews` + task list, never
 * from the caller. 409 when the review is not `reviewing` (a parked or resolved review has its
 * own actions, and re-dispatching one would destroy findings a human may be mid-selection on).
 */
export const resumePrReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/pr-review/resume`,
  requestBodySchema: resumePrReviewSchema,
  responsesByStatusCode: { 200: prReviewStepStateSchema, ...errorResponses },
})

/** Dismiss a parked finding entirely (removes it + prunes it from the selection). */
export const dismissPrReviewFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: findingParams,
  pathResolver: ({ executionId, findingId }) =>
    `/executions/${executionId}/pr-review/findings/${findingId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: prReviewStepStateSchema, ...errorResponses },
})

/** Challenge a parked finding — dispatch the Challenge Investigator to re-examine it. */
export const challengePrReviewFindingContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: findingParams,
  pathResolver: ({ executionId, findingId }) =>
    `/executions/${executionId}/pr-review/findings/${findingId}/challenge`,
  requestBodySchema: challengePrReviewFindingSchema,
  responsesByStatusCode: { 200: prReviewStepStateSchema, ...errorResponses },
})
