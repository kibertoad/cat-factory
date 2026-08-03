import { describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import {
  computeCoachMarkLayout,
  launchActionFor,
  needsReveal,
  resolveTourCatalogue,
  resolveTours,
  sortTours,
  tourState,
  TUTORIAL_ACTION_KEYS,
  TUTORIAL_STATUS_KEYS,
  visibleArea,
} from '~/utils/tutorial'
import type { TutorialRequirement, TutorialStep, TutorialTour } from '~/utils/tutorial'
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

/** A requirement over the one gate field these cases vary. */
const needsAdvanced: TutorialRequirement = {
  id: 'advanced',
  labelKey: 'tutorial.requirements.boardWrite',
  met: (g) => g.advancedMode,
}

const withSteps = (
  id: string,
  steps: TutorialStep[],
  requires?: readonly TutorialRequirement[],
): TutorialTour => ({ ...tour(id, 10), steps, requires })

describe('resolveTours', () => {
  it('drops a tour whose requirements are unmet', () => {
    const tours = [withSteps('a', [step('one')], [needsAdvanced]), withSteps('b', [step('one')])]
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

  it('withholds nothing when no gates service is wired', () => {
    // Dev-open parity, and the case a bare install runs in: with nothing to gate against,
    // a required tour is still offered and its branch steps are not silently thinned.
    const t = withSteps('a', [step('one'), step('two', (g) => g.advancedMode)], [needsAdvanced])
    expect(resolveTours([t], null)[0]?.steps.map((s) => s.id)).toEqual(['one', 'two'])
  })
})

describe('resolveTourCatalogue', () => {
  it('keeps an unavailable tour, saying which requirements are unmet', () => {
    // The whole reason the catalogue resolves rather than filters: a tour dropped from the
    // list is indistinguishable from one this deployment never shipped.
    const t = withSteps('a', [step('one')], [needsAdvanced])
    const [entry] = resolveTourCatalogue([t], gates(false))
    expect(entry?.availability).toBe('blocked')
    expect(entry?.unmet.map((r) => r.id)).toEqual(['advanced'])
  })

  it('reports only the requirements that are actually unmet', () => {
    const met: TutorialRequirement = { id: 'met', labelKey: 'x', met: () => true }
    const t = withSteps('a', [step('one')], [met, needsAdvanced])
    expect(resolveTourCatalogue([t], gates(false))[0]?.unmet.map((r) => r.id)).toEqual(['advanced'])
  })

  it('separates "requirements unmet" from "no step applies here"', () => {
    // Two different facts needing two different reactions: one names something the reader can
    // go and do, the other names nothing at all — telling them to fix it would send them
    // looking for a control that was never missing.
    const t = withSteps('a', [step('advancedOnly', (g) => g.advancedMode)])
    const [entry] = resolveTourCatalogue([t], gates(false))
    expect(entry?.availability).toBe('not-applicable')
    expect(entry?.unmet).toEqual([])
  })

  it('reports a tour that is both blocked and stepless as blocked', () => {
    // Precedence, pinned. A step's `when` reads the same gates the requirements do, so with the
    // requirements unmet the step filter is answering a hypothetical — what would apply on a
    // board this one is by construction not. Calling that `not-applicable` would tell the reader
    // nothing can be done about a tour they can in fact unlock.
    const t = withSteps('a', [step('advancedOnly', (g) => g.advancedMode)], [needsAdvanced])
    const [entry] = resolveTourCatalogue([t], gates(false))
    expect(entry?.availability).toBe('blocked')
    expect(entry?.unmet.map((r) => r.id)).toEqual(['advanced'])
  })

  it('is sorted, and agrees with resolveTours about what is ready', () => {
    const tours = [
      withSteps('c', [step('one')], [needsAdvanced]),
      { ...withSteps('a', [step('one')]), order: 20 },
      { ...withSteps('b', [step('one')]), order: 5 },
    ]
    const catalogue = resolveTourCatalogue(tours, gates(false))
    expect(catalogue.map((e) => e.tour.id)).toEqual(['b', 'c', 'a'])
    expect(resolveTours(tours, gates(false)).map((t) => t.id)).toEqual(
      catalogue.filter((e) => e.availability === 'ready').map((e) => e.tour.id),
    )
  })
})

describe('tourState / launchActionFor', () => {
  const state = (over: Partial<Parameters<typeof tourState>[0]>) =>
    tourState({ active: false, resumable: false, completed: false, ...over })

  it('reports a running tour as in progress, whatever else is true of it', () => {
    expect(state({ active: true, resumable: true, completed: true })).toBe('inProgress')
    expect(launchActionFor('inProgress')).toBe('continue')
  })

  it('prefers a broken-off position over a past completion', () => {
    // Resume beats Completed: a tour taken again and broken off is offered where it stopped,
    // rather than described by the badge it earned last time.
    expect(state({ resumable: true, completed: true })).toBe('paused')
    expect(launchActionFor('paused')).toBe('resume')
  })

  it('falls back to completion, then to untouched', () => {
    expect(state({ completed: true })).toBe('completed')
    expect(launchActionFor('completed')).toBe('restart')
    expect(state({})).toBe('notStarted')
    expect(launchActionFor('notStarted')).toBe('start')
  })
})

describe('the status / action copy tables', () => {
  it('resolves every key against the en catalog', () => {
    // These are the lookups the typed-message-key check cannot see (a key assembled from a
    // state), so a rename would otherwise reach the user as a raw path on a button.
    const lookup = (key: string) =>
      key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en)
    for (const key of [
      ...Object.values(TUTORIAL_STATUS_KEYS),
      ...Object.values(TUTORIAL_ACTION_KEYS),
    ]) {
      expect(typeof lookup(key), key).toBe('string')
    }
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

describe('needsReveal', () => {
  const viewport = { width: 1000, height: 800 }

  it('leaves a fully visible anchor alone', () => {
    expect(needsReveal({ top: 100, left: 100, width: 120, height: 40 }, viewport)).toBe(false)
  })

  it('reveals an anchor scrolled or panned clean off screen', () => {
    // The case the runtime could not see: an element off the viewport still has layout boxes,
    // so it passed the visibility check and the ring was drawn at coordinates nobody can see.
    expect(needsReveal({ top: -400, left: 100, width: 120, height: 40 }, viewport)).toBe(true)
    expect(needsReveal({ top: 100, left: 1400, width: 120, height: 40 }, viewport)).toBe(true)
  })

  it('reveals a small anchor that is only slightly on screen', () => {
    // 25% of its width inside the right edge: enough to have a rect, not enough to point at.
    expect(needsReveal({ top: 100, left: 970, width: 120, height: 40 }, viewport)).toBe(true)
  })

  it('leaves an anchor BIGGER than the viewport alone while it fills the screen', () => {
    // `board-canvas` and `sidebar` can never clear a fraction of their own area, so measuring
    // against that would pan the camera on every step that points at one of them.
    expect(needsReveal({ top: -200, left: -200, width: 2000, height: 1600 }, viewport)).toBe(false)
  })

  it('reveals an oversized anchor that has left the screen anyway', () => {
    expect(needsReveal({ top: -1700, left: 0, width: 2000, height: 1600 }, viewport)).toBe(true)
  })

  it('never reveals a zero-area anchor', () => {
    // There is no position to bring anywhere, and treating it as off-screen would make every
    // degenerate rect trigger a camera move.
    expect(needsReveal({ top: 0, left: 0, width: 0, height: 0 }, viewport)).toBe(false)
  })
})

describe('visibleArea', () => {
  const viewport = { width: 1000, height: 800 }

  it('is the full area when the rect is inside', () => {
    expect(visibleArea({ top: 10, left: 10, width: 100, height: 50 }, viewport)).toBe(5000)
  })

  it('is the clipped area when the rect straddles an edge', () => {
    expect(visibleArea({ top: 10, left: -60, width: 100, height: 50 }, viewport)).toBe(40 * 50)
  })

  it('is zero for a rect with no overlap at all', () => {
    expect(visibleArea({ top: 10, left: 2000, width: 100, height: 50 }, viewport)).toBe(0)
  })
})
