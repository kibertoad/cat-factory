import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema, spendStatusSchema, usageReportSchema } from '../entities.js'
import { executionInstanceSchema } from '../execution.js'
import { mergeBlockSchema } from '../mergeTrackRecord.js'
import { resolveIterationCapSchema } from '../iteration-cap.js'
import {
  agentContextSnapshotSchema,
  agentSearchQuerySchema,
  agentToolCallSchema,
  llmMetricsExportSchema,
  llmMetricsResponseSchema,
} from '../observability.js'
import {
  approveStepSchema,
  rejectStepSchema,
  requestStepChangesSchema,
  resolveDecisionSchema,
  restartFromStepSchema,
  startAgentKindExecutionSchema,
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

// The agent-search-query observability response — `{ executionId, searchQueries }`.
// The query schema (`agentSearchQuerySchema`) is the shared source of truth the kernel
// `AgentSearchQuery` port also derives from.
const searchQueriesResponseSchema = v.object({
  executionId: v.string(),
  searchQueries: v.array(agentSearchQuerySchema),
})

// The tool-call trajectory response: oldest first, in the order the run's agents actually made
// the calls, bounded server-side like every other read here.
//
// `truncated` is not decoration. The bound takes the OLDEST end, so a long run's rows are a
// PREFIX — its opening moves, not its trouble — and a reader that cannot tell a prefix from a
// whole run concludes "these are the calls this run made" from its first two hundred. This is
// the same rule the LLM export follows for the same reason (`buildLlmMetricsExport`'s
// `truncated`), and the reason the failure read below is a SEPARATE request rather than
// something derived from these rows.
const toolCallsResponseSchema = v.object({
  executionId: v.string(),
  toolCalls: v.array(agentToolCallSchema),
  /** True when the run made more calls than `toolCalls` holds: it is a prefix, not the run. */
  truncated: v.boolean(),
})

// What the panel PINS: the run's failing tool calls and the exact counts behind them.
//
// Deliberately not folded into the trajectory response, for two reasons that both come down to
// the prefix above. It must be EXACT: `failed` is a SQL aggregate over the whole run, so the
// headline never disagrees with the debug overview's `sinks.toolCalls.failed` on a long run.
// And it must be CHEAP: the trajectory carries every argument and result the run captured, so
// binding the panel's first answer to that payload would make the one number an operator opens
// the panel for wait on megabytes it may never scroll.
const toolCallFailuresResponseSchema = v.object({
  executionId: v.string(),
  /** Every tool call the run made, counted in SQL — not the length of any list here. */
  total: v.number(),
  /** How many of them reported failure, from the SAME aggregate pass, so it can never exceed. */
  failed: v.number(),
  /** The failing calls themselves, in trajectory order, narrowed in SQL and bounded. */
  failures: v.array(agentToolCallSchema),
  /** True when `failed` exceeds what `failures` holds. `failed` stays the honest number. */
  failuresTruncated: v.boolean(),
})

/**
 * The two reads' payloads, named so the engine service that BUILDS them and the SPA that renders
 * them are typed against one declaration. A service returning a structurally-similar object of
 * its own is how a `truncated` flag ends up computed in one place and forgotten in the other.
 */
export type RunToolCallTrajectory = Omit<
  v.InferOutput<typeof toolCallsResponseSchema>,
  'executionId'
>
export type RunToolCallFailures = Omit<
  v.InferOutput<typeof toolCallFailuresResponseSchema>,
  'executionId'
>

// ---- run lifecycle --------------------------------------------------------

export const startExecutionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/executions`,
  requestBodySchema: startExecutionSchema,
  responsesByStatusCode: { 201: executionInstanceSchema, ...errorResponses },
})

/**
 * The single-kind run door. A path of its own rather than a variant body on
 * `startExecutionContract`, matching the split in the request schemas: what is being started is a
 * different KIND of thing, and the response is the same ordinary run either way.
 */
export const startAgentKindExecutionContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/agent-kind-executions`,
  requestBodySchema: startAgentKindExecutionSchema,
  responsesByStatusCode: { 201: executionInstanceSchema, ...errorResponses },
})

/**
 * One run, WHOLE: the read that stands behind the board snapshot's lean projection
 * (`projectExecutionForBoard`). The snapshot withholds each step's captured prose, so the reader
 * that actually renders it (any step-detail overlay) fetches the run it is about through here.
 *
 * A point-read by id rather than a "give me the heavy half" delta: the run is one row either way,
 * and a delta would need the client's revision to be meaningful, which is exactly the coherence
 * problem the store's monotonic `rev` already answers.
 */
export const getExecutionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}`,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
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
  // All-optional body: `{}` is the historical no-body merge. The inspector's merge control carries
  // the reviewer-effort tag here so confirming the merge and tagging it is ONE request, exactly
  // like the notification card's `act`.
  requestBodySchema: mergeBlockSchema,
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

// The usage report (Usage settings tab): token usage this period broken down by billing
// kind / vendor / model — both metered API calls and flat-rate subscription harness usage.
export const getWorkspaceUsageContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/usage',
  responsesByStatusCode: { 200: usageReportSchema, ...errorResponses },
})

// ---- run observability ----------------------------------------------------
//
// `executionId` on THESE six is the AGENT RUN id, not necessarily an execution's: the four
// telemetry sinks are keyed by the run, and a repo-bootstrap run has no execution row at all
// (its run id is its own). The board opens the same observability panel over a bootstrap, so
// these must stay resolvable from the telemetry stores alone: resolving an execution first
// would 404 every bootstrap while its rows sat in the store under exactly the id asked for.
// Pinned by the bootstrap conformance group, which drives a real bootstrap and reads all five.

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

export const getExecutionSearchQueriesContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/search-queries`,
  responsesByStatusCode: { 200: searchQueriesResponseSchema, ...errorResponses },
})

export const getExecutionToolCallsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/tool-calls`,
  responsesByStatusCode: { 200: toolCallsResponseSchema, ...errorResponses },
})

export const getExecutionToolCallFailuresContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/tool-call-failures`,
  responsesByStatusCode: { 200: toolCallFailuresResponseSchema, ...errorResponses },
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
