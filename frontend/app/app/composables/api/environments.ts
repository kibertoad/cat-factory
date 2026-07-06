import { listEnvironmentsContract, provisionEnvironmentContract } from '@cat-factory/contracts'
import type { ProvisionEnvironmentInput } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Ephemeral environments: the workspace's live env handles (used to resolve frontend bindings). */
export function environmentsApi({ send, ws }: ApiContext) {
  return {
    listEnvironments: (workspaceId: string) =>
      send(listEnvironmentsContract, { pathPrefix: ws(workspaceId) }),

    // Manually provision an environment for a service frame (outside a pipeline run) — the setup
    // wizard's "trial provision" against the just-saved config. Returns the resulting handle.
    provisionEnvironment: (workspaceId: string, body: ProvisionEnvironmentInput) =>
      send(provisionEnvironmentContract, { pathPrefix: ws(workspaceId), body }),
  }
}
