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

  /**
   * Bootstrap jobs that materialised a board frame, keyed by that frame's block
   * id — so a service card can show its run's live status + subtask progress (and
   * a "bootstrapping…"/failed badge) by looking itself up here.
   */
  const byBlock = computed(() => {
    const map: Record<string, BootstrapJob> = {}
    // `jobs` is newest-first; a retry creates a new job reusing the prior run's
    // frame, so keep the FIRST (newest) job seen for each block — the live attempt.
    for (const job of jobs.value) if (job.blockId && !map[job.blockId]) map[job.blockId] = job
    return map
  })

  /**
   * Patch a job from a real-time `bootstrap` event (or after launching one):
   * replace it in place by id, else prepend it. Keeps the board card reactive to
   * live progress without a refetch.
   */
  function upsert(job: BootstrapJob) {
    const i = jobs.value.findIndex((j) => j.id === job.id)
    if (i >= 0) jobs.value[i] = job
    else jobs.value.unshift(job)
  }

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

  /**
   * Kick off a "bootstrap repo" run. Returns immediately with the `running` job —
   * the container keeps working in the background; the provisional service frame
   * already shows on the board and live progress arrives over the event stream.
   */
  async function bootstrap(input: BootstrapRepoInput) {
    const job = await api.bootstrapRepo(workspace.requireId(), input)
    upsert(job)
    // The new run materialised a provisional frame server-side; pull it onto the
    // board now so the card appears even before the first event arrives.
    await workspace.refresh()
    return job
  }

  /**
   * Retry a failed run. Returns a NEW running job that reuses the failed run's
   * board frame (the card flips from failed back to "bootstrapping…"); a fresh
   * container is spun up server-side and live progress arrives over the stream.
   */
  async function retry(jobId: string) {
    const job = await api.retryBootstrapJob(workspace.requireId(), jobId)
    upsert(job)
    await workspace.refresh()
    return job
  }

  return {
    available,
    architectures,
    jobs,
    loading,
    hasArchitectures,
    byBlock,
    load,
    createArchitecture,
    updateArchitecture,
    deleteArchitecture,
    bootstrap,
    retry,
    upsert,
  }
})
