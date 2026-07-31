import { describe, expect, it } from 'vitest'
import { computeCoachMarkLayout, sortTours } from '~/utils/tutorial'
import type { TutorialTour } from '~/utils/tutorial'

const tour = (id: string, order: number): TutorialTour => ({
  id,
  order,
  titleKey: `tutorial.tours.${id}.title`,
  descriptionKey: `tutorial.tours.${id}.description`,
  steps: [],
})

describe('sortTours', () => {
  it('orders by `order`, breaking ties on id, without mutating the input', () => {
    const input = [tour('c', 20), tour('b', 10), tour('a', 20)]
    const sorted = sortTours(input)
    expect(sorted.map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(input.map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })
})

const viewport = { width: 1000, height: 800 }
const tooltip = { width: 300, height: 150 }

describe('computeCoachMarkLayout', () => {
  it('centers when there is no anchor (intro / wrap-up steps)', () => {
    const layout = computeCoachMarkLayout(null, tooltip, viewport)
    expect(layout.placement).toBe('center')
    expect(layout.left).toBe((1000 - 300) / 2)
    expect(layout.top).toBe((800 - 150) / 2)
  })

  it('honours a preferred side that fits', () => {
    const target = { top: 400, left: 500, width: 100, height: 40 }
    const layout = computeCoachMarkLayout(target, tooltip, viewport, 'top')
    expect(layout.placement).toBe('top')
    expect(layout.top).toBe(400 - 12 - 150)
    // Cross-axis centered on the anchor.
    expect(layout.left).toBe(500 + 50 - 150)
  })

  it('falls back when the preferred side has no room', () => {
    // Anchor at the very top: 'top' can't fit a 150px card, so bottom wins.
    const target = { top: 10, left: 500, width: 100, height: 40 }
    const layout = computeCoachMarkLayout(target, tooltip, viewport, 'top')
    expect(layout.placement).toBe('bottom')
    expect(layout.top).toBe(10 + 40 + 12)
  })

  it('clamps the cross-axis to the viewport instead of overflowing', () => {
    // Anchor hugging the left edge: centering would push the card off-screen.
    const target = { top: 400, left: 0, width: 40, height: 40 }
    const layout = computeCoachMarkLayout(target, tooltip, viewport, 'bottom')
    expect(layout.placement).toBe('bottom')
    expect(layout.left).toBe(8)
  })

  it('degrades to a clamped bottom position when no side fits at all', () => {
    // A viewport smaller than the card in every direction around the anchor.
    const tinyViewport = { width: 320, height: 200 }
    const target = { top: 80, left: 100, width: 120, height: 40 }
    const layout = computeCoachMarkLayout(target, tooltip, tinyViewport, 'right')
    expect(layout.placement).toBe('bottom')
    // Clamped inside the viewport: overlap beats disappearing off-screen.
    expect(layout.top).toBe(200 - 150 - 8)
    expect(layout.left).toBe(10)
  })
})
