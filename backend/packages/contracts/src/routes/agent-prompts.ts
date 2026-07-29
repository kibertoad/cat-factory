import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  agentPromptDetailSchema,
  agentPromptSummarySchema,
  saveAgentPromptSchema,
} from '../agent-prompts.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace agent system-prompt override route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. See
// AgentPromptController in @cat-factory/server.
// ---------------------------------------------------------------------------

const agentKindParams = singleStringParam('agentKind')

/**
 * The workspace's override INDEX — one row per kind that has any revision, with no prompt
 * bodies. The pipeline builder badges its steps from this, so it must stay cheap enough to
 * load with the builder itself; a body is fetched only when the editor actually opens.
 */
export const listAgentPromptsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/agent-prompts',
  responsesByStatusCode: { 200: v.array(agentPromptSummarySchema), ...errorResponses },
})

/**
 * One kind's full editor state: the shipped built-in text, the effective text, and the whole
 * revision log to restore from. Answers for ANY known agent kind — a kind with no revisions
 * yet returns the built-in with an empty log rather than a 404, since that is the state the
 * editor opens in for every untouched step.
 */
export const getAgentPromptContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: agentKindParams,
  pathResolver: ({ agentKind }) => `/agent-prompts/${agentKind}`,
  responsesByStatusCode: { 200: agentPromptDetailSchema, ...errorResponses },
})

/**
 * Append a revision — a new override text, or `text: null` to go back to the shipped built-in.
 * Returns the refreshed detail so the editor re-renders from the server's view of the log
 * rather than a locally-guessed one. 409s when a concurrent editor already took the next
 * revision number.
 */
export const saveAgentPromptContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: agentKindParams,
  pathResolver: ({ agentKind }) => `/agent-prompts/${agentKind}`,
  requestBodySchema: saveAgentPromptSchema,
  responsesByStatusCode: { 200: agentPromptDetailSchema, ...errorResponses },
})
