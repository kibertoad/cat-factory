import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { bootstrapJobSchema } from '../bootstrap.js'
import { envConfigRepairJobSchema } from '../env-config-repair.js'
import { agentRunKindSchema, executionInstanceSchema } from '../execution.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Cross-cutting agent-run route contracts (retry / stop over a bootstrap,
// execution, or env-config-repair run). Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. See AgentRunController in @cat-factory/server.
// ---------------------------------------------------------------------------

// The `{ kind, run }` envelope both endpoints return: the run's kind plus the run
// itself, which is a bootstrap job, an execution instance, or an env-config-repair job
// depending on the kind. This shape exists only inline in the controller today.
const agentRunResultSchema = v.object({
  kind: agentRunKindSchema,
  run: v.union([bootstrapJobSchema, executionInstanceSchema, envConfigRepairJobSchema]),
})

const agentRunIdParams = singleStringParam('id')

export const retryAgentRunContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: agentRunIdParams,
  pathResolver: ({ id }) => `/agent-runs/${id}/retry`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: agentRunResultSchema, ...errorResponses },
})

export const stopAgentRunContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: agentRunIdParams,
  pathResolver: ({ id }) => `/agent-runs/${id}/stop`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: agentRunResultSchema, ...errorResponses },
})
