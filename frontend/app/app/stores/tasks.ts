import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  SourceTask,
  TaskConnection,
  TaskSearchResult,
  TaskSourceDiagnostic,
  TaskSourceKind,
  TaskSourceState,
} from '~/types/domain'
import { useSourceIntegration } from '~/composables/useSourceIntegration'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'
import { useBoardStore } from '~/stores/board'

/**
 * Task-source integration state: the trackers the backend offers (and their
 * connect metadata), the workspace's per-source connections, and the issues it
 * has imported — plus the actions that connect/import/link against the backend.
 * `available` mirrors the backend's opt-in gate: a 503 from the source probe
 * means the integration is off, and the UI hides its entry points (just as the
 * documents store does). The abstraction is source-agnostic; every action is
 * keyed by a `TaskSourceKind`. Per-workspace; nothing is persisted client-side.
 *
 * Unlike documents there is no plan/spawn — an issue is linked to a block for
 * agent context, never expanded into board structure.
 */
export const useTasksStore = defineStore('tasks', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  // Shared opt-in / probe / connections lifecycle (see `useSourceIntegration`). Its
  // `probeError` is what lets the settings panel explain *why* nothing is surfaced
  // (integration disabled vs a server/backend error) instead of "install it first".
  const integration = useSourceIntegration<TaskSourceKind, TaskConnection, TaskSourceState>({
    enabled: () => !!workspace.workspaceId,
    fetch: async () => {
      const [{ sources }, { connections }] = await Promise.all([
        api.listTaskSources(workspace.requireId()),
        api.listTaskConnections(workspace.requireId()),
      ])
      return { sources, connections }
    },
  })
  const { available, probeError, sources, connections, connectedSources, anyConnected } =
    integration
  const { descriptorFor, connectionFor, isConnected, probe } = integration

  const { items: tasks, upsert: upsertTask } = useUpsertList<SourceTask>({
    key: (t) => `${t.source}:${t.externalId}`,
    prepend: true,
  })
  /** The last live setup-check verdict per source (from `checkSetup`). */
  const diagnostics = ref<Partial<Record<TaskSourceKind, TaskSourceDiagnostic>>>({})
  /** The source currently running a setup check, if any. */
  const checking = ref<TaskSourceKind | null>(null)
  const loading = ref(false)

  /** Sources offered for import: available (connected / App installed) AND enabled. */
  const offeredSources = computed(() => sources.value.filter((s) => s.available && s.enabled))
  const anyOffered = computed(() => offeredSources.value.length > 0)

  /** Imported issues currently attached to a given block. */
  function tasksForBlock(blockId: string): SourceTask[] {
    return tasks.value.filter((t) => t.linkedBlockId === blockId)
  }

  /**
   * Run a live setup check for a source (authenticate + read), caching the verdict
   * so the panel can show exactly what's wrong (missing App / wrong token / lacking
   * the Issues permission) and how to fix it. Re-probes on success so a
   * just-fixed source flips `available`/`enabled` without a manual reload.
   */
  async function checkSetup(source: TaskSourceKind): Promise<TaskSourceDiagnostic> {
    checking.value = source
    try {
      const result = await api.checkTaskSource(workspace.requireId(), source)
      diagnostics.value = { ...diagnostics.value, [source]: result }
      if (result.ok) await probe()
      return result
    } finally {
      checking.value = null
    }
  }

  /** Connect the workspace to a source with its credential bag. */
  async function connect(source: TaskSourceKind, credentials: Record<string, string>) {
    const conn = await api.connectTaskSource(workspace.requireId(), source, credentials)
    integration.upsertConnection(conn)
    available.value = true
  }

  /**
   * Start the "Connect with Linear" OAuth flow by navigating the browser to the
   * authorize URL the backend mints (carrying a signed `state`). Linear redirects
   * back to the public callback, which stores the token; the settings panel's
   * `probe()` on return then reflects the new connection.
   */
  async function startLinearOAuth() {
    const { url } = await api.getLinearInstallUrl(workspace.requireId())
    window.location.href = url
  }

  /** Disconnect the workspace from a source. */
  async function disconnect(source: TaskSourceKind) {
    await api.disconnectTaskSource(workspace.requireId(), source)
    integration.removeConnection(source)
  }

  /** Enable or disable a source for the workspace (the per-workspace toggle). */
  async function setEnabled(source: TaskSourceKind, enabled: boolean) {
    await api.setTaskSourceEnabled(workspace.requireId(), source, enabled)
    const i = sources.value.findIndex((s) => s.source === source)
    if (i >= 0) sources.value[i] = { ...sources.value[i]!, enabled }
  }

  /** Load the imported issues for the workspace (across sources). */
  async function loadTasks() {
    tasks.value = await api.listTasks(workspace.requireId())
  }

  /**
   * Fetch imported issues scoped to a block's service repo (GitHub only — a
   * repo-backed source narrows to that service's linked repo, exactly as `search`
   * does; repo-less sources are unaffected). Returns the list WITHOUT touching the
   * shared `tasks` state, so a repo-scoped view (the issue picker) can hold its own
   * list without narrowing the workspace-wide one other views rely on. Omit
   * `blockId` for the whole workspace.
   */
  async function listTasksForBlock(blockId?: string): Promise<SourceTask[]> {
    return api.listTasks(workspace.requireId(), blockId)
  }

  /** Import (fetch + persist) an issue by key or URL from a source. */
  async function importTask(source: TaskSourceKind, ref: string): Promise<SourceTask> {
    loading.value = true
    try {
      const task = await api.importTask(workspace.requireId(), source, { ref })
      upsertTask(task)
      return task
    } finally {
      loading.value = false
    }
  }

  /**
   * Search a connected tracker's issues by free text (title/content). `blockId`
   * (a service frame or a task/module under one) scopes a GitHub search to that
   * service's linked repo — so hits stay in-repo and a pasted URL / bare issue
   * number resolves to the exact issue. Omitted → an unscoped workspace search.
   */
  async function search(
    source: TaskSourceKind,
    query: string,
    blockId?: string,
  ): Promise<TaskSearchResult[]> {
    const { results } = await api.searchTaskSource(workspace.requireId(), source, query, blockId)
    return results
  }

  /** Attach an imported issue to a block as agent context. */
  async function linkToBlock(blockId: string, source: TaskSourceKind, externalId: string) {
    const task = await api.linkTask(workspace.requireId(), { source, externalId, blockId })
    upsertTask(task)
    return task
  }

  /**
   * Create a new board task from an imported issue inside a container, linking the
   * issue to it for context. The caller upserts the returned block onto the board.
   */
  async function createTaskFromIssue(
    source: TaskSourceKind,
    externalId: string,
    containerId: string,
  ) {
    const result = await api.createTaskFromIssue(workspace.requireId(), {
      source,
      externalId,
      containerId,
    })
    upsertTask(result.task)
    return result
  }

  /**
   * Spawn an epic and its children onto the board: an epic node + a task per child issue
   * (joined to the epic), with dependency edges seeded from the issues' links. Upserts the
   * created blocks so the board reflects them immediately (the stream also re-broadcasts).
   */
  async function spawnEpic(
    source: TaskSourceKind,
    ref: string,
    containerId: string,
    position?: { x: number; y: number },
  ) {
    const board = useBoardStore()
    const result = await api.spawnEpic(workspace.requireId(), source, {
      ref,
      containerId,
      ...(position ? { position } : {}),
    })
    board.upsert(result.epic)
    for (const t of result.tasks) board.upsert(t)
    await loadTasks().catch(() => {})
    return result
  }

  return {
    available,
    probeError,
    sources,
    connections,
    tasks,
    diagnostics,
    checking,
    loading,
    connectedSources,
    anyConnected,
    offeredSources,
    anyOffered,
    descriptorFor,
    connectionFor,
    isConnected,
    tasksForBlock,
    probe,
    checkSetup,
    connect,
    startLinearOAuth,
    disconnect,
    setEnabled,
    loadTasks,
    listTasksForBlock,
    importTask,
    search,
    linkToBlock,
    createTaskFromIssue,
    spawnEpic,
  }
})
