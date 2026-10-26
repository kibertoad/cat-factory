import { describe, it, expect } from 'vitest'
import { knownTab } from './tabs'

describe('knownTab', () => {
  const items = [{ value: 'repos' }, { value: 'pulls' }] as const

  it('returns the value when it names an item', () => {
    expect(knownTab(items, 'pulls')).toBe('pulls')
  })

  it('refuses the index UTabs falls back to for an item with no value', () => {
    expect(knownTab(items, '0')).toBeUndefined()
    expect(knownTab(items, 0)).toBeUndefined()
  })
})
