import { describe, expect, it } from 'vitest'
import { useStepProse } from './useStepProse'

const DOC = ['# Plan', '', 'Intro.', '', '## Phase 1', '', 'First.', '', '## Phase 2', ''].join(
  '\n',
)

/**
 * A fake measurable element: the scroll-spy only ever reads `getBoundingClientRect().top`, so
 * the vertical position is the whole of what a section is to it.
 */
function sectionAt(top: number): HTMLElement {
  return { getBoundingClientRect: () => ({ top }) } as unknown as HTMLElement
}

describe('useStepProse scroll-spy', () => {
  /**
   * The reader's own layout: a details card ahead of the prose, which the consumer registers.
   */
  it('tracks the last anchor above the fold, lead section included', () => {
    const prose = useStepProse(() => DOC)
    prose.scrollEl.value = sectionAt(0)
    const [first, second] = prose.tocSections.value
    prose.sectionEls['step-details'] = sectionAt(-200)
    prose.sectionEls[first!.id] = sectionAt(-100)
    prose.sectionEls[second!.id] = sectionAt(400)

    prose.onScroll()
    expect(prose.activeId.value).toBe(first!.id)

    // Scrolling on past the second heading moves the highlight to it.
    prose.sectionEls[second!.id] = sectionAt(20)
    prose.onScroll()
    expect(prose.activeId.value).toBe(second!.id)
  })

  /**
   * The regression this option exists for. A consumer that renders the document ALONE (the
   * initiative tracker's plan-approval rail) never registers a lead anchor, and the spy walks
   * anchors in document order and stops at the first one it cannot measure — so with the lead
   * anchor hardcoded it stopped immediately, pinning `activeId` to a section that does not
   * exist. Nothing threw; the ToC simply never highlighted anything, and any click-to-navigate
   * highlight was wiped by the scroll event the smooth scroll itself fires.
   */
  it('tracks sections when the consumer renders no lead anchor', () => {
    const prose = useStepProse(() => DOC, { leadAnchorId: null })
    prose.scrollEl.value = sectionAt(0)
    const [first, second] = prose.tocSections.value
    prose.sectionEls[first!.id] = sectionAt(-100)
    prose.sectionEls[second!.id] = sectionAt(400)

    prose.onScroll()
    expect(prose.activeId.value).toBe(first!.id)
  })

  it('starts on the lead anchor, or on nothing when there is none', () => {
    expect(useStepProse(() => DOC).activeId.value).toBe('step-details')
    expect(useStepProse(() => DOC, { leadAnchorId: null }).activeId.value).toBe('')
  })

  it('re-seeds the active anchor on reset', () => {
    const prose = useStepProse(() => DOC, { leadAnchorId: null })
    prose.activeId.value = 'somewhere'
    prose.reset()
    expect(prose.activeId.value).toBe('')
  })
})
