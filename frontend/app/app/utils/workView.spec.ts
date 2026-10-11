import { describe, expect, it } from 'vitest'
import { DEFAULT_WORK_VIEW, isWorkView } from '~/utils/workView'

describe('isWorkView', () => {
  it('accepts the two views and nothing else', () => {
    expect(isWorkView('queue')).toBe(true)
    expect(isWorkView('board')).toBe(true)
    // A retired or hand-edited persisted value is not a view, so the store falls back.
    expect(isWorkView('setup')).toBe(false)
    expect(isWorkView(null)).toBe(false)
  })

  it('lands a person who has not chosen on the queue', () => {
    expect(DEFAULT_WORK_VIEW).toBe('queue')
  })
})
