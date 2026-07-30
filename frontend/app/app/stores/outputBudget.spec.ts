import { describe, it, expect } from 'vitest'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * The per-step output-token ceiling rides the shared `StepOptions` bag, so its helpers owe the
 * same normalization every other field in there follows: merge rather than clobber, and drop the
 * whole entry once the bag empties. That last part is what keeps an all-default pipeline from
 * persisting a `step_options` array of empty objects.
 */
describe('pipelines store — per-step output budget', () => {
  it('sets, reads and clears a draft step’s ceiling', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('doc-researcher')
    expect(pipelines.draftMaxOutputTokens(0)).toBeUndefined()

    pipelines.setDraftMaxOutputTokens(0, 24_000)
    expect(pipelines.draftMaxOutputTokens(0)).toBe(24_000)
    expect(pipelines.draftStepOptions[0]).toEqual({ maxOutputTokens: 24_000 })

    // Clearing drops the field and, with the bag now empty, normalizes the entry back to null —
    // so a step back on the inherited budget persists no options at all.
    pipelines.setDraftMaxOutputTokens(0, undefined)
    expect(pipelines.draftMaxOutputTokens(0)).toBeUndefined()
    expect(pipelines.draftStepOptions[0]).toBeNull()
  })

  it('merges with the other options on the step rather than clobbering the bag', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('requirements-review')
    pipelines.toggleDraftAutoRecommend(0)
    expect(pipelines.draftStepOptions[0]).toEqual({ autoRecommend: false })

    pipelines.setDraftMaxOutputTokens(0, 12_000)
    expect(pipelines.draftStepOptions[0]).toEqual({
      autoRecommend: false,
      maxOutputTokens: 12_000,
    })

    // And clearing one field leaves the other standing (the entry stays, since the bag is not empty).
    pipelines.setDraftMaxOutputTokens(0, undefined)
    expect(pipelines.draftStepOptions[0]).toEqual({ autoRecommend: false })
  })

  it('keeps each step’s ceiling independent', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('doc-researcher')
    pipelines.addToDraft('doc-outliner')

    pipelines.setDraftMaxOutputTokens(0, 24_000)
    pipelines.setDraftMaxOutputTokens(1, 10_000)

    expect(pipelines.draftMaxOutputTokens(0)).toBe(24_000)
    expect(pipelines.draftMaxOutputTokens(1)).toBe(10_000)
  })
})
