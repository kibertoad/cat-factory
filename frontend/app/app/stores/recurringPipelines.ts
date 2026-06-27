import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { PipelineSchedule, ScheduleRun, UpdateScheduleInput } from '~/types/recurring'
import { useWorkspaceStore } from '~/stores/workspace'
import { useBoardStore } from '~/stores/board'

/**
 * The workspace's recurring pipelines — schedules that re-run a pipeline against a
 * service on a cadence. Hydrated from the workspace snapshot; created from a button
 * on the service frame and managed from the inspector. Run history is fetched
 * lazily per schedule (it is retained only ~1 week so it stays small).
 */
export const useRecurringPipelinesStore = defineStore('recurringPipelines', () => {
  const api = useApi()
  const toast = useToast()

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

  async function create(input: Parameters<typeof api.createRecurringPipeline>[1]) {
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

  /**
   * Delete a recurring pipeline. Deleting the schedule cascades to its reused block
   * + run history server-side, so we hide BOTH immediately (optimistic) and restore
   * them with a toast if the backend rejects the delete.
   */
  async function remove(id: string) {
    const ws = useWorkspaceStore()
    const board = useBoardStore()
    const sched = schedules.value.find((s) => s.id === id)
    const blockSnap = sched ? board.detach(sched.blockId) : null
    const prevSchedules = schedules.value
    schedules.value = schedules.value.filter((s) => s.id !== id)
    try {
      await api.deleteRecurringPipeline(ws.requireId(), id)
      delete runsBySchedule.value[id]
      await ws.refresh()
    } catch (e) {
      schedules.value = prevSchedules
      if (blockSnap) board.reattach(blockSnap)
      toast.add({
        title: 'Could not delete recurring pipeline',
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
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
