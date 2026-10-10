import { describe, expect, it } from 'vitest'
import { deepFreeze } from './deep-freeze.logic.js'

describe('deepFreeze', () => {
  it('freezes nested objects and arrays, not just the root', () => {
    // The shallow freeze is the trap: a shipped definition's arrays are the half a reader gets a
    // live reference to, so freezing only the root leaves the reachable-and-mutable part untouched.
    const value = deepFreeze({ id: 'a', tags: ['x'], contract: { body: 'text' } })

    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.tags)).toBe(true)
    expect(Object.isFrozen(value.contract)).toBe(true)
  })

  it('returns the SAME reference, which is the whole point of using it on shared data', () => {
    const value = { id: 'a' }
    expect(deepFreeze(value)).toBe(value)
  })

  it('leaves primitives and null alone rather than throwing', () => {
    expect(deepFreeze(null)).toBeNull()
    expect(deepFreeze(7)).toBe(7)
    expect(deepFreeze('text')).toBe('text')
  })

  it('terminates on a cycle', () => {
    const value: { self?: unknown } = {}
    value.self = value

    expect(() => deepFreeze(value)).not.toThrow()
    expect(Object.isFrozen(value)).toBe(true)
  })
})
