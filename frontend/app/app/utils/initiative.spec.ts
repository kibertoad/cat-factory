import { INITIATIVE_ITEM_TERMINAL_STATUSES } from '@cat-factory/contracts'
import { describe, it, expect } from 'vitest'
import type { InitiativeItem, InitiativePhase, InitiativeQa } from '~/types/domain'
import { isPendingQuestion, orderInterviewQuestions, pendingCheckpointPhase } from './initiative'

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

// `isPendingQuestion` mirrors the backend rule of the same name (orchestration
// `initiative.logic.ts`); `orderInterviewQuestions` is what the planning window renders by, so a
// multi-round interview puts what the human still owes an answer above what they already settled.

const qa = (over: Partial<InitiativeQa> & { id: string }): InitiativeQa => ({
  question: over.id,
  answer: '',
  status: 'open',
  ...over,
})

describe('isPendingQuestion', () => {
  it('is pending while unanswered and not dismissed', () => {
    expect(isPendingQuestion(qa({ id: 'a' }))).toBe(true)
  })

  it('is settled once answered', () => {
    expect(isPendingQuestion(qa({ id: 'a', answer: 'yes' }))).toBe(false)
  })

  it('treats a whitespace-only answer as unanswered', () => {
    expect(isPendingQuestion(qa({ id: 'a', answer: '   \n' }))).toBe(true)
  })

  it('is settled once dismissed, answered or not', () => {
    expect(isPendingQuestion(qa({ id: 'a', status: 'dismissed' }))).toBe(false)
  })

  it('treats an absent answer/status (a hand-authored exchange) as pending', () => {
    expect(isPendingQuestion({})).toBe(true)
  })
})

describe('orderInterviewQuestions', () => {
  const ids = (list: InitiativeQa[]) => orderInterviewQuestions(list).map((q) => q.id)

  it('floats a later round of unanswered questions above the settled digest', () => {
    // The shape the backend's `[...retainedQa, ...pending]` append produces on round two.
    const list = [
      qa({ id: 'r1-answered', answer: 'yes' }),
      qa({ id: 'r1-dismissed', status: 'dismissed' }),
      qa({ id: 'r2-a' }),
      qa({ id: 'r2-b' }),
    ]
    expect(ids(list)).toEqual(['r2-a', 'r2-b', 'r1-answered', 'r1-dismissed'])
  })

  it('keeps chronological order within each group', () => {
    const list = [
      qa({ id: 'p1' }),
      qa({ id: 's1', answer: 'yes' }),
      qa({ id: 'p2' }),
      qa({ id: 's2', status: 'dismissed' }),
      qa({ id: 'p3' }),
    ]
    expect(ids(list)).toEqual(['p1', 'p2', 'p3', 's1', 's2'])
  })

  it('leaves a first round (all pending) exactly as the interviewer asked it', () => {
    const list = [qa({ id: 'a' }), qa({ id: 'b' }), qa({ id: 'c' })]
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })

  it('leaves a fully settled interview in its digest order', () => {
    const list = [qa({ id: 'a', answer: 'x' }), qa({ id: 'b', status: 'dismissed' })]
    expect(ids(list)).toEqual(['a', 'b'])
  })

  it('does not mutate the stored order (the interviewer prompt + tracker digest read it)', () => {
    const list = [qa({ id: 'answered', answer: 'x' }), qa({ id: 'pending' })]
    orderInterviewQuestions(list)
    expect(list.map((q) => q.id)).toEqual(['answered', 'pending'])
  })

  it('handles an empty interview', () => {
    expect(orderInterviewQuestions([])).toEqual([])
  })
})
