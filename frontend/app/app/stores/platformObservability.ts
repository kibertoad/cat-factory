import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { PlatformObservability, PlatformObservabilityWindow } from '~/types/execution'
import { useAccountsStore } from '~/stores/accounts'

/**
 * Platform-operator observability: the deployment-level aggregate health of the active
 * account's runs (outcomes, failure taxonomy, live/parked depth, duration + trend) over a
 * time window. The account-scoped, admin-gated counterpart of the per-run `observability`
 * store — loaded on demand when the operator dashboard opens and re-loaded when the window
 * changes. Nothing is pushed live (these are periodic rollups); a manual refresh re-fetches.
 */
export const usePlatformObservabilityStore = defineStore('platformObservability', () => {
  const api = useApi()
  const accounts = useAccountsStore()

  const window = ref<PlatformObservabilityWindow>('24h')
  const view = ref<PlatformObservability | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const accountId = computed(() => accounts.activeAccount?.id ?? null)

  async function load(nextWindow?: PlatformObservabilityWindow) {
    if (nextWindow) window.value = nextWindow
    const id = accountId.value
    if (!id) {
      view.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      view.value = await api.getPlatformObservability(id, window.value)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load platform observability'
    } finally {
      loading.value = false
    }
  }

  /** Switch the window and reload. */
  async function setWindow(next: PlatformObservabilityWindow) {
    if (next === window.value && view.value) return
    await load(next)
  }

  return { window, view, loading, error, accountId, load, setWindow }
})
