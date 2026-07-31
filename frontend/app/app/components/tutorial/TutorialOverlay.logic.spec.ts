import { describe, expect, it } from 'vitest'
import {
  isSafeTargetId,
  isTargetClickAdvance,
  resolveSkip,
  stepTargetIds,
  stepTargetSelectors,
  tourWasAbridged,
  waitBudgetMs,
} from '~/components/tutorial/TutorialOverlay.logic'
import { DEFAULT_TARGET_WAIT_MS } from '~/utils/tutorial'
import type { TutorialStep } from '~/utils/tutorial'

const step = (over: Partial<TutorialStep> = {}): TutorialStep => ({
  id: 'a-step',
  titleKey: 'tutorial.tours.x.steps.a.title',
  bodyKey: 'tutorial.tours.x.steps.a.body',
  ...over,
})

describe('stepTargetIds', () => {
  it('lists the target then its fallbacks, in order', () => {
    expect(
      stepTargetIds(step({ target: 'frame-add-task', altTargets: ['frame-add-task-empty'] })),
    ).toEqual(['frame-add-task', 'frame-add-task-empty'])
  })

  it('is empty for an untargeted (centered) step', () => {
    expect(stepTargetIds(step())).toEqual([])
  })
})

describe('isSafeTargetId', () => {
  it('accepts the kebab-case ids the repo actually uses', () => {
    for (const id of ['task-card', 'add-task-submit', 'board-fit-view', 'nav-tutorial', 'h2'])
      expect(isSafeTargetId(id), id).toBe(true)
  })

  it('rejects anything that could end up inside a selector as syntax', () => {
    for (const id of ['od"d', "od'd", 'back\\slash', 'a b', 'a]b', 'Upper', ''])
      expect(isSafeTargetId(id), id).toBe(false)
  })
})

describe('stepTargetSelectors', () => {
  it('builds the data-testid selectors, target first then fallbacks', () => {
    const s = step({ target: 'frame-add-task', altTargets: ['frame-add-task-empty'] })
    expect(stepTargetSelectors(s)).toEqual([
      '[data-testid="frame-add-task"]',
      '[data-testid="frame-add-task-empty"]',
    ])
  })

  it('drops a malformed id rather than building a selector that could throw', () => {
    // A tour is DATA a consumer deployment authors, so an id arrives from outside this
    // package. A bad one must degrade to "anchor not found" (a skipped step) — NOT to a
    // SyntaxError raised out of the 150ms tracking interval, several times a second.
    const s = step({ target: 'od"d', altTargets: ['task-card'] })
    expect(stepTargetSelectors(s)).toEqual(['[data-testid="task-card"]'])
    for (const selector of stepTargetSelectors(s))
      expect(() => document.querySelector(selector)).not.toThrow()
  })

  it('is empty for an untargeted step', () => {
    expect(stepTargetSelectors(step())).toEqual([])
  })
})

describe('waitBudgetMs', () => {
  it('defaults, and honours a step that waits on a just-opened modal', () => {
    expect(waitBudgetMs(step())).toBe(DEFAULT_TARGET_WAIT_MS)
    expect(waitBudgetMs(step({ waitForTargetMs: 8000 }))).toBe(8000)
  })
})

describe('resolveSkip', () => {
  it('continues forward past a missing anchor', () => {
    expect(resolveSkip(1, 'forward', 4)).toEqual({ kind: 'move', index: 2 })
  })

  it('completes the tour when the last step is the one that went missing', () => {
    expect(resolveSkip(3, 'forward', 4)).toEqual({ kind: 'complete' })
  })

  it('keeps travelling BACK when the user is stepping backwards', () => {
    // Otherwise Back onto a step this deployment does not render bounces the user
    // straight forward again, making the button unusable exactly where it is needed.
    expect(resolveSkip(2, 'back', 4)).toEqual({ kind: 'move', index: 1 })
  })

  it('reverses to forward rather than pinning on the first step', () => {
    expect(resolveSkip(0, 'back', 4)).toEqual({ kind: 'move', index: 1 })
  })

  it('completes a single-step tour whose only anchor never appeared', () => {
    expect(resolveSkip(0, 'back', 1)).toEqual({ kind: 'complete' })
    expect(resolveSkip(0, 'forward', 1)).toEqual({ kind: 'complete' })
  })
})

describe('isTargetClickAdvance', () => {
  const el = document.createElement('button')
  const child = document.createElement('span')
  el.appendChild(child)

  it('advances on a real click on the highlighted control, or inside it', () => {
    const s = step({ target: 'add-task-submit', advanceOn: 'target-click' })
    expect(isTargetClickAdvance(s, el, el)).toBe(true)
    expect(isTargetClickAdvance(s, el, child)).toBe(true)
  })

  it('ignores clicks elsewhere, on a Next-advanced step, or with no anchor', () => {
    const s = step({ target: 'add-task-submit', advanceOn: 'target-click' })
    expect(isTargetClickAdvance(s, el, document.createElement('div'))).toBe(false)
    expect(isTargetClickAdvance(s, null, el)).toBe(false)
    expect(isTargetClickAdvance(step({ target: 'x' }), el, el)).toBe(false)
    expect(isTargetClickAdvance(null, el, el)).toBe(false)
  })
})

describe('tourWasAbridged', () => {
  it('is true once any step was skipped, so the finish card can say so', () => {
    expect(tourWasAbridged(new Set())).toBe(false)
    expect(tourWasAbridged(new Set(['addTask']))).toBe(true)
  })
})
