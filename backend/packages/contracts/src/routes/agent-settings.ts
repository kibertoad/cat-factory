import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  updateWorkspaceAgentSettingsSchema,
  workspaceAgentSettingsSchema,
} from '../agent-settings.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace, per-agent-kind generation-settings route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix. See
// WorkspaceAgentSettingsController in @cat-factory/server.
// ---------------------------------------------------------------------------

const agentKindParams = singleStringParam('agentKind')

/**
 * The workspace's configured kinds — one row each, and nothing for a kind that inherits the
 * deployment default. The pipeline builder loads this alongside the prompt-override index to
 * badge which steps deviate, so it is deliberately the whole (small) set in one request rather
 * than a read per step.
 */
export const listWorkspaceAgentSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/agent-settings',
  responsesByStatusCode: { 200: v.array(workspaceAgentSettingsSchema), ...errorResponses },
})

/**
 * Set or clear one kind's settings. The body is a PATCH: an omitted field keeps its stored
 * value, an explicit `null` clears it back to the deployment default.
 *
 * Returns `null` — not a row with null fields — once nothing is left configured, because the
 * service DELETES the row at that point: "inheriting" is expressed by absence, so a stored row
 * whose every value is null would be a second way to say the same thing.
 */
export const updateWorkspaceAgentSettingsContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: agentKindParams,
  pathResolver: ({ agentKind }) => `/agent-settings/${agentKind}`,
  requestBodySchema: updateWorkspaceAgentSettingsSchema,
  responsesByStatusCode: {
    200: v.nullable(workspaceAgentSettingsSchema),
    ...errorResponses,
  },
})
