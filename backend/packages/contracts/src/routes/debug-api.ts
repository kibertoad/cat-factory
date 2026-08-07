import { defineApiContract } from '@toad-contracts/valibot'
import {
  debugAgentContextDetailSchema,
  debugAgentContextListSchema,
  debugLlmCallListSchema,
  debugLlmCallSchema,
  debugLogListSchema,
  debugRunListSchema,
  debugRunOverviewSchema,
  debugSearchQueryListSchema,
  debugToolCallListSchema,
  getDebugAgentContextQuerySchema,
  getDebugLlmCallQuerySchema,
  listDebugAgentContextQuerySchema,
  listDebugLlmCallsQuerySchema,
  listDebugPageQuerySchema,
  listDebugToolCallsQuerySchema,
  listDebugRunsQuerySchema,
} from '../debug-api.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the REMOTE DEBUGGING surface (`/api/v1/debug/*`) — absolute paths,
// authenticated in-controller by a public-API key (not the SPA session gate), `read` scope.
// The wire shapes and the reasoning behind them live in `../debug-api.ts`.
//
// The surface is a two-level drill-down, and the paths say so: the RUN-scoped lists live
// under `/debug/runs/:runId/*`, while the point reads that carry bodies are addressed by the
// row's OWN id (`/debug/llm-calls/:callId`) rather than nested under the run. Nesting them
// would force a caller that already holds a call id — which is exactly what the list handed
// it — to remember the run it came from, and would let a mismatched pair form a request that
// looks well-typed and returns 404 for a reason the caller cannot see. Each point read
// re-applies the key's workspace scope to the row it loads, so a flat path is no wider.
// ---------------------------------------------------------------------------

const runIdParams = singleStringParam('runId')
const callIdParams = singleStringParam('callId')
const snapshotIdParams = singleStringParam('snapshotId')

/** List the workspace's runs, newest first, keyset-paginated — the entry point for triage. */
export const listDebugRunsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/debug/runs',
    requestQuerySchema: listDebugRunsQuerySchema,
    responsesByStatusCode: { 200: debugRunListSchema, ...errorResponses },
  }),
)

/** The run's diagnostic map: steps, per-sink availability + counts, LLM rollups, signals. */
export const getDebugRunContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}`,
    responsesByStatusCode: { 200: debugRunOverviewSchema, ...errorResponses },
  }),
)

/** The run's recorded model calls, keyset-paginated; bodies only when `bodyChars` asks. */
export const listDebugLlmCallsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}/llm-calls`,
    requestQuerySchema: listDebugLlmCallsQuerySchema,
    responsesByStatusCode: { 200: debugLlmCallListSchema, ...errorResponses },
  }),
)

/** One recorded model call with its full (budgeted) prompt delta, response and reasoning. */
export const getDebugLlmCallContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: callIdParams,
    pathResolver: ({ callId }) => `/api/v1/debug/llm-calls/${callId}`,
    requestQuerySchema: getDebugLlmCallQuerySchema,
    responsesByStatusCode: { 200: debugLlmCallSchema, ...errorResponses },
  }),
)

/** The run's captured agent-context dispatches, sizes only, keyset-paginated. */
export const listDebugAgentContextContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}/agent-context`,
    requestQuerySchema: listDebugAgentContextQuerySchema,
    responsesByStatusCode: { 200: debugAgentContextListSchema, ...errorResponses },
  }),
)

/** One captured dispatch's full (budgeted) prompts, folded fragments and injected files. */
export const getDebugAgentContextContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: snapshotIdParams,
    pathResolver: ({ snapshotId }) => `/api/v1/debug/agent-context/${snapshotId}`,
    requestQuerySchema: getDebugAgentContextQuerySchema,
    responsesByStatusCode: { 200: debugAgentContextDetailSchema, ...errorResponses },
  }),
)

/** The web searches the run's agents performed, keyset-paginated. */
export const listDebugSearchQueriesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}/search-queries`,
    requestQuerySchema: listDebugPageQuerySchema,
    responsesByStatusCode: { 200: debugSearchQueryListSchema, ...errorResponses },
  }),
)

/** The tool calls the run's agents made, in trajectory order, keyset-paginated. */
export const listDebugToolCallsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}/tool-calls`,
    requestQuerySchema: listDebugToolCallsQuerySchema,
    responsesByStatusCode: { 200: debugToolCallListSchema, ...errorResponses },
  }),
)

/** The run's provisioning event log — how its infrastructure came up, or why it didn't. */
export const listDebugLogsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/debug/runs/${runId}/logs`,
    requestQuerySchema: listDebugPageQuerySchema,
    responsesByStatusCode: { 200: debugLogListSchema, ...errorResponses },
  }),
)
