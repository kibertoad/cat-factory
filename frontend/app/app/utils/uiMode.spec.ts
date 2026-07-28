import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_MODE, parseUiMode, resolveUiMode, UI_MODES } from './uiMode'

describe('parseUiMode', () => {
  it('accepts every known mode, case- and whitespace-insensitively', () => {
    for (const mode of UI_MODES) {
      expect(parseUiMode(mode)).toBe(mode)
      expect(parseUiMode(` ${mode.toUpperCase()} `)).toBe(mode)
    }
  })

  it('reports no opinion for an unset / unrecognised / non-string value', () => {
    // '' is what `runtimeConfig.public.uiMode` carries when NUXT_PUBLIC_UI_MODE is unset, so
    // it MUST read as "no env pin" rather than as an invalid mode.
    for (const raw of ['', '   ', 'expert', 'Basic mode', undefined, null, 1, {}]) {
      expect(parseUiMode(raw)).toBeNull()
    }
  })
})

describe('resolveUiMode', () => {
  it('lets the env pin win over the stored choice', () => {
    expect(resolveUiMode('basic', 'advanced')).toBe('basic')
    expect(resolveUiMode('advanced', 'basic')).toBe('advanced')
  })

  it('falls back to the stored choice, then to the default', () => {
    expect(resolveUiMode(null, 'advanced')).toBe('advanced')
    expect(resolveUiMode(null, null)).toBe(DEFAULT_UI_MODE)
    expect(DEFAULT_UI_MODE).toBe('basic')
  })
})
