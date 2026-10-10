import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  ReferenceArchitecture,
  UpdateReferenceArchitectureInput,
} from '~/types/domain'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'
import { useAgentRunsStore } from '~/stores/agentRuns'

/**
 * Repo-bootstrap state: the workspace's managed reference architectures, plus the
 * actions that CRUD the bases and launch a "bootstrap repo" run. Per-workspace,
 * like the board itself; nothing is persisted client-side. `available` mirrors
 * whether the bootstrap module is reachable (CRUD always is); a run may still come
 * back 503 when the GitHub + container machinery is not configured, which the
 * caller surfaces as an error.
 *
 * The runs themselves (status, progress, failure + retry) now live in the unified
 * {@link useAgentRunsStore}, shared with task executions — this store only owns the
 * managed bases and the launch action.
 */
export const useBootstrapStore = defineStore('bootstrap', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed yet), true/false = module reachable or not. */
  const available = ref<boolean | null>(null)
  const {
    items: architectures,
    upsert: upsertArchitecture,
    remove: dropArchitecture,
  } = useUpsertList<ReferenceArchitecture>({ key: (a) => a.id, prepend: true })
  const loading = ref(false)

  const hasArchitectures = computed(() => architectures.value.length > 0)

  /** Load reference architectures; resolves `available`. */
  async function load() {
    if (!workspace.workspaceId) return
    loading.value = true
    try {
      architectures.value = await api.listReferenceArchitectures(workspace.requireId())
      available.value = true
    } catch {
      // 503 (module disabled) or any error → hide the UI entry points.
      available.value = false
    } finally {
      loading.value = false
    }
  }

  /** Register a new reference architecture. */
  async function createArchitecture(input: CreateReferenceArchitectureInput) {
    const created = await api.createReferenceArchitecture(workspace.requireId(), input)
    upsertArchitecture(created)
    return created
  }

  /** Patch a reference architecture. */
  async function updateArchitecture(id: string, input: UpdateReferenceArchitectureInput) {
    const updated = await api.updateReferenceArchitecture(workspace.requireId(), id, input)
    upsertArchitecture(updated)
    return updated
  }

  /** Remove a reference architecture. */
  async function deleteArchitecture(id: string) {
    await api.deleteReferenceArchitecture(workspace.requireId(), id)
    dropArchitecture(id)
  }

  /**
   * Kick off a "bootstrap repo" run. Returns immediately with the `running` job —
   * the container keeps working in the background; the provisional service frame
   * already shows on the board and live progress arrives over the event stream.
   * The run is recorded in {@link useAgentRunsStore} so its card appears at once.
   */
  async function bootstrap(input: BootstrapRepoInput) {
    const job = await api.bootstrapRepo(workspace.requireId(), input)
    useAgentRunsStore().upsertBootstrap(job)
    // The new run materialised a provisional frame server-side; pull it onto the
    // board now so the card appears even before the first event arrives.
    await workspace.refresh()
    return job
  }

  return {
    available,
    architectures,
    loading,
    hasArchitectures,
    load,
    createArchitecture,
    updateArchitecture,
    deleteArchitecture,
    bootstrap,
  }
})
