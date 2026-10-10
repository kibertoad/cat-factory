import { describe, expect, it } from 'vitest'
import { isHomeView, parsePreviewParam } from '~/utils/homePreview'

describe('parsePreviewParam', () => {
  it('turns the preview on for the documented value and the obvious spellings', () => {
    for (const v of ['queue', 'on', '1', 'true', ' Queue '])
      expect(parsePreviewParam(v), v).toBe(true)
  })

  it('turns it off', () => {
    for (const v of ['off', '0', 'false', 'board']) expect(parsePreviewParam(v), v).toBe(false)
  })

  it('does nothing for an absent or unknown value, rather than guessing', () => {
    expect(parsePreviewParam(null)).toBeNull()
    expect(parsePreviewParam('maybe')).toBeNull()
  })
})

describe('isHomeView', () => {
  it('accepts the three views and nothing else', () => {
    expect(['queue', 'board', 'setup'].every(isHomeView)).toBe(true)
    expect(isHomeView('inbox')).toBe(false)
    expect(isHomeView(undefined)).toBe(false)
  })
})
