import { computed, watch } from 'vue'
import { useAccountSettingsStore } from '~/stores/accountSettings'

/**
 * The account settings a Team-tab panel patches one key of. Loads them for `accountId`, again
 * when the active account changes (the tab is not remounted then), and joins a load a sibling
 * panel already started. `loaded` is the one thing a patch needs: the current config of THIS
 * account, so `saveConfigPatch` can carry the other keys forward.
 */
export function useAccountConfig(accountId: () => string) {
  const store = useAccountSettingsStore()

  watch(
    accountId,
    async (id) => {
      if (store.isLoadedFor(id) || store.available === false) return
      try {
        await store.load(id)
      } catch {
        // The deployment-settings panel beside every one of these loads the same settings and
        // reports the failure. Here it only means `loaded` stays false, which refuses the save.
      }
    },
    { immediate: true },
  )

  const loaded = computed(() => store.isLoadedFor(accountId()))
  /** No load running and still not loaded: the load failed, so the panel says so. */
  const loadFailed = computed(() => !loaded.value && !store.loading && store.available !== false)

  return { loaded, loadFailed }
}
