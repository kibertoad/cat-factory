import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocalSettings, UpdateLocalSettingsInput } from '~/types/localSettings'

/**
 * Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse) —
 * a per-deployment singleton that replaced the old LOCAL_POOL_* / HARNESS_* env vars. No
 * secrets, so the store holds the full config. `available` mirrors the backend opt-in: a 503
 * (not the local-mode service) hides the panel. Loaded on demand from the settings panel.
 */
export const useLocalSettingsStore = defineStore('localSettings', () => {
  const api = useApi()

  const settings = ref<LocalSettings | null>(null)
  const loading = ref(false)
  const available = ref<boolean | null>(null)

  async function load() {
    loading.value = true
    try {
      settings.value = await api.getLocalSettings()
      available.value = true
    } catch (e) {
      // 503 ⇒ not the local-mode service ⇒ hide the panel.
      if (
        e &&
        typeof e === 'object' &&
        'statusCode' in e &&
        (e as { statusCode?: number }).statusCode === 503
      ) {
        available.value = false
        settings.value = null
      } else {
        throw e
      }
    } finally {
      loading.value = false
    }
  }

  async function save(input: UpdateLocalSettingsInput) {
    settings.value = await api.updateLocalSettings(input)
    available.value = true
    return settings.value
  }

  return { settings, loading, available, load, save }
})
