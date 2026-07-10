import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { chooseForkSchema, forkDecisionStepStateSchema } from '../forkDecision.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Implementation-fork decision route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. The
// read returns the run's active fork-decision state (or null when no coder step
// carries one); `choose` records the human's pick and re-runs the Coder with it
// folded in. Chat is added in a later slice. See ForkDecisionController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')

export const getForkDecisionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/fork-decision`,
  responsesByStatusCode: { 200: v.nullable(forkDecisionStepStateSchema), ...errorResponses },
})

export const chooseForkContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/fork-decision/choose`,
  requestBodySchema: chooseForkSchema,
  responsesByStatusCode: { 200: forkDecisionStepStateSchema, ...errorResponses },
})
