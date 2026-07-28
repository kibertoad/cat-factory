import { INITIATIVE_ITEM_TERMINAL_STATUSES } from '@cat-factory/contracts'
import { describe, it, expect } from 'vitest'
import type { InitiativeItem, InitiativePhase } from '~/types/domain'
import { initiativeInterviewPhase, pendingCheckpointPhase } from './initiative'

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

  // Drift guard: the checkpoint fires on EVERY status the backend counts as terminal, because the
  // frontend gates on the SAME `INITIATIVE_ITEM_TERMINAL_STATUSES` the engine does — not a local
  // copy. If the backend adds a terminal status, this fires the checkpoint on it automatically.
  it.each([...INITIATIVE_ITEM_TERMINAL_STATUSES])('fires on the terminal status %s', (status) => {
    const phases = [phase({ id: 'p1', checkpoint: true })]
    expect(pendingCheckpointPhase(phases, [item('a', 'p1', status)])?.id).toBe('p1')
  })
})

// `initiativeInterviewPhase` is what stops continue/proceed reading as no-ops: the resume is
// asynchronous (the HTTP call only wakes the durable driver, so it returns the PRE-resume entity),
// and these pin that the RUN status is what distinguishes "parked, waiting on you" from "a pass is
// running" — a distinction the entity alone cannot make.

const awaiting = { round: 1, maxRounds: 6, status: 'awaiting' } as const
const done = { round: 2, maxRounds: 6, status: 'done' } as const

describe('initiativeInterviewPhase', () => {
  it('is awaiting while the run is parked on the human', () => {
    expect(initiativeInterviewPhase(awaiting, 'blocked')).toBe('awaiting')
  })

  it('is working once the resumed run is running again, even though the entity still says awaiting', () => {
    // The exact regression: continue/proceed leave `interview.status` untouched until the pass
    // finishes, so an entity-only reading renders the same questions and looks like a dead button.
    expect(initiativeInterviewPhase(awaiting, 'running')).toBe('working')
  })

  it('is working for the FIRST pass, before any question exists', () => {
    expect(initiativeInterviewPhase(undefined, 'running')).toBe('working')
  })

  it('is failed when the run stopped before the interview settled', () => {
    // Must not stay `working`: a pass that dies would otherwise spin forever.
    expect(initiativeInterviewPhase(awaiting, 'failed')).toBe('failed')
    expect(initiativeInterviewPhase(undefined, 'failed')).toBe('failed')
  })

  it('is converged once the interview settled, whatever the run went on to do', () => {
    // `converged` outranks `failed`: a later step's failure belongs to that step, not the
    // interview, and the block's own failure surface reports it.
    expect(initiativeInterviewPhase(done, 'running')).toBe('converged')
    expect(initiativeInterviewPhase(done, 'failed')).toBe('converged')
    expect(initiativeInterviewPhase(done, undefined)).toBe('converged')
  })

  it('is idle when planning never ran', () => {
    expect(initiativeInterviewPhase(undefined, undefined)).toBe('idle')
  })

  it('degrades to the entity-only reading when the run is not cached', () => {
    // A window opened before the execution snapshot lands must show the questions, never a spinner.
    expect(initiativeInterviewPhase(awaiting, undefined)).toBe('awaiting')
  })

  it('keeps a paused run answerable', () => {
    expect(initiativeInterviewPhase(awaiting, 'paused')).toBe('awaiting')
  })
})
