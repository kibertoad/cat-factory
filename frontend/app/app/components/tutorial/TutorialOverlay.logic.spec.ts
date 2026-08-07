import { describe, expect, it } from 'vitest'
import {
  boardNodeIdFor,
  focusLeftCard,
  isSafeTargetId,
  isTargetClickAdvance,
  resolveSkip,
  shouldFocusCard,
  stepTargetIds,
  stepTargetSelectors,
  unexpectedlySkippedSteps,
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
  /** A control carrying `id`, with a nested span, mounted so `closest` can walk to it. */
  const control = (id: string) => {
    const el = document.createElement('button')
    el.setAttribute('data-testid', id)
    el.appendChild(document.createElement('span'))
    document.body.appendChild(el)
    return el
  }

  it('advances on a real click on the control, or inside it', () => {
    const el = control('add-task-submit')
    const s = step({ target: 'add-task-submit', advanceOn: 'target-click' })
    expect(isTargetClickAdvance(s, el)).toBe(true)
    expect(isTargetClickAdvance(s, el.firstChild)).toBe(true)
  })

  it('advances on ANY instance of a control the board renders per item', () => {
    // `task-card` / `task-resolve` / `run-step` exist once per board item, and the ring can
    // only sit on one of them. Requiring the click to land on THAT one left a user who
    // clicked the card the step's copy asked for with no way forward — a click-to-advance
    // step renders no Next button.
    control('task-card')
    const second = control('task-card')
    const s = step({ target: 'task-card', advanceOn: 'target-click' })
    expect(isTargetClickAdvance(s, second)).toBe(true)
  })

  it('advances on a fallback anchor too, since either is the control the step named', () => {
    const s = step({ target: 'ui-mode-switcher', altTargets: ['ui-mode-toggle'] })
    expect(
      isTargetClickAdvance({ ...s, advanceOn: 'target-click' }, control('ui-mode-toggle')),
    ).toBe(true)
  })

  it('ignores clicks elsewhere, on a Next-advanced step, or on a non-element', () => {
    const s = step({ target: 'add-task-submit', advanceOn: 'target-click' })
    expect(isTargetClickAdvance(s, control('run-start'))).toBe(false)
    expect(isTargetClickAdvance(s, null)).toBe(false)
    expect(isTargetClickAdvance(s, document.createTextNode('stray'))).toBe(false)
    expect(isTargetClickAdvance(step({ target: 'add-task-submit' }), control('x'))).toBe(false)
    expect(isTargetClickAdvance(null, control('y'))).toBe(false)
  })
})

describe('unexpectedlySkippedSteps', () => {
  const plain = step({ id: 'addTask', target: 'frame-add-task' })
  const branch = step({ id: 'approve', target: 'step-approve', when: () => true })

  it('counts a skipped step whose control simply was not there', () => {
    expect(unexpectedlySkippedSteps(new Set(['addTask']), [plain, branch])).toEqual([plain])
  })

  it('does not count a branch-gated step, whose absence it already declared legitimate', () => {
    // The gates-absent case (a bare install withholds nothing, so BOTH branches of a tour
    // are kept and only one can ever anchor). Reporting that as abridged would put a
    // permanent "you missed some of this" on a tour that showed exactly the right branch.
    expect(unexpectedlySkippedSteps(new Set(['approve']), [plain, branch])).toEqual([])
  })

  it('is empty for a tour that skipped nothing', () => {
    expect(unexpectedlySkippedSteps(new Set(), [plain, branch])).toEqual([])
  })
})

describe('boardNodeIdFor', () => {
  /** A stand-in for the DOM ancestry lookup: `closest` hits when the selector is the one
   * Vue Flow wraps its nodes in, and the hit carries whatever `data-id` we hand it. */
  const el = (nodeId: string | null) => ({
    closest: (selector: string) =>
      selector === '.vue-flow__node' && nodeId !== null
        ? { getAttribute: (name: string) => (name === 'data-id' ? nodeId : null) }
        : null,
  })

  it('reports the node id for an anchor on the board canvas', () => {
    expect(boardNodeIdFor(el('block-42'))).toBe('block-42')
  })

  it('reports none for an anchor outside the canvas, so the caller scrolls it instead', () => {
    // A panel row, a modal button, the sidebar: an ordinary scroll container, where a camera
    // move would do nothing and `scrollIntoView` is the right mechanism.
    expect(boardNodeIdFor(el(null))).toBeNull()
    expect(boardNodeIdFor(null)).toBeNull()
  })

  it('treats an empty data-id as absent', () => {
    // `fitView` over an unknown id silently does nothing, which would look exactly like a
    // reveal that ran — and the step would sit pointing off screen with its budget ticking.
    expect(boardNodeIdFor(el(''))).toBeNull()
  })
})

describe('shouldFocusCard', () => {
  it('takes focus when the tour starts and when the user drives it', () => {
    // The overlay is teleported to the end of `body`, so without this a keyboard user has to
    // tab the whole page to reach Next.
    expect(shouldFocusCard('tour-start')).toBe(true)
    expect(shouldFocusCard('nav-control')).toBe(true)
  })

  it('leaves focus alone when the step advanced because the user clicked the real control', () => {
    // Such a click routinely opens a modal that autofocuses its own first field, and the next
    // step is typically the one telling the user to type in it. Pulling focus back onto the
    // coach mark puts their caret on a tooltip instead of the form the tour just pointed at.
    expect(shouldFocusCard('target-click')).toBe(false)
  })
})

describe('focusLeftCard', () => {
  const card = () => {
    const el = document.createElement('div')
    const next = document.createElement('button')
    el.appendChild(next)
    document.body.appendChild(el)
    return { el, next }
  }

  it('keeps the card focusable while focus is still inside it', () => {
    // Tabbing from the card onto its own Next button must NOT drop `tabindex`: the card would
    // become click-focusable again while the user is still in it, which is the exact state the
    // attribute exists to avoid.
    const { el, next } = card()
    expect(focusLeftCard(el, next)).toBe(false)
    expect(focusLeftCard(el, el)).toBe(false)
  })

  it('treats focus moving to anything outside the card as having left', () => {
    const { el } = card()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    expect(focusLeftCard(el, outside)).toBe(true)
  })

  it('treats focus falling to nothing as having left', () => {
    // The `relatedTarget: null` case is not an edge: it is what happens when the pressed
    // control unmounts under the press, which Back at step 1 does every time.
    const { el } = card()
    expect(focusLeftCard(el, null)).toBe(true)
  })

  it('reports left when there is no card', () => {
    // An unmounted card holds no focus, so the flag must not be left standing.
    expect(focusLeftCard(null, null)).toBe(true)
  })
})
