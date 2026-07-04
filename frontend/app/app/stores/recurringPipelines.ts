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
  // Resolve translations through the Nuxt app's global i18n instance — a store runs outside a
  // component `setup`, so `useI18n()` is unavailable (see the board store for the same pattern).
  const nuxtApp = useNuxtApp()
  const tr = (key: string): string => (nuxtApp.$i18n as { t: (k: string) => string }).t(key)

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
        title: tr('board.toast.recurringDeleteFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /**
   * Fire a schedule now. An on-demand schedule may target an individual-usage model, so the
   * initiator's personal password is supplied transparently from the cache and prompted via
   * the credential modal (then retried) when the server replies 428. Returns false when the
   * user cancels the password prompt; true once the fire is accepted.
   */
  async function runNow(id: string): Promise<boolean> {
    const ws = useWorkspaceStore()
    const personal = usePersonalSubscriptionsStore()
    return personal.withCredential(async (password) => {
      await api.runScheduleNow(ws.requireId(), id, password)
      await loadRuns(id)
      await ws.refresh()
    })
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
