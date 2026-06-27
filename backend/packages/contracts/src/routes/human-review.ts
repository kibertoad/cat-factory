import { defineApiContract } from '@toad-contracts/valibot'
import { executionInstanceSchema } from '../entities.js'
import { requestHumanReviewFixSchema } from '../human-review.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Human-review gate route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. The single route drives the
// block's parked `human-review` step and returns the updated execution instance.
// See HumanReviewController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

export const requestHumanReviewFixContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-review/request-fix`,
  requestBodySchema: requestHumanReviewFixSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})
