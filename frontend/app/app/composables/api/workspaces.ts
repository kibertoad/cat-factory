import {
  createWorkspaceContract,
  deleteWorkspaceContract,
  getWorkspaceContract,
  getWorkspaceSettingsContract,
  listWorkspacesContract,
  updateWorkspaceContract,
  updateWorkspaceSettingsContract,
} from '@cat-factory/contracts'
import type { UpdateWorkspaceSettingsInput } from '~/types/domain'
import type { ApiContext } from './context'

/** Workspace CRUD + the full snapshot read. */
export function workspacesApi({ send, ws }: ApiContext) {
  return {
    // ---- workspaces -------------------------------------------------------
    listWorkspaces: () => send(listWorkspacesContract, {}),

    createWorkspace: (
      body: { name?: string; description?: string; seed?: boolean; accountId?: string } = {},
    ) => send(createWorkspaceContract, { body }),

    getWorkspace: (workspaceId: string) =>
      send(getWorkspaceContract, { pathParams: { workspaceId } }),

    updateWorkspace: (workspaceId: string, body: { name?: string; description?: string | null }) =>
      send(updateWorkspaceContract, { pathParams: { workspaceId }, body }),

    renameWorkspace: (workspaceId: string, name: string) =>
      send(updateWorkspaceContract, { pathParams: { workspaceId }, body: { name } }),

    deleteWorkspace: (workspaceId: string) =>
      send(deleteWorkspaceContract, { pathParams: { workspaceId } }),

    // ---- workspace runtime settings (human-wait escalation + per-service task limit) --
    getWorkspaceSettings: (workspaceId: string) =>
      send(getWorkspaceSettingsContract, { pathPrefix: ws(workspaceId) }),

    updateWorkspaceSettings: (workspaceId: string, body: UpdateWorkspaceSettingsInput) =>
      send(updateWorkspaceSettingsContract, { pathPrefix: ws(workspaceId), body }),
  }
}
