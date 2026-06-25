import type {
  Block,
  SourceTask,
  TaskConnection,
  TaskSearchResult,
  TaskSourceKind,
  TaskSourceState,
} from '~/types/domain'
import type { PutTrackerSettingsInput, TrackerSettings } from '~/types/tracker'
import type { ApiContext } from './context'

/** Task sources (Jira, …): connect/import/search/link + the workspace tracker selection. */
export function tasksApi({ http, ws }: ApiContext) {
  return {
    // ---- task sources (Jira, …) ------------------------------------------
    // The configured trackers + their connect/import metadata + the workspace's
    // per-source state (available + enabled). A 503 means the integration is off
    // (the store hides its UI on any error here).
    listTaskSources: (workspaceId: string) =>
      http<{ sources: TaskSourceState[] }>(`${ws(workspaceId)}/task-sources`),

    setTaskSourceEnabled: (workspaceId: string, source: TaskSourceKind, enabled: boolean) =>
      http(`${ws(workspaceId)}/task-sources/${source}/enabled`, {
        method: 'PUT',
        body: { enabled },
      }),

    listTaskConnections: (workspaceId: string) =>
      http<{ connections: TaskConnection[] }>(`${ws(workspaceId)}/task-sources/connections`),

    connectTaskSource: (
      workspaceId: string,
      source: TaskSourceKind,
      credentials: Record<string, string>,
    ) =>
      http<TaskConnection>(`${ws(workspaceId)}/task-sources/${source}/connect`, {
        method: 'POST',
        body: { credentials },
      }),

    disconnectTaskSource: (workspaceId: string, source: TaskSourceKind) =>
      http(`${ws(workspaceId)}/task-sources/${source}/connection`, { method: 'DELETE' }),

    listTasks: (workspaceId: string) => http<SourceTask[]>(`${ws(workspaceId)}/tasks`),

    importTask: (workspaceId: string, source: TaskSourceKind, body: { ref: string }) =>
      http<SourceTask>(`${ws(workspaceId)}/task-sources/${source}/import`, {
        method: 'POST',
        body,
      }),

    searchTaskSource: (workspaceId: string, source: TaskSourceKind, query: string) =>
      http<{ results: TaskSearchResult[] }>(`${ws(workspaceId)}/task-sources/${source}/search`, {
        method: 'POST',
        body: { query },
      }),

    linkTask: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; blockId: string },
    ) => http<SourceTask>(`${ws(workspaceId)}/tasks/link`, { method: 'POST', body }),

    createTaskFromIssue: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; containerId: string },
    ) =>
      http<{ block: Block; task: SourceTask }>(`${ws(workspaceId)}/tasks/create-block`, {
        method: 'POST',
        body,
      }),

    // ---- issue-tracker selection (workspace-level) ------------------------
    getTrackerSettings: (workspaceId: string) =>
      http<TrackerSettings>(`${ws(workspaceId)}/tracker-settings`),

    putTrackerSettings: (workspaceId: string, body: PutTrackerSettingsInput) =>
      http<TrackerSettings>(`${ws(workspaceId)}/tracker-settings`, { method: 'PUT', body }),
  }
}
