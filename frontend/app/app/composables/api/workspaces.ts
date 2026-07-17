import {
  addWorkspaceMemberContract,
  createWorkspaceContract,
  deleteWorkspaceContract,
  getWorkspaceContract,
  getWorkspaceSettingsContract,
  listWorkspaceMembersContract,
  listWorkspacesContract,
  removeWorkspaceMemberContract,
  setWorkspaceAccessModeContract,
  setWorkspaceMemberRoleContract,
  updateWorkspaceContract,
  updateWorkspaceSettingsContract,
} from '@cat-factory/contracts'
import type {
  UpdateWorkspaceSettingsInput,
  WorkspaceAccessMode,
  WorkspaceRole,
} from '~/types/domain'
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

    // ---- workspace membership (RBAC roster + access-mode) -----------------
    // The roster read is open to any resolved role; every write requires `members.manage`
    // (the backend gates it — the SPA only shows this surface to workspace admins).
    listWorkspaceMembers: (workspaceId: string) =>
      send(listWorkspaceMembersContract, { pathParams: { workspaceId } }),

    addWorkspaceMember: (workspaceId: string, userId: string, role: WorkspaceRole) =>
      send(addWorkspaceMemberContract, { pathParams: { workspaceId }, body: { userId, role } }),

    setWorkspaceMemberRole: (workspaceId: string, userId: string, role: WorkspaceRole) =>
      send(setWorkspaceMemberRoleContract, {
        pathParams: { workspaceId, userId },
        body: { role },
      }),

    removeWorkspaceMember: (workspaceId: string, userId: string) =>
      send(removeWorkspaceMemberContract, { pathParams: { workspaceId, userId } }),

    setWorkspaceAccessMode: (workspaceId: string, accessMode: WorkspaceAccessMode) =>
      send(setWorkspaceAccessModeContract, { pathParams: { workspaceId }, body: { accessMode } }),
  }
}
