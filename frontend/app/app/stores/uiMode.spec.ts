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

  it('ignores an unrecognised RESTORED value on the same terms as the env one', () => {
    // `storedMode`'s type says what `setMode` writes, not what the persistence plugin
    // rehydrated: an older build's blob (or a hand-edited one) arrives typed as a `UiMode`.
    // Left unparsed it resolves to neither tier, and `isAdvanced` then answers a question
    // about a value that is not a tier at all.
    const ui = useUiModeStore()
    ui.storedMode = 'expert' as UiMode
    expect(ui.mode).toBe('basic')
    expect(ui.isAdvanced).toBe(false)
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

  it('remembers the rail choice in EITHER tier, across a reload', () => {
    // The persisted shape is per-tier, so an expand in basic is remembered just as an advanced
    // one is — the default is what differs between the tiers, not whether a choice sticks.
    const ui = useUiModeStore()
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(false)
    expect(ui.railCollapsed.basic).toBe(false)

    const advanced = storeWithEnv('advanced')
    advanced.toggleNav()
    expect(advanced.navCollapsed).toBe(true)
    expect(advanced.railCollapsed.advanced).toBe(true)
  })

  it('keeps each tier’s rail state independent across a switch', async () => {
    const ui = useUiModeStore()
    // Expand in basic, then collapse in advanced: neither choice may leak into the other tier.
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(false)

    ui.setMode('advanced')
    await nextTick()
    expect(ui.navCollapsed).toBe(false) // advanced's own default
    ui.toggleNav()
    expect(ui.navCollapsed).toBe(true)

    ui.setMode('basic')
    await nextTick()
    expect(ui.navCollapsed).toBe(false) // the basic expand survived the round trip

    ui.setMode('advanced')
    await nextTick()
    expect(ui.navCollapsed).toBe(true)
  })

  it('falls back to the tier default when the restored preference is missing a key', () => {
    // A persisted blob from an older build (or a hand-edited cookie) can omit a tier; a rail
    // stuck on `undefined` would render expanded, which is wrong for basic.
    const ui = useUiModeStore()
    ui.railCollapsed = {} as Record<UiMode, boolean>
    expect(ui.navCollapsed).toBe(true)
    ui.setMode('advanced')
    expect(ui.navCollapsed).toBe(false)
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
