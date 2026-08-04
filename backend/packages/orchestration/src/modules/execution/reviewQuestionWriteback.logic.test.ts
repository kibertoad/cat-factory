import { describe, expect, it } from 'vitest'
import type { RequirementReviewItem, RequirementReviewStatus } from '@cat-factory/kernel'
import {
  buildReviewQuestionPost,
  shouldPostReviewQuestions,
} from './reviewQuestionWriteback.logic.js'

// The scope boundary of the whole headless-clarification initiative lives in this one predicate:
// a task started in the SPA must behave EXACTLY as it did before, so every case below whose
// intake is not HEADLESS has to come back false, and every headless one, however it entered,
// has to come back true.

function item(over: Partial<RequirementReviewItem> = {}): RequirementReviewItem {
  return {
    id: 'itm_1',
    category: 'gap',
    severity: 'high',
    title: 'Which currencies?',
    detail: 'The spec does not say which currencies the converter must support.',
    status: 'open',
    reply: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function review(over: { status?: RequirementReviewStatus; items?: RequirementReviewItem[] } = {}) {
  return {
    status: over.status ?? ('ready' as RequirementReviewStatus),
    items: over.items ?? [item()],
  }
}

describe('shouldPostReviewQuestions', () => {
  it('posts for a headless run parked on open findings', () => {
    expect(shouldPostReviewQuestions({ intakeOrigin: 'public-api' }, review())).toBe(true)
  })

  it('posts for a ticket-dispatched run: the requester is on the ticket, not in the app', () => {
    expect(shouldPostReviewQuestions({ intakeOrigin: 'tracker' }, review())).toBe(true)
  })

  it('posts at the iteration cap too — the caller still has to choose how to proceed', () => {
    expect(
      shouldPostReviewQuestions({ intakeOrigin: 'public-api' }, review({ status: 'exceeded' })),
    ).toBe(true)
  })

  it('never posts for a UI-started run, which keeps its in-app clarification surface', () => {
    expect(shouldPostReviewQuestions({ intakeOrigin: 'ui' }, review())).toBe(false)
  })

  it('never posts for a legacy run with no recorded intake origin (degrades to `ui`)', () => {
    expect(shouldPostReviewQuestions({}, review())).toBe(false)
  })

  it.each(['incorporated', 'incorporating', 'reviewing', 'merged'] as const)(
    'does not post in the non-parking status %s',
    (status) => {
      expect(shouldPostReviewQuestions({ intakeOrigin: 'public-api' }, review({ status }))).toBe(
        false,
      )
    },
  )

  it('does not post when every finding is already answered or dismissed', () => {
    const settled = [item({ status: 'answered' }), item({ id: 'itm_2', status: 'dismissed' })]
    expect(
      shouldPostReviewQuestions({ intakeOrigin: 'public-api' }, review({ items: settled })),
    ).toBe(false)
  })
})

describe('buildReviewQuestionPost', () => {
  it('carries only the OPEN findings, with the run + iteration context', () => {
    const post = buildReviewQuestionPost(
      { id: 'exe_9' },
      {
        id: 'rr_1',
        iteration: 2,
        maxIterations: 6,
        items: [
          item({ id: 'itm_open' }),
          item({ id: 'itm_answered', status: 'answered' }),
          item({ id: 'itm_dismissed', status: 'dismissed' }),
        ],
      },
    )
    expect(post).toEqual({
      reviewId: 'rr_1',
      iteration: 2,
      maxIterations: 6,
      runId: 'exe_9',
      findings: [
        {
          id: 'itm_open',
          title: 'Which currencies?',
          detail: 'The spec does not say which currencies the converter must support.',
        },
      ],
    })
  })
})
