import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { judgeStepStateSchema, resolveJudgeSchema } from '../judge.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Judge route contracts (the fourth step-taxonomy bucket). Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. The read
// returns the run's active judge state (or null when no step carries one); `resolve`
// answers a parked verdict — proceed anyway, bounce the work back for rework, or stop
// the run. The SAME service method backs the public API's decisions surface, so a
// headless caller drives an identical loop. See JudgeController in @cat-factory/server
// and `docs/initiatives/judge-registry.md`.
// ---------------------------------------------------------------------------

const executionIdParams = singleStringParam('executionId')

export const getJudgeDecisionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/judge`,
  responsesByStatusCode: { 200: v.nullable(judgeStepStateSchema), ...errorResponses },
})

export const resolveJudgeContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/judge/resolve`,
  requestBodySchema: resolveJudgeSchema,
  responsesByStatusCode: { 200: judgeStepStateSchema, ...errorResponses },
})
