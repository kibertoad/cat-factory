import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUiRoleStore } from '~/stores/uiRole'
import { DEFAULT_RAIL_COLLAPSED, parseUiMode, resolveUiMode, type UiMode } from '~/utils/uiMode'

/**
 * The interface tier (`basic` / `advanced`) and the side-navbar collapse state.
 *
 * Mode resolution is `role surface → env → browser-stored → basic` (see `utils/uiMode.ts`); the
 * role is the ceiling, so an `intake` role renders basic whatever the other two say. The env value
 * is `runtimeConfig.public.uiMode`, i.e. `NUXT_PUBLIC_UI_MODE`: the SPA is `ssr: false`, so
 * — exactly like `apiBase` — it is baked in at build time and cannot change while the app
 * is loaded. It is therefore read ONCE here rather than tracked reactively. Only the user's
 * own choice is persisted, so a deployment that later drops its env pin falls back to
 * whatever the user last picked instead of to the default.
 *
 * The collapse state is a PER-TIER preference (`railCollapsed`), not a single boolean. The two
 * tiers want different resting states — basic opens railed, advanced expanded — so one shared
 * flag can only serve one of them: it would either override the other tier's default or throw
 * away the user's choice on every switch. Keying the preference by tier gives each its own
 * default (`DEFAULT_RAIL_COLLAPSED`) AND its own memory, so switching tiers restores what that
 * tier last looked like and neither has to forget. That is also why there is no watcher here:
 * the collapse follows `mode` because it is indexed by it, not because something resets on
 * change.
 */
export const useUiModeStore = defineStore(
  'uiMode',
  () => {
    const envMode = parseUiMode(useRuntimeConfig().public.uiMode)

    /** The user's explicit pick, persisted. `null` until they choose one. */
    const storedMode = ref<UiMode | null>(null)
    /** The rail state each tier was last left in, persisted. Seeded from the per-tier defaults. */
    const railCollapsed = ref<Record<UiMode, boolean>>({ ...DEFAULT_RAIL_COLLAPSED })

    // The role's surface caps the tier (see `resolveUiMode`): an `intake` role renders basic
    // whatever the env pin or the stored choice says, so every `isAdvanced` reader in the app
    // agrees with the narrowed nav without restating the role.
    const uiRole = useUiRoleStore()
    const mode = computed<UiMode>(() => resolveUiMode(envMode, storedMode.value, uiRole.surface))
    const isAdvanced = computed(() => mode.value === 'advanced')
    /** Pinned by the deployment: the switcher is read-only, since a write would be ignored. */
    const envPinned = computed(() => envMode !== null)

    // `?? the default` because the restored value is untrusted input, exactly like the env
    // string: a persisted blob written by an older build (or hand-edited) can be missing this
    // tier's key, and a rail stuck on `undefined` would render as expanded in basic mode.
    const navCollapsed = computed(
      () => railCollapsed.value[mode.value] ?? DEFAULT_RAIL_COLLAPSED[mode.value],
    )

    /**
     * Record the user's pick. A no-op under an env pin — the resolver would ignore it.
     *
     * This guard is hygiene, not the invariant. `storedMode` is returned from the store because
     * a setup store can only persist what it returns (as in `auth`, `accounts`, `workspace`), so
     * a caller CAN write it directly and skip this check. That is harmless by construction:
     * `mode` runs `resolveUiMode(env, stored)`, which consults the env pin FIRST, so a direct
     * write can leave a stale persisted value but can never change the tier under a pin. The
     * "env pin wins, in both directions" case above is what actually pins that.
     */
    function setMode(next: UiMode) {
      if (envPinned.value) return
      storedMode.value = next
    }

    function toggleMode() {
      setMode(isAdvanced.value ? 'basic' : 'advanced')
    }

    /** Remember the rail state for the CURRENT tier; the other tier keeps its own. */
    function setNavCollapsed(collapsed: boolean) {
      railCollapsed.value = { ...railCollapsed.value, [mode.value]: collapsed }
    }

    function toggleNav() {
      setNavCollapsed(!navCollapsed.value)
    }

    return {
      mode,
      isAdvanced,
      envPinned,
      storedMode,
      railCollapsed,
      navCollapsed,
      setMode,
      toggleMode,
      setNavCollapsed,
      toggleNav,
    }
  },
  { persist: { pick: ['storedMode', 'railCollapsed'] } },
)
