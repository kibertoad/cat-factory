import { listEnvironmentsContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Ephemeral environments: the workspace's live env handles (used to resolve frontend bindings). */
export function environmentsApi({ send, ws }: ApiContext) {
  return {
    listEnvironments: (workspaceId: string) =>
      send(listEnvironmentsContract, { pathPrefix: ws(workspaceId) }),
  }
}
