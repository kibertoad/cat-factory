import { describe, expect, it } from 'vitest'
import { usePipelinesStore } from '~/stores/pipelines'

/**
 * Where a producer-and-companion row pauses for a person. The row folds two steps whose gates mean
 * different things, so the draft writes each one, and switching the companion off must not take
 * the checkpoint that sat after it along with it.
 */
describe('pipelines store: checkpoints on a producer and its companion', () => {
  function architectWithReviewer() {
    const pipelines = usePipelinesStore()
    pipelines.addToDraft('architect')
    pipelines.toggleCompanion(0)
    pipelines.addToDraft('coder')
    expect(pipelines.draft).toEqual(['architect', 'architect-companion', 'coder'])
    return pipelines
  }

  it('gates the producer, the companion, or both, from one row', () => {
    const pipelines = architectWithReviewer()
    const [row] = pipelines.units
    expect(row).toEqual({ index: 0, kind: 'architect', companionIndex: 1 })

    pipelines.setDraftCheckpoints(0, 1, { producer: false, companion: true })
    expect(pipelines.draftGates).toEqual([false, true, false])
    pipelines.setDraftCheckpoints(0, 1, { producer: true, companion: true })
    expect(pipelines.draftGates).toEqual([true, true, false])
  })

  it('moves a checkpoint after the companion onto the producer when the companion goes', () => {
    const pipelines = architectWithReviewer()
    pipelines.setDraftCheckpoints(0, 1, { producer: false, companion: true })
    pipelines.patchDraftGateConfig(1, { approvers: { roles: ['admin'] }, minApprovals: 2 })

    pipelines.toggleCompanion(0)
    expect(pipelines.draft).toEqual(['architect', 'coder'])
    expect(pipelines.draftGates).toEqual([true, false])
    expect(pipelines.draftGateConfig(0)).toEqual({
      approvers: { roles: ['admin'] },
      minApprovals: 2,
    })
  })
})
