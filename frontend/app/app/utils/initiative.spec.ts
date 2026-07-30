import { INITIATIVE_ITEM_TERMINAL_STATUSES } from '@cat-factory/contracts'
import { describe, it, expect } from 'vitest'
import type { InitiativeItem, InitiativePhase, InitiativeQa } from '~/types/domain'
import { missingI18nKeys } from '../../test/i18nKeys'
import {
  INITIATIVE_ATTENTION_LABEL_KEYS,
  INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS,
  INITIATIVE_STATUS_LABEL_KEYS,
  isPendingQuestion,
  orderInterviewQuestions,
  pendingCheckpointPhase,
  planReviewDocument,
  selectPlanApproval,
} from './initiative'

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

// The plan-review park: which of a block's pending approvals the board card / inspector offer as
// "Review plan", and which one they must leave alone. Both gates on the planning pipeline park on
// a `step.approval`, so the interviewer's park (owned by the planning window's "Answer planning
// questions") is the case this selector exists to keep out — offering it here would give one park
// two differently-worded buttons, and the tracker window it opened could not resolve it.

/** A pending approval as `execution.approvalsByBlock` carries it (only the fields read here). */
const parked = (agentKind: string, id: string) => ({ agentKind, approval: { id } })

/** The catalog's result-view resolver, as the composable passes it in. */
const resultViewOf = (kind: string): string | undefined =>
  kind === 'initiative-interviewer'
    ? 'initiative-planning'
    : kind.startsWith('initiative-')
      ? 'initiative-tracker'
      : undefined

describe('selectPlanApproval', () => {
  it('is undefined when nothing is parked', () => {
    expect(selectPlanApproval([], resultViewOf)).toBeUndefined()
  })

  it('picks the planner gate — the plan awaiting approval', () => {
    const approvals = [parked('initiative-planner', 'ap_1')]
    expect(selectPlanApproval(approvals, resultViewOf)?.approval.id).toBe('ap_1')
  })

  it('leaves the interviewer park to the planning window', () => {
    const approvals = [parked('initiative-interviewer', 'ap_interview')]
    expect(selectPlanApproval(approvals, resultViewOf)).toBeUndefined()
  })

  it('finds the plan gate past an interview park (a re-run interviewing again)', () => {
    const approvals = [parked('initiative-interviewer', 'ap_interview'), parked('x', 'ap_plan')]
    expect(selectPlanApproval(approvals, resultViewOf)?.approval.id).toBe('ap_plan')
  })

  it('offers a gated step of a custom planning pipeline, whatever window it routes to', () => {
    // A kind with no dedicated window at all still parks a human; the affordance opens whatever
    // `dispatchStepView` routes it to (the generic panel), which is exactly what resolves it.
    const approvals = [parked('some-custom-kind', 'ap_custom')]
    expect(selectPlanApproval(approvals, resultViewOf)?.approval.id).toBe('ap_custom')
  })
})

// Which shape the plan gate takes in the tracker window: a document review that OWNS the window, or
// the compact notice above the tracker's own sections. Both the window's layout and the review
// surface read this one value, so these pin the cases where "there is a plan to read" is not the
// same as "the proposal is non-empty".

describe('planReviewDocument', () => {
  const gate = (proposal: string | null | undefined, outputIsRendered: boolean) => ({
    approval: { proposal },
    outputIsRendered,
  })

  it('is the proposal when the step says it IS the plan rendering', () => {
    expect(planReviewDocument(gate('# Initiative plan\n\n## Goal', true))).toBe(
      '# Initiative plan\n\n## Goal',
    )
  })

  it('returns the proposal verbatim, so comment anchors stay on the lines they quote', () => {
    // Anchoring is by SOURCE LINE, so trimming a leading newline would shift every anchor up one.
    expect(planReviewDocument(gate('\n# Initiative plan\n', true))).toBe('\n# Initiative plan\n')
  })

  it('reads an un-rendered proposal as no document, however substantial it looks', () => {
    // The planner's transcript summary: a perfectly non-empty string that is not the plan. Showing
    // it under a table of contents is the failure the rendered review exists to end.
    expect(
      planReviewDocument(gate('I drafted a three-phase plan and stopped for review.', false)),
    ).toBe('')
  })

  it('reads a rendered but blank proposal as no document', () => {
    expect(planReviewDocument(gate('   \n  ', true))).toBe('')
    expect(planReviewDocument(gate(null, true))).toBe('')
    expect(planReviewDocument(gate(undefined, true))).toBe('')
  })

  it('has no document when nothing is parked', () => {
    expect(planReviewDocument(null)).toBe('')
    expect(planReviewDocument(undefined)).toBe('')
  })
})

/**
 * These tables are the reason the initiative card and the inspector word one park identically,
 * and they are exactly the shape both i18n drift guards are blind to: the typed-key check and
 * `i18n:check` only see a key written literally at a `t()` call site, while the exhaustive
 * `Record` only proves every enum MEMBER has an entry — never that the entry still names a key
 * the catalog holds. Without this, deleting a key reads as a clean removal and the affordance
 * renders its own key path to the user.
 */
describe('the initiative label-key tables', () => {
  it('name keys the base catalog actually holds', () => {
    expect(
      missingI18nKeys([
        ...Object.values(INITIATIVE_ATTENTION_LABEL_KEYS),
        ...Object.values(INITIATIVE_STATUS_LABEL_KEYS),
        ...Object.values(INITIATIVE_FOLLOWUP_STATUS_LABEL_KEYS),
      ]),
    ).toEqual([])
  })
})
