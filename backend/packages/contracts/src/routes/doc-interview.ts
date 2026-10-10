import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { answerDocInterviewSchema, docInterviewSessionSchema } from '../doc-interview.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Interactive document-interview route contracts (WS5). Mounted under
// `/workspaces/:workspaceId`, so paths are relative to that prefix. See
// DocInterviewController in @cat-factory/server. All return the updated session
// so the SPA patches its cache (the live `docInterview` event carries the same
// entity, so no separate refetch is needed).
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

/** Fetch the interactive-interview session anchored to a board block (window load path). */
export const getDocInterviewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/doc-interview`,
  responsesByStatusCode: { 200: v.nullable(docInterviewSessionSchema), ...errorResponses },
})

/** Record the human's answer to one pending interview question (no run resume). */
export const answerDocInterviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/doc-interview/answer`,
  requestBodySchema: answerDocInterviewSchema,
  responsesByStatusCode: { 200: docInterviewSessionSchema, ...errorResponses },
})

/** Submit the answered questions and resume the interview (the interviewer re-runs). */
export const continueDocInterviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/doc-interview/continue`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: docInterviewSessionSchema, ...errorResponses },
})

/** Skip any remaining questions: synthesize the brief from what's answered and advance. */
export const proceedDocInterviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/doc-interview/proceed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: docInterviewSessionSchema, ...errorResponses },
})
