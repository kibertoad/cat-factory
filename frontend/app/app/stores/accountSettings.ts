import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AccountSettingsView, UpdateAccountSettingsInput } from '~/types/accountSettings'

/**
 * Per-account deployment settings (admin only): the integration secrets — Slack app OAuth
 * credentials + the web-search upstream keys — sealed at rest in the DB. Secrets are
 * write-only: this store only ever holds the non-secret `summary` (which integrations are
 * configured), never the values. `available` mirrors the backend opt-in: a 503 (no
 * ENCRYPTION_KEY) hides the panel. Loaded on demand from the account-settings panel.
 */
export const useAccountSettingsStore = defineStore('accountSettings', () => {
  const api = useApi()

  const view = ref<AccountSettingsView | null>(null)
  const loading = ref(false)
  const available = ref<boolean | null>(null)

  async function load(accountId: string) {
    loading.value = true
    try {
      view.value = await api.getAccountSettings(accountId)
      available.value = true
    } catch (e) {
      // 503 ⇒ the settings store isn't wired (no ENCRYPTION_KEY) ⇒ hide the panel.
      if (
        e &&
        typeof e === 'object' &&
        'statusCode' in e &&
        (e as { statusCode?: number }).statusCode === 503
      ) {
        available.value = false
        view.value = null
      } else {
        throw e
      }
    } finally {
      loading.value = false
    }
  }

  async function save(accountId: string, input: UpdateAccountSettingsInput) {
    view.value = await api.updateAccountSettings(accountId, input)
    available.value = true
    return view.value
  }

  return { view, loading, available, load, save }
})
