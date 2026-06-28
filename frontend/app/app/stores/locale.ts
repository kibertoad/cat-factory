import { defineStore } from 'pinia'
import { ref } from 'vue'

// Persists the user's EXPLICIT language choice so it survives reloads. The app always
// boots in English (the `current` default) — there is no browser auto-detect — and only
// an explicit pick via the switcher changes this. A client plugin applies `current` to
// the active i18n locale on startup; the switcher writes here AND calls i18n's setLocale.
export const useLocaleStore = defineStore(
  'locale',
  () => {
    const current = ref('en')

    function set(code: string) {
      current.value = code
    }

    return { current, set }
  },
  { persist: { pick: ['current'] } },
)
