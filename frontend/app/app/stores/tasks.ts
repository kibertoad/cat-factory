import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  SourceTask,
  TaskConnection,
  TaskSourceDescriptor,
  TaskSourceKind,
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
  /** The configured sources and their connect/import descriptors. */
  const sources = ref<TaskSourceDescriptor[]>([])
  /** Live connections, one per connected source. */
  const connections = ref<TaskConnection[]>([])
  const tasks = ref<SourceTask[]>([])
  const loading = ref(false)

  /** Sources the workspace currently has a live connection to. */
  const connectedSources = computed(() =>
    sources.value.filter((s) => connections.value.some((c) => c.source === s.source)),
  )
  const anyConnected = computed(() => connections.value.length > 0)

  function descriptorFor(source: TaskSourceKind): TaskSourceDescriptor | undefined {
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
      sources.value = srcs
      connections.value = conns
    } catch {
      // 503 (integration disabled) or any error → hide the UI entry points.
      available.value = false
      sources.value = []
      connections.value = []
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

  /** Attach an imported issue to a block as agent context. */
  async function linkToBlock(blockId: string, source: TaskSourceKind, externalId: string) {
    const task = await api.linkTask(workspace.requireId(), { source, externalId, blockId })
    upsertTask(task)
    return task
  }

  return {
    available,
    sources,
    connections,
    tasks,
    loading,
    connectedSources,
    anyConnected,
    descriptorFor,
    connectionFor,
    isConnected,
    tasksForBlock,
    probe,
    connect,
    disconnect,
    loadTasks,
    importTask,
    linkToBlock,
  }
})
