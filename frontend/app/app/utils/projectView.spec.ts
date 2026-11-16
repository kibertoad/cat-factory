import { describe, expect, it } from 'vitest'
import { formatBytes, outcomeStorageState } from '~/utils/projectView'

describe('outcome storage', () => {
  it('tells an unreadable offloaded body apart from a small inline one', () => {
    expect(outcomeStorageState({ placement: 'inline', bytes: 12, readable: true })).toBe('inline')
    expect(outcomeStorageState({ placement: 'offloaded', bytes: 9e5, readable: false })).toBe(
      'unavailable',
    )
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})
