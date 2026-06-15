import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  BootstrapJob,
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  ReferenceArchitecture,
  UpdateReferenceArchitectureInput,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Repo-bootstrap state: the workspace's managed reference architectures and the
 * log of "bootstrap repo" runs, plus the actions that CRUD the bases and launch a
 * bootstrap against the backend. Per-workspace, like the board itself; nothing is
 * persisted client-side. `available` mirrors whether the bootstrap module is
 * reachable (CRUD always is); a run may still come back 503 when the GitHub +
 * container machinery is not configured, which the caller surfaces as an error.
 */
export const useBootstrapStore = defineStore('bootstrap', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = unknown (not probed yet), true/false = module reachable or not. */
  const available = ref<boolean | null>(null)
  const architectures = ref<ReferenceArchitecture[]>([])
  const jobs = ref<BootstrapJob[]>([])
  const loading = ref(false)

  const hasArchitectures = computed(() => architectures.value.length > 0)

  /** Load reference architectures + recent jobs; resolves `available`. */
  async function load() {
    if (!workspace.workspaceId) return
    loading.value = true
    try {
      const id = workspace.requireId()
      const [archs, runs] = await Promise.all([
        api.listReferenceArchitectures(id),
        api.listBootstrapJobs(id),
      ])
      architectures.value = archs
      jobs.value = runs
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
    architectures.value.unshift(created)
    return created
  }

  /** Patch a reference architecture. */
  async function updateArchitecture(id: string, input: UpdateReferenceArchitectureInput) {
    const updated = await api.updateReferenceArchitecture(workspace.requireId(), id, input)
    const i = architectures.value.findIndex((a) => a.id === id)
    if (i >= 0) architectures.value[i] = updated
    return updated
  }

  /** Remove a reference architecture. */
  async function deleteArchitecture(id: string) {
    await api.deleteReferenceArchitecture(workspace.requireId(), id)
    architectures.value = architectures.value.filter((a) => a.id !== id)
  }

  /** Kick off a "bootstrap repo" run and prepend the resulting job. */
  async function bootstrap(input: BootstrapRepoInput) {
    const job = await api.bootstrapRepo(workspace.requireId(), input)
    jobs.value.unshift(job)
    return job
  }

  return {
    available,
    architectures,
    jobs,
    loading,
    hasArchitectures,
    load,
    createArchitecture,
    updateArchitecture,
    deleteArchitecture,
    bootstrap,
  }
})
