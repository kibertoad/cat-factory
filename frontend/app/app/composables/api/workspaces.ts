import type { Workspace, WorkspaceSnapshot } from '~/types/domain'
import type { ApiContext } from './context'

/** Workspace CRUD + the full snapshot read. */
export function workspacesApi({ http, ws }: ApiContext) {
  return {
    // ---- workspaces -------------------------------------------------------
    listWorkspaces: () => http<Workspace[]>('/workspaces'),

    createWorkspace: (
      body: { name?: string; description?: string; seed?: boolean; accountId?: string } = {},
    ) => http<WorkspaceSnapshot>('/workspaces', { method: 'POST', body }),

    getWorkspace: (workspaceId: string) => http<WorkspaceSnapshot>(ws(workspaceId)),

    updateWorkspace: (workspaceId: string, body: { name?: string; description?: string | null }) =>
      http<Workspace>(ws(workspaceId), { method: 'PATCH', body }),

    renameWorkspace: (workspaceId: string, name: string) =>
      http<Workspace>(ws(workspaceId), { method: 'PATCH', body: { name } }),

    deleteWorkspace: (workspaceId: string) => http(ws(workspaceId), { method: 'DELETE' }),
  }
}
