import { describe, expect, it } from 'vitest'
import type { ReviewQuestionPost } from '@cat-factory/kernel'
import { issueRefFor, renderReviewQuestionsComment } from './reviewQuestions.logic.js'

function post(over: Partial<ReviewQuestionPost> = {}): ReviewQuestionPost {
  return {
    reviewId: 'rr_1',
    iteration: 1,
    maxIterations: 6,
    runId: 'exe_9',
    findings: [{ id: 'itm_1', title: 'Which currencies?', detail: 'The spec omits them.' }],
    ...over,
  }
}

describe('issueRefFor', () => {
  it('qualifies the external id by source, so two trackers cannot collide on one key', () => {
    expect(issueRefFor({ source: 'github', externalId: 'acme/api#42' })).toBe('github:acme/api#42')
    expect(issueRefFor({ source: 'jira', externalId: 'ENG-42' })).toBe('jira:ENG-42')
  })
})

describe('renderReviewQuestionsComment', () => {
  it('renders every finding with the id an answer has to name', () => {
    const body = renderReviewQuestionsComment(
      post({
        findings: [
          { id: 'itm_1', title: 'Which currencies?', detail: 'The spec omits them.' },
          { id: 'itm_2', title: 'Rounding?', detail: 'Half-up or bankers?' },
        ],
      }),
    )
    expect(body).toContain('`itm_1`')
    expect(body).toContain('`itm_2`')
    expect(body).toContain('Half-up or bankers?')
  })

  it('states where answers go — a headless run has no human in the app', () => {
    expect(renderReviewQuestionsComment(post())).toContain(
      '/api/v1/runs/exe_9/decisions/requirements/items/<id>/reply',
    )
  })

  it('names the iteration and its cap, so a reader knows how many passes remain', () => {
    expect(renderReviewQuestionsComment(post({ iteration: 3, maxIterations: 6 }))).toContain(
      'review pass 3 of 6',
    )
  })

  it('truncates an oversized detail rather than risking a rejected oversized comment', () => {
    const body = renderReviewQuestionsComment(
      post({ findings: [{ id: 'itm_1', title: 't', detail: 'x'.repeat(5000) }] }),
    )
    expect(body).toContain('… (truncated)')
    expect(body.length).toBeLessThan(2500)
  })

  it('caps the finding list and SAYS what it left out — a silent cut reads as a short review', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `itm_${i}`,
      title: `q${i}`,
      detail: `d${i}`,
    }))
    const body = renderReviewQuestionsComment(post({ findings: many }))
    expect(body).toContain('30 open questions')
    expect(body).toContain('5 further questions omitted for length')
    expect(body).not.toContain('`itm_29`')
  })
})
