import { describe, expect, it } from 'vitest'
import type {
  RequirementReviewItem,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import { buildReviewPrompt, disposeReview } from './requirements.logic.js'

function item(
  severity: ReviewItemSeverity,
  status: ReviewItemStatus = 'open',
): RequirementReviewItem {
  return {
    id: `i_${severity}_${status}`,
    category: 'gap',
    severity,
    title: 't',
    detail: 'd',
    status,
    reply: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('disposeReview', () => {
  const budget = { iteration: 1, maxIterations: 3 }

  it('auto-passes when there are no findings', () => {
    expect(disposeReview([], { ...budget, concernThreshold: 'none' })).toBe('auto-pass')
  })

  it('stops for a human when any finding exceeds the tolerated severity', () => {
    expect(disposeReview([item('high')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
    expect(disposeReview([item('low')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
  })

  it('auto-passes when every finding is at or below the tolerated severity', () => {
    expect(
      disposeReview([item('low'), item('medium')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('auto-pass')
    // A single high finding above the medium bar still stops.
    expect(
      disposeReview([item('low'), item('high')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('awaiting')
  })

  it('ignores dismissed/resolved findings when judging severity', () => {
    expect(
      disposeReview([item('high', 'dismissed'), item('low', 'open')], {
        ...budget,
        concernThreshold: 'none',
      }),
    ).toBe('awaiting')
    expect(
      disposeReview([item('high', 'dismissed')], { ...budget, concernThreshold: 'none' }),
    ).toBe('auto-pass')
  })

  it('reports exceeded once the iteration budget is spent and findings remain', () => {
    expect(
      disposeReview([item('high')], { iteration: 3, maxIterations: 3, concernThreshold: 'none' }),
    ).toBe('exceeded')
    // Tolerated findings auto-pass even at the cap.
    expect(
      disposeReview([item('low')], { iteration: 3, maxIterations: 3, concernThreshold: 'high' }),
    ).toBe('auto-pass')
  })
})

describe('buildReviewPrompt', () => {
  it('instructs the reviewer to assign a severity to every finding', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('severity')
    expect(prompt).toContain('Assign a severity to EVERY item')
  })
})
