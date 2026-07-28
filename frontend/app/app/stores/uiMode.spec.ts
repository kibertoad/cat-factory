import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useUiModeStore } from '~/stores/uiMode'
import type { UiMode } from '~/utils/uiMode'

/**
 * Point `runtimeConfig.public.uiMode` at a value and hand back a store built against it.
 * The env value is read ONCE at store setup (it is build-time-baked in a `ssr: false` SPA),
 * so every case needs a fresh Pinia — which is also what proves the read isn't reactive.
 */
function storeWithEnv(uiMode: string | undefined) {
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '', uiMode } }))
  setActivePinia(createPinia())
  return useUiModeStore()
}

describe('useUiModeStore mode resolution', () => {
  beforeEach(() => {
    // The default runtime-config stub carries no `uiMode` at all — the shape a deployment
    // that never set NUXT_PUBLIC_UI_MODE ends up with once Nuxt applies the '' default.
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '', uiMode: '' } }))
  })

  it('boots in basic mode with no env pin and nothing stored', () => {
    const ui = useUiModeStore()
    expect(ui.mode).toBe('basic')
    expect(ui.isAdvanced).toBe(false)
    expect(ui.envPinned).toBe(false)
  })

  it('honours the browser-stored choice when no env pin is present', () => {
    const ui = useUiModeStore()
    ui.setMode('advanced')
    expect(ui.mode).toBe('advanced')
    expect(ui.isAdvanced).toBe(true)
    // Persisted, so a reload restores it (the persist plugin picks `storedMode`).
    expect(ui.storedMode).toBe('advanced')
  })

  it('lets the env pin override a conflicting stored choice, in both directions', () => {
    const pinnedBasic = storeWithEnv('advanced')
    pinnedBasic.storedMode = 'basic'
    expect(pinnedBasic.mode).toBe('advanced')

    const pinnedAdvanced = storeWithEnv('basic')
    pinnedAdvanced.storedMode = 'advanced'
    expect(pinnedAdvanced.mode).toBe('basic')
  })

  it('refuses to record a preference under an env pin', () => {
    const ui = storeWithEnv('basic')
    expect(ui.envPinned).toBe(true)
    ui.setMode('advanced')
    ui.toggleMode()
    // Nothing written: the resolver would ignore it, so persisting it would be a lie.
    expect(ui.storedMode).toBeNull()
    expect(ui.mode).toBe('basic')
  })

  it('ignores an unrecognised env value rather than failing the boot', () => {
    const ui = storeWithEnv('expert')
    expect(ui.envPinned).toBe(false)
    expect(ui.mode).toBe('basic')
    ui.setMode('advanced')
    expect(ui.mode).toBe('advanced')
  })

  it('toggleMode flips between the two tiers', () => {
    const ui = useUiModeStore()
    ui.toggleMode()
    expect(ui.mode).toBe('advanced')
    ui.toggleMode()
    expect(ui.mode).toBe('basic')
  })
})

describe('useUiModeStore navbar collapse', () => {
  beforeEach(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '', uiMode: '' } }))
  })

  it('starts collapsed in basic mode and expanded in advanced mode', () => {
    expect(useUiModeStore().navCollapsed).toBe(true)

    const advanced = storeWithEnv('advanced')
    expect(advanced.navCollapsed).toBe(false)
  })

  it('starts collapsed in basic mode even after an advanced-mode rail preference was stored', () => {
    const ui = useUiModeStore()
    // What a restored persisted state looks like for a user who ran the rail in advanced mode
    // and has since switched back to basic.
    ui.railPreference = true
    ui.storedMode = 'basic'
    expect(ui.navCollapsed).toBe(true)
  })

  it('lets the user expand the rail within a basic-mode session without persisting it', () => {
    const ui = useUiModeStore()
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(false)
    // Basic mode's default is fixed, so the expand is session-only: nothing is remembered.
    expect(ui.railPreference).toBe(false)
  })

  it('remembers an advanced-mode rail choice', () => {
    const ui = storeWithEnv('advanced')
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(true)
    expect(ui.railPreference).toBe(true)
  })

  it('re-derives the collapse from the mode when the user switches tiers', async () => {
    const ui = useUiModeStore()
    // Basic + explicitly expanded, then promoted to advanced: the advanced default (the stored
    // rail preference, here expanded) applies rather than the basic-mode override lingering.
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(false)

    ui.setMode('advanced')
    await nextTick()
    expect(ui.navCollapsed).toBe(false)

    // Collapse it in advanced (persisted), then drop back to basic: basic starts collapsed.
    ui.toggleNav()
    ui.setMode('basic')
    await nextTick()
    expect(ui.navCollapsed).toBe(true)

    // ...and back up to advanced restores the remembered rail.
    ui.setMode('advanced')
    await nextTick()
    expect(ui.navCollapsed).toBe(true)
  })

  it('setNavCollapsed is idempotent', () => {
    const ui = storeWithEnv('advanced')
    ui.setNavCollapsed(true)
    ui.setNavCollapsed(true)
    expect(ui.navCollapsed).toBe(true)
    ui.setNavCollapsed(false)
    expect(ui.navCollapsed).toBe(false)
  })
})

describe('useUiModeStore typing', () => {
  it('exposes the mode as the closed union', () => {
    const ui = useUiModeStore()
    const mode: UiMode = ui.mode
    expect(['basic', 'advanced']).toContain(mode)
  })
})
