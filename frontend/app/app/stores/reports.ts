import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ReportWindow, ReportsView } from '~/types/execution'
import { useAccountsStore } from '~/stores/accounts'

/**
 * Reports: cross-cutting usage analytics for the active account: spend per model, agent
 * kind, ticket and run, spend + run activity per workspace / service / repository / task
 * type, and a spend trend, over a selectable window and optionally narrowed to one board.
 *
 * The sibling of the `platformObservability` store: same account scope, same admin gate,
 * same on-demand load. Nothing is pushed live (these are periodic rollups); changing the
 * window or the board filter re-fetches, and a manual refresh re-fetches unconditionally.
 */
export const useReportsStore = defineStore('reports', () => {
  const api = useApi()
  const accounts = useAccountsStore()

  const window = ref<ReportWindow>('7d')
  /** The single board every breakdown is narrowed to, or null for the whole account. */
  const workspaceFilter = ref<string | null>(null)
  const view = ref<ReportsView | null>(null)
  const loading = ref(false)
  /** Whether the last load failed. The panel owns the localized wording. */
  const failed = ref(false)
  /**
   * The backend's raw (untranslated) message for a failed load, shown beneath the localized
   * heading as a last-resort detail — null when the failure carried no message at all.
   */
  const error = ref<string | null>(null)

  const accountId = computed(() => accounts.activeAccount?.id ?? null)

  /**
   * Monotonicity guard. The window buttons, the board filter and the refresh button can each
   * start a load, so two are easily in flight at once — and without this a staler response
   * resolving later would overwrite the newer view (and its `loading`/error state) with
   * numbers for a window the user already moved off. Only the newest load may commit.
   */
  let latest = 0

  async function load() {
    const id = accountId.value
    if (!id) {
      view.value = null
      return
    }
    const seq = ++latest
    loading.value = true
    failed.value = false
    error.value = null
    try {
      const next = await api.getReports(id, window.value, workspaceFilter.value)
      if (seq !== latest) return
      view.value = next
    } catch (err) {
      if (seq !== latest) return
      failed.value = true
      error.value = err instanceof Error ? err.message : null
    } finally {
      if (seq === latest) loading.value = false
    }
  }

  /** Switch the window and reload (a no-op when it is already the loaded one). */
  async function setWindow(next: ReportWindow) {
    if (next === window.value && view.value) return
    window.value = next
    await load()
  }

  /** Narrow to one board (null = the whole account) and reload. */
  async function setWorkspaceFilter(next: string | null) {
    if (next === workspaceFilter.value && view.value) return
    workspaceFilter.value = next
    await load()
  }

  return {
    window,
    workspaceFilter,
    view,
    loading,
    failed,
    error,
    accountId,
    load,
    setWindow,
    setWorkspaceFilter,
  }
})
