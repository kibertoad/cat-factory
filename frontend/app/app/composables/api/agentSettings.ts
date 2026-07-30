import {
  listWorkspaceAgentSettingsContract,
  updateWorkspaceAgentSettingsContract,
} from '@cat-factory/contracts'
import type { UpdateWorkspaceAgentSettingsInput } from '~/types/agent-settings'
import type { ApiContext } from './context'

/**
 * The workspace's per-agent-kind generation settings, edited from the pipeline builder. There is
 * no delete route: clearing the last configured field IS the way back to the deployment default,
 * and the server drops the row when nothing is left set.
 */
export function agentSettingsApi({ send, ws }: ApiContext) {
  return {
    // Every kind the workspace has configured — nothing for a kind that inherits.
    listWorkspaceAgentSettings: (workspaceId: string) =>
      send(listWorkspaceAgentSettingsContract, { pathPrefix: ws(workspaceId) }),

    // Patch one kind. An explicit null clears the field; the response is null once the kind is
    // back to inheriting entirely.
    updateWorkspaceAgentSettings: (
      workspaceId: string,
      agentKind: string,
      body: UpdateWorkspaceAgentSettingsInput,
    ) =>
      send(updateWorkspaceAgentSettingsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { agentKind },
        body,
      }),
  }
}
