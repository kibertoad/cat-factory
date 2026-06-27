import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { bootstrapJobSchema } from '../bootstrap.js'
import { agentRunKindSchema, executionInstanceSchema } from '../entities.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Cross-cutting agent-run route contracts (retry / stop over a bootstrap or
// execution run). Mounted under `/workspaces/:workspaceId`, so the paths here are
// relative to that prefix. See AgentRunController in @cat-factory/server.
// ---------------------------------------------------------------------------

// The `{ kind, run }` envelope both endpoints return: the run's kind plus the run
// itself, which is a bootstrap job or an execution instance depending on the kind.
// This shape exists only inline in the controller today.
const agentRunResultSchema = v.object({
  kind: agentRunKindSchema,
  run: v.union([bootstrapJobSchema, executionInstanceSchema]),
})

const agentRunIdParams = withObjectKeys(v.object({ id: v.string() }))

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
