import {
  connectTaskSourceContract,
  createTaskFromIssueContract,
  diagnoseTaskSourceContract,
  disconnectTaskSourceContract,
  getTrackerSettingsContract,
  importTaskContract,
  linkTaskContract,
  listTaskConnectionsContract,
  listTaskSourcesContract,
  listTasksContract,
  putTrackerSettingsContract,
  searchTasksContract,
  setTaskSourceEnabledContract,
  spawnEpicContract,
} from '@cat-factory/contracts'
import type { TaskSourceKind } from '~/types/domain'
import type { PutTrackerSettingsInput } from '~/types/tracker'
import type { ApiContext } from './context'

/** Task sources (Jira, …): connect/import/search/link + the workspace tracker selection. */
export function tasksApi({ send, ws }: ApiContext) {
  return {
    // ---- task sources (Jira, …) ------------------------------------------
    // The configured trackers + their connect/import metadata + the workspace's
    // per-source state (available + enabled). A 503 means the integration is off
    // (the store hides its UI on any error here).
    listTaskSources: (workspaceId: string) =>
      send(listTaskSourcesContract, { pathPrefix: ws(workspaceId) }),

    setTaskSourceEnabled: (workspaceId: string, source: TaskSourceKind, enabled: boolean) =>
      send(setTaskSourceEnabledContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { enabled },
      }),

    listTaskConnections: (workspaceId: string) =>
      send(listTaskConnectionsContract, { pathPrefix: ws(workspaceId) }),

    connectTaskSource: (
      workspaceId: string,
      source: TaskSourceKind,
      credentials: Record<string, string>,
    ) =>
      send(connectTaskSourceContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { credentials },
      }),

    disconnectTaskSource: (workspaceId: string, source: TaskSourceKind) =>
      send(disconnectTaskSourceContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
      }),

    // Live "check setup" probe: authenticates against the source and reads a slice
    // of its issues API, returning a classified verdict the panel renders verbatim.
    checkTaskSource: (workspaceId: string, source: TaskSourceKind) =>
      send(diagnoseTaskSourceContract, { pathPrefix: ws(workspaceId), pathParams: { source } }),

    listTasks: (workspaceId: string) => send(listTasksContract, { pathPrefix: ws(workspaceId) }),

    importTask: (workspaceId: string, source: TaskSourceKind, body: { ref: string }) =>
      send(importTaskContract, { pathPrefix: ws(workspaceId), pathParams: { source }, body }),

    searchTaskSource: (
      workspaceId: string,
      source: TaskSourceKind,
      query: string,
      blockId?: string,
    ) =>
      send(searchTasksContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body: { query, ...(blockId ? { blockId } : {}) },
      }),

    linkTask: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; blockId: string },
    ) => send(linkTaskContract, { pathPrefix: ws(workspaceId), body }),

    createTaskFromIssue: (
      workspaceId: string,
      body: { source: TaskSourceKind; externalId: string; containerId: string },
    ) => send(createTaskFromIssueContract, { pathPrefix: ws(workspaceId), body }),

    // Spawn an epic + its children as an epic node + child tasks, with dependency edges
    // seeded from the issues' blocked-by/depends-on links.
    spawnEpic: (
      workspaceId: string,
      source: TaskSourceKind,
      body: { ref: string; containerId: string; position?: { x: number; y: number } },
    ) => send(spawnEpicContract, { pathPrefix: ws(workspaceId), pathParams: { source }, body }),

    // ---- issue-tracker selection (workspace-level) ------------------------
    getTrackerSettings: (workspaceId: string) =>
      send(getTrackerSettingsContract, { pathPrefix: ws(workspaceId) }),

    putTrackerSettings: (workspaceId: string, body: PutTrackerSettingsInput) =>
      send(putTrackerSettingsContract, { pathPrefix: ws(workspaceId), body }),
  }
}
