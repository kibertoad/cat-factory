import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, type NamedTheme } from '~/utils/theme/builtins'

/**
 * The user's theme choice, persisted in this browser like the language pick (`stores/locale.ts`).
 * Colour MODE (light / dark / system) is NOT here: `@nuxtjs/color-mode` owns that preference and
 * its own storage, and the two are orthogonal (every theme has both modes), so the switcher reads
 * mode from `useColorMode()` and theme from this store.
 */
export const useThemeStore = defineStore(
  'theme',
  () => {
    const current = ref<string>(DEFAULT_THEME_ID)

    const themes = computed<readonly NamedTheme[]>(() => BUILTIN_THEMES)

    // `?? the default` because the restored id is untrusted input: a persisted pick can name an
    // id a later build renamed, and the app must still boot on a real document rather than on
    // `undefined`.
    const active = computed<NamedTheme>(
      () =>
        themes.value.find((theme) => theme.id === current.value) ??
        themes.value.find((theme) => theme.id === DEFAULT_THEME_ID) ??
        BUILTIN_THEMES[0]!,
    )

    function select(id: string) {
      if (themes.value.some((theme) => theme.id === id)) current.value = id
    }

    return { current, themes, active, select }
  },
  { persist: { pick: ['current'] } },
)
