import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { parseUiMode, resolveUiMode, type UiMode } from '~/utils/uiMode'

/**
 * The interface tier (`basic` / `advanced`) and the side-navbar collapse state.
 *
 * Mode resolution is `env → browser-stored → basic` (see `utils/uiMode.ts`). The env value
 * is `runtimeConfig.public.uiMode`, i.e. `NUXT_PUBLIC_UI_MODE`: the SPA is `ssr: false`, so
 * — exactly like `apiBase` — it is baked in at build time and cannot change while the app
 * is loaded. It is therefore read ONCE here rather than tracked reactively. Only the user's
 * own choice is persisted, so a deployment that later drops its env pin falls back to
 * whatever the user last picked instead of to the default.
 *
 * The collapse state is deliberately NOT a single persisted boolean. Basic mode must ALWAYS
 * start collapsed (the rail is part of what makes it feel basic), so a plain persisted flag
 * would either violate that or silently discard an advanced user's choice. Instead the
 * collapse is DERIVED from the mode, with a session-scoped override the toggle sets: basic
 * derives `collapsed`, advanced derives the user's persisted rail preference, and switching
 * mode drops the override so the new mode's default applies.
 */
export const useUiModeStore = defineStore(
  'uiMode',
  () => {
    const envMode = parseUiMode(useRuntimeConfig().public.uiMode)

    /** The user's explicit pick, persisted. `null` until they choose one. */
    const storedMode = ref<UiMode | null>(null)
    /** The rail preference an ADVANCED-mode user last chose, persisted. */
    const railPreference = ref(false)
    /** This session's explicit collapse choice; `null` = follow the mode's default. */
    const collapseOverride = ref<boolean | null>(null)

    const mode = computed<UiMode>(() => resolveUiMode(envMode, storedMode.value))
    const isAdvanced = computed(() => mode.value === 'advanced')
    /** Pinned by the deployment: the switcher is read-only, since a write would be ignored. */
    const envPinned = computed(() => envMode !== null)

    const navCollapsed = computed(
      () => collapseOverride.value ?? (isAdvanced.value ? railPreference.value : true),
    )

    // A mode switch re-derives the collapse from the new mode (basic → rail, advanced → the
    // user's rail preference), which is what "basic mode always starts collapsed" means for a
    // user who flips modes mid-session rather than only across reloads.
    watch(mode, () => {
      collapseOverride.value = null
    })

    /** Record the user's pick. A no-op under an env pin — the resolver would ignore it. */
    function setMode(next: UiMode) {
      if (envPinned.value) return
      storedMode.value = next
    }

    function toggleMode() {
      setMode(isAdvanced.value ? 'basic' : 'advanced')
    }

    function setNavCollapsed(collapsed: boolean) {
      collapseOverride.value = collapsed
      // Only advanced mode has a persisted rail preference to update: basic mode's default is
      // fixed, so remembering a basic-mode expand would contradict the start-collapsed rule.
      if (isAdvanced.value) railPreference.value = collapsed
    }

    function toggleNav() {
      setNavCollapsed(!navCollapsed.value)
    }

    return {
      mode,
      isAdvanced,
      envPinned,
      storedMode,
      railPreference,
      navCollapsed,
      setMode,
      toggleMode,
      setNavCollapsed,
      toggleNav,
    }
  },
  { persist: { pick: ['storedMode', 'railPreference'] } },
)
