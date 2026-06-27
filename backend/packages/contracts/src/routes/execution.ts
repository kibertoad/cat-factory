import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema, executionInstanceSchema, spendStatusSchema } from '../entities.js'
import { resolveIterationCapSchema } from '../iteration-cap.js'
import {
  agentContextSnapshotSchema,
  llmMetricsExportSchema,
  llmMetricsResponseSchema,
} from '../observability.js'
import {
  approveStepSchema,
  rejectStepSchema,
  requestStepChangesSchema,
  resolveDecisionSchema,
  restartFromStepSchema,
  startExecutionSchema,
} from '../requests.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Execution-engine route contracts. Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. See ExecutionController.
// ---------------------------------------------------------------------------

const executionInstanceListSchema = v.array(executionInstanceSchema)

const blockIdParams = singleStringParam('blockId')
const executionIdParams = singleStringParam('executionId')
const decisionParams = withObjectKeys(v.object({ executionId: v.string(), decisionId: v.string() }))
const approvalParams = withObjectKeys(v.object({ executionId: v.string(), approvalId: v.string() }))

// The agent-context observability response — `{ executionId, snapshots }`. The
// snapshot schema (`agentContextSnapshotSchema`, imported from `../observability.js`)
// is the shared source of truth the kernel `AgentContextSnapshot` port also derives from.
const agentContextResponseSchema = v.object({
  executionId: v.string(),
  snapshots: v.array(agentContextSnapshotSchema),
})

// ---- run lifecycle --------------------------------------------------------

export const startExecutionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/executions`,
  requestBodySchema: startExecutionSchema,
  responsesByStatusCode: { 201: executionInstanceSchema, ...errorResponses },
})

export const cancelExecutionContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/executions`,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

export const mergeBlockContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/merge`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

// ---- spend safeguard ------------------------------------------------------

export const getSpendStatusContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/spend',
  responsesByStatusCode: { 200: spendStatusSchema, ...errorResponses },
})

export const resumeSpendContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/spend/resume',
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceListSchema, ...errorResponses },
})

// ---- run observability ----------------------------------------------------

export const getExecutionLlmMetricsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/llm-metrics`,
  responsesByStatusCode: { 200: llmMetricsResponseSchema, ...errorResponses },
})

export const getExecutionAgentContextContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/agent-context`,
  responsesByStatusCode: { 200: agentContextResponseSchema, ...errorResponses },
})

export const exportExecutionLlmMetricsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/llm-metrics/export`,
  responsesByStatusCode: { 200: llmMetricsExportSchema, ...errorResponses },
})

// ---- decisions / approvals ------------------------------------------------

export const resolveDecisionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: decisionParams,
  pathResolver: ({ executionId, decisionId }) =>
    `/executions/${executionId}/decisions/${decisionId}`,
  requestBodySchema: resolveDecisionSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const approveStepContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: approvalParams,
  pathResolver: ({ executionId, approvalId }) =>
    `/executions/${executionId}/steps/${approvalId}/approve`,
  requestBodySchema: approveStepSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const requestStepChangesContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: approvalParams,
  pathResolver: ({ executionId, approvalId }) =>
    `/executions/${executionId}/steps/${approvalId}/request-changes`,
  requestBodySchema: requestStepChangesSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const resolveStepExceededContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: approvalParams,
  pathResolver: ({ executionId, approvalId }) =>
    `/executions/${executionId}/steps/${approvalId}/resolve-exceeded`,
  requestBodySchema: resolveIterationCapSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const restartExecutionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/restart`,
  requestBodySchema: restartFromStepSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const rejectStepContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: approvalParams,
  pathResolver: ({ executionId, approvalId }) =>
    `/executions/${executionId}/steps/${approvalId}/reject`,
  requestBodySchema: rejectStepSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})
