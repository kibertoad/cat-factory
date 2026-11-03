import { describe, expect, it } from 'vitest'
import type { RequirementReviewItem } from '@cat-factory/kernel'
import { applyFollowUpBar, priorRoundOf } from './follow-up-bar.logic.js'

const item = (over: Partial<RequirementReviewItem>): RequirementReviewItem => ({
  id: 'i',
  category: 'gap',
  severity: 'medium',
  title: 't',
  detail: 'd',
  status: 'open',
  reply: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

describe('priorRoundOf', () => {
  it('counts only answers with text as new information, and lists dismissals apart', () => {
    const round = priorRoundOf([
      item({ title: 'answered', status: 'answered', reply: ' yes ' }),
      item({ title: 'blank answer', status: 'answered', reply: '  ' }),
      item({ title: 'resolved', status: 'resolved', reply: 'done' }),
      item({ title: 'waved off', status: 'dismissed' }),
    ])
    expect(round.answered.map((a) => [a.ref, a.title, a.reply])).toEqual([
      ['A1', 'answered', 'yes'],
      ['A2', 'resolved', 'done'],
    ])
    expect(round.dismissed).toEqual(['waved off'])
  })
})

describe('applyFollowUpBar', () => {
  it('keeps everything and counts nothing on a first pass', () => {
    const items = [item({ severity: 'low' })]
    expect(applyFollowUpBar(items, null)).toEqual({ items, suppressed: null })
  })
})
