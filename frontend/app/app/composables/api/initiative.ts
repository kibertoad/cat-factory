import {
  createInitiativeContract,
  getInitiativeByBlockContract,
  getInitiativeContract,
  listInitiativesContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Initiatives: the long-running multi-task work containers (create + tracker reads). */
export function initiativeApi({ send, ws }: ApiContext) {
  return {
    // Create the initiative-level board block AND its empty entity in one call.
    createInitiative: (
      workspaceId: string,
      body: { frameId: string; title: string; description?: string },
    ) => send(createInitiativeContract, { pathPrefix: ws(workspaceId), body }),

    listInitiatives: (workspaceId: string) =>
      send(listInitiativesContract, { pathPrefix: ws(workspaceId) }),

    getInitiative: (workspaceId: string, initiativeId: string) =>
      send(getInitiativeContract, { pathPrefix: ws(workspaceId), pathParams: { initiativeId } }),

    // The tracker window's load path: the initiative anchored to a board block.
    getInitiativeByBlock: (workspaceId: string, blockId: string) =>
      send(getInitiativeByBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),
  }
}
