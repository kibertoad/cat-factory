import { describe, expect, it } from 'vitest'
import { computeCoachMarkLayout, resolveTours, sortTours } from '~/utils/tutorial'
import type { TutorialStep, TutorialTour } from '~/utils/tutorial'
import type { NavGates } from '~/modular/nav-contributions'

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

/**
 * Only the fields the predicates below read; the gate object is otherwise irrelevant to
 * `resolveTours`, which never looks at it itself.
 */
const gates = (advanced: boolean) => ({ advancedMode: advanced }) as NavGates

const step = (id: string, when?: TutorialStep['when']): TutorialStep => ({
  id,
  titleKey: `t.${id}`,
  bodyKey: `b.${id}`,
  when,
})

const withSteps = (id: string, steps: TutorialStep[], when?: TutorialTour['when']): TutorialTour =>
  ({ ...tour(id, 10), steps, when }) as TutorialTour

describe('resolveTours', () => {
  it('drops a tour its own `when` rejects', () => {
    const tours = [
      withSteps('a', [step('one')], (g) => g.advancedMode),
      withSteps('b', [step('one')]),
    ]
    expect(resolveTours(tours, gates(false)).map((t) => t.id)).toEqual(['b'])
  })

  it('drops the steps their own `when` rejects, keeping the tour', () => {
    const t = withSteps('a', [step('always'), step('advancedOnly', (g) => g.advancedMode)])
    const [resolved] = resolveTours([t], gates(false))
    expect(resolved?.steps.map((s) => s.id)).toEqual(['always'])
  })

  it('drops a tour left with no steps at all', () => {
    // Otherwise the launch prompt offers a tour that ends the instant it starts: the overlay
    // has no step to render, so Start looks like a dead button.
    const t = withSteps('a', [step('advancedOnly', (g) => g.advancedMode)])
    expect(resolveTours([t], gates(false))).toEqual([])
  })

  it('returns the original tour object when nothing was dropped', () => {
    // Identity matters: the prompt lists tours by reference, so minting a new object on
    // every gate read would re-render the list on flips that changed nothing about it.
    const t = withSteps('a', [step('one')])
    expect(resolveTours([t], gates(true))[0]).toBe(t)
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
