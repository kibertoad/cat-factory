import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  brainstormSessionSchema,
  brainstormStageSchema,
  incorporateBrainstormSchema,
  replyBrainstormItemSchema,
  resolveBrainstormExceededSchema,
  updateBrainstormItemStatusSchema,
} from '../brainstorm.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Brainstorm (structured-dialogue) route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. The
// `:stage` param is typed by `brainstormStageSchema`, so the contract validator
// rejects an unknown stage with the shared 400 envelope (the controller no longer
// hand-parses it). See BrainstormController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockStageParams = withObjectKeys(
  v.object({ blockId: v.string(), stage: brainstormStageSchema }),
)
const sessionItemParams = withObjectKeys(v.object({ sessionId: v.string(), itemId: v.string() }))

export const getBrainstormContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}`,
  responsesByStatusCode: { 200: v.nullable(brainstormSessionSchema), ...errorResponses },
})

export const reviewBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: brainstormSessionSchema, ...errorResponses },
})

export const replyBrainstormItemContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sessionItemParams,
  pathResolver: ({ sessionId, itemId }) =>
    `/brainstorm-sessions/${sessionId}/items/${itemId}/reply`,
  requestBodySchema: replyBrainstormItemSchema,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})

export const updateBrainstormItemStatusContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: sessionItemParams,
  pathResolver: ({ sessionId, itemId }) => `/brainstorm-sessions/${sessionId}/items/${itemId}`,
  requestBodySchema: updateBrainstormItemStatusSchema,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})

export const incorporateBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}/incorporate`,
  requestBodySchema: incorporateBrainstormSchema,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})

export const reReviewBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}/re-review`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})

export const proceedBrainstormContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})

export const resolveBrainstormExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockStageParams,
  pathResolver: ({ blockId, stage }) => `/blocks/${blockId}/brainstorm/${stage}/resolve-exceeded`,
  requestBodySchema: resolveBrainstormExceededSchema,
  responsesByStatusCode: { 200: brainstormSessionSchema, ...errorResponses },
})
