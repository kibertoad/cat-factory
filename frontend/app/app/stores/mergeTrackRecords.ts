import { CHANGE_CLASSES, emptyMergeClassRollup } from '@cat-factory/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ChangeClass, MergeClassRollup, ReviewEffort } from '~/types/merge'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The merge track record's per-change-class rollups — the accumulated evidence a workspace widens
 * its per-class auto-merge rules against, plus the reviewer-effort tag surface.
 *
 * Loaded on demand (NOT from the workspace snapshot): the rollups are a settings-screen and
 * merge-card concern, not board state, and they change only when a merge settles. The whole set
 * arrives in ONE request — a single SQL aggregate server-side — so the preset editor never fans
 * out per class.
 */
export const useMergeTrackRecordsStore = defineStore('mergeTrackRecords', () => {
  const api = useApi()

  const rollups = ref<MergeClassRollup[]>([])
  const loading = ref(false)
  /** Whether a load has completed at least once, so the UI can tell "empty" from "not yet". */
  const loaded = ref(false)

  /**
   * Every class keyed for lookup, filled in with zeros for a class the workspace has no records
   * for. The backend already returns the full set; this keeps the UI total even before the first
   * load resolves.
   */
  const byClass = computed<Record<ChangeClass, MergeClassRollup>>(() => {
    const found = new Map(rollups.value.map((r) => [r.changeClass, r]))
    return Object.fromEntries(
      CHANGE_CLASSES.map((c) => [c, found.get(c) ?? emptyMergeClassRollup(c)]),
    ) as Record<ChangeClass, MergeClassRollup>
  })

  /** Whether the workspace has ANY track record yet (drives the "no data yet" hint). */
  const hasData = computed(() => rollups.value.some((r) => r.total > 0))

  async function load(): Promise<void> {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      rollups.value = await api.listMergeClassRollups(ws.requireId())
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /**
   * Tag (or clear) how much review a merged PR needed, then refresh the rollups so the class's
   * effort distribution reflects it immediately.
   */
  async function tag(recordId: string, reviewEffort: ReviewEffort | null): Promise<void> {
    const ws = useWorkspaceStore()
    await api.tagMergeReviewEffort(ws.requireId(), recordId, reviewEffort)
    if (loaded.value) await load()
  }

  return { rollups, byClass, hasData, loading, loaded, load, tag }
})
