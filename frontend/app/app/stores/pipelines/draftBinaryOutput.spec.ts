import { describe, expect, it } from 'vitest'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * The pipeline-builder draft's binary-output selection (`stepOptions.binaryOutput`), the store
 * half of the picker (docs/initiatives/binary-output-foundational-storage.md). Same contract as
 * the skill and variant helpers beside it — merge into the options bag, normalize an emptied bag
 * back to null — plus the one rule specific to this field: an empty `contextServiceIds` is
 * DROPPED rather than persisted, because `[]` and absence are different claims to the agent.
 */
describe('pipelines store — per-step binary-output selection', () => {
  it('sets, reads and clears the selection', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')
    expect(pipelines.draftBinaryOutput(0)).toBeUndefined()

    pipelines.setDraftBinaryOutput(0, { storageServiceId: 'file-storage' })
    expect(pipelines.draftBinaryOutput(0)).toEqual({ storageServiceId: 'file-storage' })
    expect(pipelines.draftStepOptions[0]).toEqual({
      binaryOutput: { storageServiceId: 'file-storage' },
    })

    // Clearing drops the field and, with the bag now empty, normalizes the entry back to null —
    // so a step that never used it persists exactly the shape it always did.
    pipelines.setDraftBinaryOutput(0, undefined)
    expect(pipelines.draftBinaryOutput(0)).toBeUndefined()
    expect(pipelines.draftStepOptions[0]).toBeNull()
  })

  // `[]` reads as "context was considered and rejected", which the brief would then repeat to
  // the agent; absence reads as "no scope service was selected". Only one of those is true.
  it('drops an emptied context list rather than persisting an empty array', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')

    pipelines.setDraftBinaryOutput(0, {
      storageServiceId: 'file-storage',
      contextServiceIds: ['asset-management'],
    })
    expect(pipelines.draftBinaryOutput(0)?.contextServiceIds).toEqual(['asset-management'])

    pipelines.setDraftBinaryOutput(0, { storageServiceId: 'file-storage', contextServiceIds: [] })
    expect(pipelines.draftBinaryOutput(0)).toEqual({ storageServiceId: 'file-storage' })
  })

  // A blank storage id is not a selection: the backend refuses the step either way, so the
  // draft must not carry a half-filled shape that saves and then fails.
  it('treats a blank storage id as no selection at all', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')
    pipelines.setDraftBinaryOutput(0, { storageServiceId: '', contextServiceIds: ['inventory'] })
    expect(pipelines.draftBinaryOutput(0)).toBeUndefined()
    expect(pipelines.draftStepOptions[0]).toBeNull()
  })

  it('merges into the options bag rather than clobbering other per-step options', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')
    pipelines.draftStepOptions[0] = { agentVariantId: 'acme:fast' }

    pipelines.setDraftBinaryOutput(0, { storageServiceId: 'file-storage' })
    expect(pipelines.draftStepOptions[0]).toEqual({
      agentVariantId: 'acme:fast',
      binaryOutput: { storageServiceId: 'file-storage' },
    })

    pipelines.setDraftBinaryOutput(0, undefined)
    expect(pipelines.draftStepOptions[0]).toEqual({ agentVariantId: 'acme:fast' })
  })
})
