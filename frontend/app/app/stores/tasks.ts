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
import { useWorkspaceStore } from '~/stores/workspace'

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

  /** null = unknown (not probed yet), true/false = integration on/off. */
  const available = ref<boolean | null>(null)
  /**
   * Why the last probe failed, when it did — captured (rather than swallowed) so
   * the settings panel can explain *why* nothing is surfaced (integration disabled
   * vs a server/backend error) instead of a blanket "install integration first".
   */
  const probeError = ref<{ status: number | null; message: string } | null>(null)
  /** The configured sources, each with its descriptor + per-workspace state (available + enabled). */
  const sources = ref<TaskSourceState[]>([])
  /** Live connections, one per connected (credentialed) source. */
  const connections = ref<TaskConnection[]>([])
  const tasks = ref<SourceTask[]>([])
  /** The last live setup-check verdict per source (from `checkSetup`). */
  const diagnostics = ref<Partial<Record<TaskSourceKind, TaskSourceDiagnostic>>>({})
  /** The source currently running a setup check, if any. */
  const checking = ref<TaskSourceKind | null>(null)
  const loading = ref(false)

  /** Sources the workspace currently has a live connection to. */
  const connectedSources = computed(() =>
    sources.value.filter((s) => connections.value.some((c) => c.source === s.source)),
  )
  const anyConnected = computed(() => connections.value.length > 0)

  /** Sources offered for import: available (connected / App installed) AND enabled. */
  const offeredSources = computed(() => sources.value.filter((s) => s.available && s.enabled))
  const anyOffered = computed(() => offeredSources.value.length > 0)

  function descriptorFor(source: TaskSourceKind): TaskSourceState | undefined {
    return sources.value.find((s) => s.source === source)
  }

  function connectionFor(source: TaskSourceKind): TaskConnection | undefined {
    return connections.value.find((c) => c.source === source)
  }

  function isConnected(source: TaskSourceKind): boolean {
    return connectionFor(source) !== undefined
  }

  /** Imported issues currently attached to a given block. */
  function tasksForBlock(blockId: string): SourceTask[] {
    return tasks.value.filter((t) => t.linkedBlockId === blockId)
  }

  /** Merge an issue returned by the backend into the local cache. */
  function upsertTask(task: SourceTask) {
    const i = tasks.value.findIndex(
      (t) => t.source === task.source && t.externalId === task.externalId,
    )
    if (i >= 0) tasks.value[i] = task
    else tasks.value.unshift(task)
  }

  function upsertConnection(conn: TaskConnection) {
    const i = connections.value.findIndex((c) => c.source === conn.source)
    if (i >= 0) connections.value[i] = conn
    else connections.value.push(conn)
  }

  /** Probe the integration: resolves `available`, the sources and connections. */
  async function probe() {
    if (!workspace.workspaceId) return
    try {
      const [{ sources: srcs }, { connections: conns }] = await Promise.all([
        api.listTaskSources(workspace.requireId()),
        api.listTaskConnections(workspace.requireId()),
      ])
      available.value = true
      probeError.value = null
      sources.value = srcs
      connections.value = conns
    } catch (e) {
      // 503 (integration disabled) or any error → hide the UI entry points, but keep
      // the reason so the settings panel can explain it (a 503 is "turned off on this
      // deployment"; a 500 is "the backend errored — e.g. a migration isn't applied").
      available.value = false
      const err = e as { statusCode?: number; data?: { error?: { message?: string } } }
      const serverMessage = err?.data?.error?.message
      probeError.value = {
        status: err?.statusCode ?? null,
        message: serverMessage || (e instanceof Error ? e.message : String(e)),
      }
      sources.value = []
      connections.value = []
    }
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
    upsertConnection(conn)
    available.value = true
  }

  /** Disconnect the workspace from a source. */
  async function disconnect(source: TaskSourceKind) {
    await api.disconnectTaskSource(workspace.requireId(), source)
    connections.value = connections.value.filter((c) => c.source !== source)
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
    disconnect,
    setEnabled,
    loadTasks,
    importTask,
    search,
    linkToBlock,
    createTaskFromIssue,
  }
})
