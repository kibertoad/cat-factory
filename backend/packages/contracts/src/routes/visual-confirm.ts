import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { executionInstanceSchema } from '../execution.js'
import { requestVisualConfirmFixSchema } from '../visual-confirm.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Visual-confirmation gate route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. Each route drives the block's parked
// `visual-confirmation` step and returns the updated execution instance. See
// VisualConfirmationController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = withObjectKeys(v.object({ blockId: v.string() }))

export const approveVisualConfirmContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/visual-confirmation/approve`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const requestVisualConfirmFixContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/visual-confirmation/request-fix`,
  requestBodySchema: requestVisualConfirmFixSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const recaptureVisualConfirmContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/visual-confirmation/recapture`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})
