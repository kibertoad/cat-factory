import type { BinaryOutputConfig } from '@cat-factory/contracts'
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

  // The store copies what it is handed rather than a hand list of field names, so the formats,
  // generation options and comparison a step carries survive an edit to any other field (#2408).
  it('keeps every field of the selection through an edit', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')
    const full: BinaryOutputConfig = {
      storageServiceId: 'file-storage',
      contextServiceIds: ['asset-management'],
      generatorIds: ['nano-banana'],
      modalities: ['image'],
      mediaTypes: ['image/png'],
      generation: { seed: 42, negativePrompt: 'text' },
      comparison: { perGenerator: 2 },
    }
    pipelines.draftStepOptions[0] = { binaryOutput: full }

    pipelines.setDraftBinaryOutput(0, { ...full, contextServiceIds: ['inventory'] })
    expect(pipelines.draftBinaryOutput(0)).toEqual({ ...full, contextServiceIds: ['inventory'] })
  })

  // `mediaTypes` gets the empty-list rule the other lists have. An empty comparison object is a
  // comparison switched on with its defaults, so it is kept.
  it('drops an emptied format list and keeps an empty comparison', () => {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('coder')
    pipelines.setDraftBinaryOutput(0, {
      storageServiceId: 'file-storage',
      mediaTypes: [],
      comparison: {},
    })
    expect(pipelines.draftBinaryOutput(0)).toEqual({
      storageServiceId: 'file-storage',
      comparison: {},
    })
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
