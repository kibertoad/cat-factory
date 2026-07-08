import { describe, it, expect } from 'vitest'
import type { InitiativeItem, InitiativePhase } from '~/types/domain'
import { pendingCheckpointPhase } from './initiative'

// `pendingCheckpointPhase` mirrors the backend `pendingCheckpoint` (orchestration
// `initiative.logic.ts`); these pin the same ordering/edge cases the loop pauses on, so the
// tracker window's live banner + phase badges can't drift from the engine's decision.

const phase = (over: Partial<InitiativePhase> & { id: string }): InitiativePhase => ({
  title: over.id,
  goal: '',
  ...over,
})

const item = (id: string, phaseId: string, status: InitiativeItem['status']): InitiativeItem => ({
  id,
  phaseId,
  title: id,
  description: '',
  dependsOn: [],
  status,
})

describe('pendingCheckpointPhase', () => {
  it('returns null when no phase is flagged checkpoint', () => {
    const phases = [phase({ id: 'p1' })]
    const items = [item('a', 'p1', 'done')]
    expect(pendingCheckpointPhase(phases, items)).toBeNull()
  })

  it('returns a checkpoint phase once all its items settle (done/skipped)', () => {
    const phases = [phase({ id: 'p1', checkpoint: true })]
    const items = [item('a', 'p1', 'done'), item('b', 'p1', 'skipped')]
    expect(pendingCheckpointPhase(phases, items)?.id).toBe('p1')
  })

  it('does not fire while a checkpoint phase still holds a non-terminal item', () => {
    const phases = [phase({ id: 'p1', checkpoint: true })]
    expect(pendingCheckpointPhase(phases, [item('a', 'p1', 'in_progress')])).toBeNull()
    // A BLOCKED item (a halted phase) is non-terminal too, so the checkpoint waits.
    expect(pendingCheckpointPhase(phases, [item('a', 'p1', 'blocked')])).toBeNull()
  })

  it('never re-fires a cleared checkpoint', () => {
    const phases = [phase({ id: 'p1', checkpoint: true, checkpointClearedAt: 123 })]
    expect(pendingCheckpointPhase(phases, [item('a', 'p1', 'done')])).toBeNull()
  })

  it('skips an item-less checkpoint phase (nothing to review)', () => {
    const phases = [phase({ id: 'p1', checkpoint: true })]
    expect(pendingCheckpointPhase(phases, [])).toBeNull()
  })

  it('returns the FIRST uncleared, completed checkpoint phase in declared order', () => {
    const phases = [
      phase({ id: 'p1', checkpoint: true, checkpointClearedAt: 1 }),
      phase({ id: 'p2', checkpoint: true }),
      phase({ id: 'p3', checkpoint: true }),
    ]
    const items = [item('a', 'p1', 'done'), item('b', 'p2', 'done'), item('c', 'p3', 'done')]
    // p1 already cleared → p2 is the pending one (even though p3 is also complete + uncleared).
    expect(pendingCheckpointPhase(phases, items)?.id).toBe('p2')
  })
})
