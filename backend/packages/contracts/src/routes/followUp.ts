import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { answerFollowUpSchema, followUpsStepStateSchema } from '../followUp.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Follow-up companion route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. Each returns the run's live
// follow-up state; the read route returns null when the companion is off or
// nothing surfaced. See FollowUpController in @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = withObjectKeys(v.object({ executionId: v.string() }))
const executionItemParams = withObjectKeys(
  v.object({ executionId: v.string(), itemId: v.string() }),
)

export const getFollowUpsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/follow-ups`,
  responsesByStatusCode: { 200: v.nullable(followUpsStepStateSchema), ...errorResponses },
})

export const fileFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionItemParams,
  pathResolver: ({ executionId, itemId }) => `/executions/${executionId}/follow-ups/${itemId}/file`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: followUpsStepStateSchema, ...errorResponses },
})

export const queueFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionItemParams,
  pathResolver: ({ executionId, itemId }) =>
    `/executions/${executionId}/follow-ups/${itemId}/queue`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: followUpsStepStateSchema, ...errorResponses },
})

export const answerFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionItemParams,
  pathResolver: ({ executionId, itemId }) =>
    `/executions/${executionId}/follow-ups/${itemId}/answer`,
  requestBodySchema: answerFollowUpSchema,
  responsesByStatusCode: { 200: followUpsStepStateSchema, ...errorResponses },
})

export const dismissFollowUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionItemParams,
  pathResolver: ({ executionId, itemId }) =>
    `/executions/${executionId}/follow-ups/${itemId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: followUpsStepStateSchema, ...errorResponses },
})
