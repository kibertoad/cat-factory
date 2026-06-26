import { describe, expect, it } from 'vitest'
import type { FollowUpItem, FollowUpsStepState } from '@cat-factory/kernel'
import {
  DEFAULT_FOLLOW_UP_MAX_LOOPS,
  FOLLOW_UP_PRODUCER_KIND,
  followUpsToSendBack,
  hasPendingFollowUps,
  pendingFollowUpCount,
  renderFollowUpRework,
  shouldLoopCoder,
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
    ])
    expect(followUpsToSendBack(s).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('loops only when no pending, has unsent send-back items, and budget remains', () => {
    const ready = state([item({ id: 'a', status: 'queued' })])
    expect(shouldLoopCoder(ready)).toBe(true)
    // A still-pending item blocks the loop (decisions outstanding).
    expect(
      shouldLoopCoder(state([item({ status: 'pending' }), item({ id: 'a', status: 'queued' })])),
    ).toBe(false)
    // Budget spent → no loop (the items advance without re-running).
    expect(shouldLoopCoder({ ...ready, loops: DEFAULT_FOLLOW_UP_MAX_LOOPS })).toBe(false)
    // Nothing to send back → no loop.
    expect(shouldLoopCoder(state([item({ status: 'filed' })]))).toBe(false)
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
})
