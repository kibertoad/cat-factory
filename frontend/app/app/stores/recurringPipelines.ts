import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreateScheduleInput,
  PipelineSchedule,
  ScheduleRun,
  UpdateScheduleInput,
} from '~/types/recurring'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's recurring pipelines — schedules that re-run a pipeline against a
 * service on a cadence. Hydrated from the workspace snapshot; created from a button
 * on the service frame and managed from the inspector. Run history is fetched
 * lazily per schedule (it is retained only ~1 week so it stays small).
 */
export const useRecurringPipelinesStore = defineStore('recurringPipelines', () => {
  const api = useApi()

  const schedules = ref<PipelineSchedule[]>([])
  /** Lazily-loaded run history, keyed by schedule id. */
  const runsBySchedule = ref<Record<string, ScheduleRun[]>>({})

  function hydrate(list: PipelineSchedule[]) {
    schedules.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Schedules grouped by the service frame they live in (for board badges). */
  const byFrame = computed<Record<string, PipelineSchedule[]>>(() => {
    const map: Record<string, PipelineSchedule[]> = {}
    for (const s of schedules.value) (map[s.frameId] ??= []).push(s)
    return map
  })

  /** The schedule whose reused block is `blockId`, if any. */
  function byBlock(blockId: string): PipelineSchedule | undefined {
    return schedules.value.find((s) => s.blockId === blockId)
  }

  async function create(input: CreateScheduleInput) {
    const ws = useWorkspaceStore()
    const created = await api.createRecurringPipeline(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(id: string, patch: UpdateScheduleInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateRecurringPipeline(ws.requireId(), id, patch)
    await ws.refresh()
    return updated
  }

  async function remove(id: string) {
    const ws = useWorkspaceStore()
    await api.deleteRecurringPipeline(ws.requireId(), id)
    delete runsBySchedule.value[id]
    await ws.refresh()
  }

  async function runNow(id: string) {
    const ws = useWorkspaceStore()
    const schedule = await api.runScheduleNow(ws.requireId(), id)
    await loadRuns(id)
    await ws.refresh()
    return schedule
  }

  /** Fetch (and cache) a schedule's run history for the inspector. */
  async function loadRuns(id: string) {
    const ws = useWorkspaceStore()
    const runs = await api.listScheduleRuns(ws.requireId(), id)
    runsBySchedule.value = { ...runsBySchedule.value, [id]: runs }
    return runs
  }

  return {
    schedules,
    runsBySchedule,
    byFrame,
    byBlock,
    hydrate,
    create,
    update,
    remove,
    runNow,
    loadRuns,
  }
})
