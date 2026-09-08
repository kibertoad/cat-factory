import {
  getEnvironmentTestContract,
  listEnvironmentsContract,
  provisionEnvironmentContract,
  startEnvironmentTestContract,
  stopEnvironmentTestContract,
} from '@cat-factory/contracts'
import type { EnvironmentTestMode, ProvisionEnvironmentInput } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Ephemeral environments: the workspace's live env handles (used to resolve frontend bindings). */
export function environmentsApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    listEnvironments: (workspaceId: string) =>
      send(listEnvironmentsContract, { pathPrefix: ws(workspaceId) }),

    // Manually provision an environment for a service frame (outside a pipeline run) — the setup
    // wizard's "trial provision" against the just-saved config. Returns the resulting handle.
    provisionEnvironment: (workspaceId: string, body: ProvisionEnvironmentInput) =>
      send(provisionEnvironmentContract, { pathPrefix: ws(workspaceId), body }),

    // Ephemeral-environment self-test: start a full create-branch → provision → tear-down →
    // delete-branch cycle against a service frame, then read / stop its run. `mode` picks what it
    // exercises: the provisioning alone, or that plus an agent dry run against the environment.
    //
    // Carries the personal unlock password, because an `agent-probe` run spends a model call and
    // the model comes from the workspace's preset, which can name a personal subscription
    // (Claude). The backend only consults it when the resolved model needs one, so a provisioning
    // self-test is unaffected.
    startEnvironmentTest: (
      workspaceId: string,
      blockId: string,
      mode: EnvironmentTestMode,
      password?: string,
    ) =>
      sendWith(pwHeaders(password), startEnvironmentTestContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { mode },
      }),
    getEnvironmentTest: (workspaceId: string, id: string) =>
      send(getEnvironmentTestContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),
    stopEnvironmentTest: (workspaceId: string, id: string) =>
      send(stopEnvironmentTestContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),
  }
}
