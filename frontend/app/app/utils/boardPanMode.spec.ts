import { describe, it, expect } from 'vitest'
import { boardPanMode } from './boardPanMode'

describe('boardPanMode', () => {
  it('widens to `true` when the surface can be touched (one-finger pan)', () => {
    // The whole point of the fix: a touch `touchstart` has no `event.button`, so the
    // `[0, 2]` button list rejects it and single-finger panning is dead. `true` is the
    // only form Vue Flow's d3-zoom filter accepts for a button-less touch.
    expect(boardPanMode(true)).toBe(true)
  })

  it('keeps the precise-pointer button list (left/right-drag, never middle) on mouse', () => {
    expect(boardPanMode(false)).toEqual([0, 2])
    // Middle-drag (button 1) must never pan.
    expect(boardPanMode(false)).not.toContain(1)
  })
})
