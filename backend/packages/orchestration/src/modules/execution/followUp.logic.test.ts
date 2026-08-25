import { describe, expect, it } from 'vitest'
import type { FollowUpItem, FollowUpsStepState } from '@cat-factory/kernel'
import {
  DEFAULT_FOLLOW_UP_MAX_LOOPS,
  FOLLOW_UP_PRODUCER_KIND,
  followUpGateVerdict,
  followUpsAlreadySettled,
  followUpsToSendBack,
  hasPendingFollowUps,
  pendingFollowUpCount,
  renderFollowUpRework,
} from './followUp.logic.js'

const item = (over: Partial<FollowUpItem>): FollowUpItem => ({
  id: 'fu_1',
  kind: 'follow_up',
  title: 'Item',
  detail: '',
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const state = (
  items: FollowUpItem[],
  over: Partial<FollowUpsStepState> = {},
): FollowUpsStepState => ({
  enabled: true,
  items,
  loops: 0,
  maxLoops: DEFAULT_FOLLOW_UP_MAX_LOOPS,
  ...over,
})

describe('followUp.logic', () => {
  it('the producer kind is the coder', () => {
    expect(FOLLOW_UP_PRODUCER_KIND).toBe('coder')
  })

  it('counts pending items only when enabled', () => {
    const s = state([item({ status: 'pending' }), item({ id: 'fu_2', status: 'filed' })])
    expect(hasPendingFollowUps(s)).toBe(true)
    expect(pendingFollowUpCount(s)).toBe(1)
    expect(hasPendingFollowUps({ ...s, enabled: false })).toBe(false)
    expect(pendingFollowUpCount(undefined)).toBe(0)
  })

  it('sends back only unsent queued follow-ups + answered questions', () => {
    const s = state([
      item({ id: 'a', status: 'queued' }),
      item({ id: 'b', status: 'answered', kind: 'question', answer: 'pg' }),
      item({ id: 'c', status: 'queued', sentToCoder: true }),
      item({ id: 'd', status: 'filed' }),
      item({ id: 'e', status: 'dismissed' }),
      // A ruling, not an answer: it clears the gate and buys no pass.
      item({ id: 'f', status: 'closed', kind: 'question', answer: 'the brief stands' }),
    ])
    expect(followUpsToSendBack(s).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('excludes an already-dropped send-back, so exhaustion is reported exactly once', () => {
    // The stamp is what makes the exhausted verdict idempotent: without this exclusion a
    // re-driven advance re-counts the same dropped decisions on every pass over the step.
    const dropped = state([item({ id: 'a', status: 'queued', sendBackDropped: true })], {
      loops: DEFAULT_FOLLOW_UP_MAX_LOOPS,
    })
    expect(followUpsToSendBack(dropped)).toEqual([])
    expect(followUpGateVerdict(dropped)).toBe('settled')
  })

  it('names each gate disposition, so an exhausted budget is not read as nothing to send', () => {
    const ready = state([item({ id: 'a', status: 'queued' })])
    expect(followUpGateVerdict(ready)).toBe('loop')
    // A still-pending item holds the gate, whatever else is decided.
    expect(
      followUpGateVerdict(
        state([item({ status: 'pending' }), item({ id: 'a', status: 'queued' })]),
      ),
    ).toBe('pending')
    // Budget spent WITH a decision still unsent: the run advances, and something was dropped.
    expect(followUpGateVerdict({ ...ready, loops: DEFAULT_FOLLOW_UP_MAX_LOOPS })).toBe('exhausted')
    // Budget spent with NOTHING outstanding is an ordinary finish, not a drop. These two were the
    // same `false` before, which is why the drop reached nobody.
    expect(
      followUpGateVerdict(
        state([item({ status: 'filed' })], { loops: DEFAULT_FOLLOW_UP_MAX_LOOPS }),
      ),
    ).toBe('settled')
    expect(followUpGateVerdict(state([item({ status: 'filed' })]))).toBe('settled')
  })

  it('reads a step with no ceiling as settled, not as a budget that ran out', () => {
    // `followUpLoopBudget` defaults a missing ceiling to 0 so the loop stops rather than running
    // unbounded. Reported as `exhausted`, that same 0 would stamp every decided item as discarded,
    // warn, count under `followup.send_back_dropped` and banner the pull request about a budget
    // "spent" at 0/0 for a step that never had one. An unwired capability passes through.
    const unbudgeted = state([item({ id: 'a', status: 'queued' })], { loops: 0, maxLoops: 0 })
    expect(followUpGateVerdict(unbudgeted)).toBe('settled')
    // And a ceiling of one still loops, so the guard is on ABSENCE, not on a low budget.
    expect(followUpGateVerdict({ ...unbudgeted, maxLoops: 1 })).toBe('loop')
  })

  it('collects every closed question as settled, not only the newest', () => {
    const s = state([
      item({ id: 'a', status: 'closed', kind: 'question', answer: 'no' }),
      item({ id: 'b', status: 'answered', kind: 'question', answer: 'yes' }),
      item({ id: 'c', status: 'closed', kind: 'question', answer: 'the brief stands' }),
    ])
    expect(followUpsAlreadySettled(s).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('renders queued tasks + answered questions into the Coder rework, empty when none', () => {
    expect(renderFollowUpRework([])).toBe('')
    const text = renderFollowUpRework([
      item({
        id: 'a',
        status: 'queued',
        title: 'Dedupe util',
        detail: 'two copies',
        suggestedAction: 'extract a helper',
      }),
      item({
        id: 'b',
        status: 'answered',
        kind: 'question',
        title: 'Which timeout?',
        answer: '30s',
      }),
    ])
    expect(text).toContain('Follow-up tasks to implement:')
    expect(text).toContain('Dedupe util')
    expect(text).toContain('Suggested approach: extract a helper')
    expect(text).toContain('Answers to questions you raised')
    expect(text).toContain('A: 30s')
  })

  it('carries the rulings into the rework, told apart from answers and marked do-not-re-raise', () => {
    const text = renderFollowUpRework(
      [item({ id: 'a', status: 'queued', title: 'Dedupe util' })],
      [
        item({
          id: 'b',
          status: 'closed',
          kind: 'question',
          title: 'Which IngressClass is default?',
          answer: 'Nobody here knows. Ship it classless and say so.',
        }),
      ],
    )
    expect(text).toContain('Already settled')
    expect(text).toContain('do NOT raise these again')
    expect(text).toContain('Which IngressClass is default?')
    expect(text).toContain('Ruling: Nobody here knows.')
    // A ruling must not be presented as something to apply: that framing is what produced the
    // reword-and-re-ask loop this section exists to end.
    expect(text).not.toContain('A: Nobody here knows.')
  })

  it('spends no pass on rulings alone: a rework with nothing to send stays empty', () => {
    // Otherwise the budget buys a model call whose entire prompt is "here is what you may not ask
    // about", which has no work in it.
    expect(renderFollowUpRework([], [item({ id: 'b', status: 'closed', kind: 'question' })])).toBe(
      '',
    )
  })
})
