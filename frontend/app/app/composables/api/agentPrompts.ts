import {
  getAgentPromptContract,
  listAgentPromptsContract,
  saveAgentPromptContract,
} from '@cat-factory/contracts'
import type { SaveAgentPromptInput } from '~/types/agent-prompts'
import type { ApiContext } from './context'

/**
 * The workspace's agent system-prompt overrides, edited from the pipeline builder. There is no
 * delete: going back to the shipped prompt is a save with `text: null`, so the history of what
 * a workspace was running is never lost.
 */
export function agentPromptsApi({ send, ws }: ApiContext) {
  return {
    // The override INDEX (no prompt bodies) — the builder badges its steps from this.
    listAgentPrompts: (workspaceId: string) =>
      send(listAgentPromptsContract, { pathPrefix: ws(workspaceId) }),

    // One kind's editor state: the shipped text, the effective text, and the revision log.
    getAgentPrompt: (workspaceId: string, agentKind: string) =>
      send(getAgentPromptContract, { pathPrefix: ws(workspaceId), pathParams: { agentKind } }),

    saveAgentPrompt: (workspaceId: string, agentKind: string, body: SaveAgentPromptInput) =>
      send(saveAgentPromptContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { agentKind },
        body,
      }),
  }
}
