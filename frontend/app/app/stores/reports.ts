import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ReportWindow, ReportsView } from '~/types/execution'
import { useAccountsStore } from '~/stores/accounts'

/**
 * Reports: cross-cutting usage analytics for the active account — spend per model and
 * agent kind, spend + run activity per workspace / service / task type, and a spend trend,
 * over a selectable window and optionally narrowed to one board.
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
  const error = ref<string | null>(null)

  const accountId = computed(() => accounts.activeAccount?.id ?? null)

  async function load() {
    const id = accountId.value
    if (!id) {
      view.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      view.value = await api.getReports(id, window.value, workspaceFilter.value)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load reports'
    } finally {
      loading.value = false
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
    error,
    accountId,
    load,
    setWindow,
    setWorkspaceFilter,
  }
})
