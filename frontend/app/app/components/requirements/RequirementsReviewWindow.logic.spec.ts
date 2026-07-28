import { describe, it, expect } from 'vitest'
import {
  findingAttention,
  orderFindings,
  reconcileFindingOrder,
  type FindingRecommendationState,
  type OrderedFinding,
} from './RequirementsReviewWindow.logic'
import type { RequirementReviewItem } from '~/types/requirements'

/**
 * The findings list's floating order. The point of the feature is that a human working a long
 * review never has to hunt for what is still on them, so these pin the bucketing (including the
 * cases where the recommendation state disagrees with the finding's own status), the tie-breaking
 * that keeps the sort stable, and the pinning rule that stops the list re-sorting under a cursor
 * without ever letting a stale pin hide a newly-raised finding.
 */
const NO_REC: FindingRecommendationState = { pending: false, ready: false }

const item = (
  id: string,
  status: RequirementReviewItem['status'],
  severity: RequirementReviewItem['severity'] = 'medium',
): RequirementReviewItem => ({
  id,
  category: 'question',
  severity,
  title: id,
  detail: `detail for ${id}`,
  status,
  reply: null,
  createdAt: 0,
  updatedAt: 0,
})

const order = (
  items: RequirementReviewItem[],
  recs: Record<string, FindingRecommendationState> = {},
) => orderFindings(items, (i) => recs[i.id] ?? NO_REC)

describe('findingAttention', () => {
  it('puts an unanswered finding on the human', () => {
    expect(findingAttention(item('a', 'open'), NO_REC)).toBe('action')
  })

  it('settles a finding the human already reacted to', () => {
    expect(findingAttention(item('a', 'answered'), NO_REC)).toBe('settled')
    expect(findingAttention(item('a', 'dismissed'), NO_REC)).toBe('settled')
    expect(findingAttention(item('a', 'resolved'), NO_REC)).toBe('settled')
  })

  it('parks a finding whose suggestion is still being generated', () => {
    expect(
      findingAttention(item('a', 'recommend_requested'), { pending: true, ready: false }),
    ).toBe('waiting')
    // Even one the human never settled: there is nothing to react to until the Writer lands.
    expect(findingAttention(item('a', 'open'), { pending: true, ready: false })).toBe('waiting')
  })

  it('returns a finding to the human the moment its suggestion is ready to accept or reject', () => {
    expect(
      findingAttention(item('a', 'recommend_requested'), { pending: false, ready: true }),
    ).toBe('action')
    // A ready suggestion outranks even an answer already recorded — accept/reject is still owed.
    expect(findingAttention(item('a', 'answered'), { pending: false, ready: true })).toBe('action')
  })

  it('returns a recommend-requested finding with nothing in flight to the human', () => {
    // The suggestion was rejected / never landed: nothing more is coming, so it is back on them.
    expect(findingAttention(item('a', 'recommend_requested'), NO_REC)).toBe('action')
  })
})

describe('orderFindings', () => {
  it('floats what needs a reaction above what is waiting, above what is handled', () => {
    const items = [
      item('handled', 'answered'),
      item('waiting', 'recommend_requested'),
      item('needs-me', 'open'),
    ]
    expect(
      order(items, { waiting: { pending: true, ready: false } }).map((entry) => entry.id),
    ).toEqual(['needs-me', 'waiting', 'handled'])
  })

  it('keeps severity as the order within a bucket', () => {
    const items = [item('low', 'open', 'low'), item('high', 'open', 'high'), item('mid', 'open')]
    expect(order(items).map((entry) => entry.id)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks ties on the reviewer ordering, so the sort is stable', () => {
    const items = [item('first', 'open'), item('second', 'open'), item('third', 'open')]
    expect(order(items).map((entry) => entry.id)).toEqual(['first', 'second', 'third'])
  })

  it('outranks severity by attention, so a low open finding beats a high handled one', () => {
    const items = [item('high-handled', 'dismissed', 'high'), item('low-open', 'open', 'low')]
    expect(order(items).map((entry) => entry.id)).toEqual(['low-open', 'high-handled'])
  })

  it('tags each entry with the bucket its position came from', () => {
    const items = [item('a', 'open'), item('b', 'dismissed')]
    expect(order(items)).toEqual([
      { id: 'a', attention: 'action' },
      { id: 'b', attention: 'settled' },
    ])
  })

  it('handles an empty review', () => {
    expect(order([])).toEqual([])
  })
})

describe('reconcileFindingOrder', () => {
  const desired: OrderedFinding[] = [
    { id: 'a', attention: 'action' },
    { id: 'b', attention: 'settled' },
  ]

  it('falls back to the computed order when nothing is pinned', () => {
    expect(reconcileFindingOrder(desired, null)).toEqual(desired)
  })

  it('holds the pinned order while it covers the same findings', () => {
    // `b` has since been answered and would now sink, but the pin keeps the list still.
    const pinned: OrderedFinding[] = [
      { id: 'b', attention: 'action' },
      { id: 'a', attention: 'action' },
    ]
    expect(reconcileFindingOrder(desired, pinned)).toBe(pinned)
  })

  it('drops a pin that no longer covers every finding, so a new one can never be hidden', () => {
    const pinned: OrderedFinding[] = [{ id: 'a', attention: 'action' }]
    expect(reconcileFindingOrder(desired, pinned)).toEqual(desired)
  })

  it('drops a pin naming a finding the review no longer has', () => {
    const pinned: OrderedFinding[] = [
      { id: 'a', attention: 'action' },
      { id: 'gone', attention: 'action' },
    ]
    expect(reconcileFindingOrder(desired, pinned)).toEqual(desired)
  })
})
