import { describe, expect, it } from 'vitest'
import { useThemeStore } from '~/stores/theme'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from '~/utils/theme/builtins'

describe('theme store', () => {
  it('boots on the default built-in and lists the built-ins first', () => {
    const store = useThemeStore()
    expect(store.current).toBe(DEFAULT_THEME_ID)
    expect(store.active.id).toBe(DEFAULT_THEME_ID)
    expect(store.themes.slice(0, BUILTIN_THEMES.length)).toEqual(BUILTIN_THEMES)
  })

  it('selects only a theme it knows', () => {
    const store = useThemeStore()
    store.select('mono')
    expect(store.active.name).toBe('Mono')
    store.select('nope')
    expect(store.current).toBe('mono')
  })

  it('falls back to the default when the persisted pick names a theme that no longer exists', () => {
    const store = useThemeStore()
    store.current = 'renamed-away'
    expect(store.active.id).toBe(DEFAULT_THEME_ID)
  })
})
