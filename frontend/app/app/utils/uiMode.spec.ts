import { describe, expect, it } from 'vitest'
import { DEFAULT_UI_MODE, parseUiMode, resolveUiMode, showOverrideField, UI_MODES } from './uiMode'

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
  })

  it('caps an intake role at basic, above BOTH the env pin and the stored choice', () => {
    // The role is a ceiling rather than another preference: an `intake` surface is offered the
    // delivery loop and none of the platform configuration behind it, which is what the advanced
    // tier is made of. So it wins over the env pin too, the one layer nothing else overrides.
    expect(resolveUiMode('advanced', 'advanced', 'intake')).toBe('basic')
    expect(resolveUiMode(null, 'advanced', 'intake')).toBe('basic')
    // A full-surface role changes nothing, which is what the default argument encodes for every
    // caller that has no role to hand (the pure-logic callers and the specs above).
    expect(resolveUiMode('advanced', null, 'full')).toBe('advanced')
    expect(resolveUiMode(null, 'advanced', 'full')).toBe('advanced')
  })
})

describe('showOverrideField', () => {
  it('shows every override control in advanced mode, set or not', () => {
    expect(showOverrideField(true)).toBe(true)
    expect(showOverrideField(true, null)).toBe(true)
    expect(showOverrideField(true, 'preset_1')).toBe(true)
  })

  it('hides an unset override in basic mode', () => {
    // The three shapes an unset override arrives in: absent, explicitly null, or the empty
    // string a cleared picker writes. All mean "inherit the default", so nothing is concealed.
    for (const unset of [undefined, null, '']) expect(showOverrideField(false, unset)).toBe(false)
    expect(showOverrideField(false)).toBe(false)
  })

  it('reveals a SET override in basic mode so it stays visible and clearable', () => {
    // The regression this guards: a block that already carries an override would otherwise run
    // on settings a basic-mode user can neither see nor clear.
    expect(showOverrideField(false, 'policy_strict')).toBe(true)
    expect(showOverrideField(false, true)).toBe(true)
  })

  it('treats `false` as a real override, not as absence', () => {
    // `technical: false` means "business task" — an explicit choice that must NOT be read as
    // unset, which a plain truthiness check would get wrong.
    expect(showOverrideField(false, false)).toBe(true)
  })

  it('reveals a multi-value group when any one of its values is set', () => {
    // The tracker-writeback group edits three tri-states behind one heading.
    expect(showOverrideField(false, null, null, null)).toBe(false)
    expect(showOverrideField(false, null, false, null)).toBe(true)
    expect(showOverrideField(false, null, null, true)).toBe(true)
  })
})
