import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdateUserSettingsInput, UserSettings } from '~/types/domain'

const DEFAULTS: UserSettings = {
  spendMonthlyLimit: null,
}

/**
 * The signed-in user's personal settings (today: the user-tier spend budget). Hydrated
 * from the workspace snapshot's `userSettings`; `update` persists via `PUT /user-settings`
 * and patches the local copy. Empty (defaults) when no user is signed in.
 */
export const useUserSettingsStore = defineStore('userSettings', () => {
  const api = useApi()
  const settings = ref<UserSettings>({ ...DEFAULTS })

  function hydrate(value: UserSettings | null) {
    settings.value = value ? { ...DEFAULTS, ...value } : { ...DEFAULTS }
  }

  async function update(patch: UpdateUserSettingsInput) {
    settings.value = await api.updateUserSettings(patch)
    return settings.value
  }

  return { settings, hydrate, update }
})
