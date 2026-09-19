import { describe, expect, it } from 'vitest'
import { useThemeStore } from '~/stores/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '~/utils/theme/builtins'

describe('theme store', () => {
  it('boots on the default built-in and lists the built-ins first', () => {
    const store = useThemeStore()
    expect(store.current).toBe(DEFAULT_THEME_ID)
    expect(store.active.id).toBe(DEFAULT_THEME_ID)
    expect(store.themes.slice(0, BUILTIN_THEMES.length)).toEqual(BUILTIN_THEMES)
    expect(store.isCustom).toBe(false)
  })

  it('selects only a theme it knows', () => {
    const store = useThemeStore()
    store.select('mono')
    expect(store.active.name).toBe('Mono')
    store.select('nope')
    expect(store.current).toBe('mono')
  })

  it('stores an imported document under a name and switches to it', () => {
    const store = useThemeStore()
    const theme = store.addCustom('  Ocean ', { version: 1, colors: { primary: 'cyan' } })
    expect(theme.name).toBe('Ocean')
    expect(store.current).toBe(theme.id)
    expect(store.isCustom).toBe(true)
    expect(store.active.doc.colors?.primary).toBe('cyan')
  })

  it('names an unnamed import after its position', () => {
    const store = useThemeStore()
    expect(store.addCustom('', { version: 1 }).name).toBe('Theme 1')
    expect(store.addCustom('   ', { version: 1 }).name).toBe('Theme 2')
  })

  it('disambiguates a name a built-in or an earlier import already uses', () => {
    const store = useThemeStore()
    expect(store.addCustom('Mono', { version: 1 }).name).toBe('Mono (2)')
    expect(store.addCustom('mono', { version: 1 }).name).toBe('mono (3)')
    expect(store.addCustom('Ocean', { version: 1 }).name).toBe('Ocean')
    expect(store.addCustom('Ocean', { version: 1 }).name).toBe('Ocean (2)')
  })

  it('falls back to the default when the active custom theme is removed or was never restored', () => {
    const store = useThemeStore()
    const theme = store.addCustom('Gone', { version: 1 })
    store.removeCustom(theme.id)
    expect(store.current).toBe(DEFAULT_THEME_ID)
    expect(store.custom).toEqual([])

    // A persisted pick naming a theme that no longer exists resolves to a real document.
    store.current = 'custom-stale'
    expect(store.active.id).toBe(DEFAULT_THEME_ID)
  })
})
