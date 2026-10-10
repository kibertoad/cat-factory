import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, type NamedTheme } from '~/utils/theme/builtins'
import type { ThemeDoc } from '~/utils/theme/doc'

/**
 * The user's theme choice and their imported themes, persisted in this browser like the language
 * pick (`stores/locale.ts`). Colour MODE (light / dark / system) is NOT here: `@nuxtjs/color-mode`
 * owns that preference and its own storage, and the two are orthogonal (every theme has both
 * modes), so the switcher reads mode from `useColorMode()` and theme from this store.
 *
 * `custom` holds whole documents rather than the editor links they came from, so a theme keeps
 * working when the editor changes its link encoding, and so the persisted blob is exactly what the
 * applier reads (no decode on boot).
 */
export const useThemeStore = defineStore(
  'theme',
  () => {
    const current = ref<string>(DEFAULT_THEME_ID)
    const custom = ref<NamedTheme[]>([])

    const themes = computed<readonly NamedTheme[]>(() => [...BUILTIN_THEMES, ...custom.value])

    // `?? the default` because the restored id is untrusted input: a persisted pick can name a
    // custom theme that was removed, or an id a later build renamed, and the app must still boot
    // on a real document rather than on `undefined`.
    const active = computed<NamedTheme>(
      () =>
        themes.value.find((theme) => theme.id === current.value) ??
        themes.value.find((theme) => theme.id === DEFAULT_THEME_ID) ??
        BUILTIN_THEMES[0]!,
    )
    const isCustom = computed(() => custom.value.some((theme) => theme.id === current.value))

    function select(id: string) {
      if (themes.value.some((theme) => theme.id === id)) current.value = id
    }

    /**
     * A display name no other theme (built-in or imported) already uses. Ids never collide (an
     * import gets a generated one), so the name is the only thing two entries could share, and
     * two menu rows both reading "Mono" tell the user nothing. The first duplicate becomes
     * "Mono (2)", the next "Mono (3)", the file-manager convention. Exposed so the import dialog
     * can show the name that WILL be used while the user is still typing, rather than surprising
     * them after the save.
     */
    function uniqueName(requested: string): string {
      const taken = new Set(themes.value.map((theme) => theme.name.toLowerCase()))
      if (!taken.has(requested.toLowerCase())) return requested
      for (let n = 2; ; n++) {
        const candidate = `${requested} (${n})`
        if (!taken.has(candidate.toLowerCase())) return candidate
      }
    }

    /** Store an imported document under a name and switch to it. Returns the new theme. */
    function addCustom(name: string, doc: ThemeDoc): NamedTheme {
      const theme: NamedTheme = {
        id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: uniqueName(name.trim() || `Theme ${custom.value.length + 1}`),
        doc,
      }
      custom.value = [...custom.value, theme]
      current.value = theme.id
      return theme
    }

    /** Drop an imported theme; the default takes over if it was the active one. */
    function removeCustom(id: string) {
      custom.value = custom.value.filter((theme) => theme.id !== id)
      if (current.value === id) current.value = DEFAULT_THEME_ID
    }

    return {
      current,
      custom,
      themes,
      active,
      isCustom,
      uniqueName,
      select,
      addCustom,
      removeCustom,
    }
  },
  { persist: { pick: ['current', 'custom'] } },
)
