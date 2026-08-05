import { describe, expect, it } from 'vitest'
import type { ReviewQuestionPost } from '@cat-factory/kernel'
import { issueRefFor, renderReviewQuestionsComment } from './reviewQuestions.logic.js'

function post(over: Partial<ReviewQuestionPost> = {}): ReviewQuestionPost {
  return {
    subject: 'requirements',
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

// ---------------------------------------------------------------------------
// The host boundary. A finding is MODEL-authored prose derived from a customer's task
// description, and it lands on a tracker issue — frequently a public one — that the host
// parses. Everything below is a side effect this platform must never cause on a user's behalf.
// ---------------------------------------------------------------------------

describe('renderReviewQuestionsComment — untrusted text', () => {
  it('does not notify a real account when a finding mentions one', () => {
    const body = renderReviewQuestionsComment(
      post({
        findings: [
          { id: 'itm_1', title: 'Ask @alice', detail: 'Confirm with @bob before we proceed.' },
        ],
      }),
    )
    expect(body).not.toContain('@alice')
    expect(body).not.toContain('@bob')
    // …while still READING as the reviewer wrote it: the escape renders as the original glyph.
    expect(body).toContain('&#64;alice')
    expect(body).toContain('&#64;bob')
  })

  it('does not cross-link an unrelated issue from a `#123` in the prose', () => {
    const body = renderReviewQuestionsComment(
      post({ findings: [{ id: 'itm_1', title: 'Scope', detail: 'Superseded by #42?' }] }),
    )
    expect(body).not.toContain('#42')
    expect(body).toContain('&#35;42')
  })

  it('closes a fence the finding left open — otherwise it swallows the answer instructions', () => {
    const body = renderReviewQuestionsComment(
      post({
        findings: [{ id: 'itm_1', title: 'Format', detail: 'Example:\n```json\n{"a":1}' }],
      }),
    )
    // The instruction line is the whole point of the comment; an unbalanced fence hides it.
    expect(body).toContain('/api/v1/runs/exe_9/decisions/requirements/items/<id>/reply')
    expect(body.split('```').length % 2).toBe(1)
  })

  it('scrubs a credential that reached the review through the task description', () => {
    const body = renderReviewQuestionsComment(
      post({
        findings: [
          {
            id: 'itm_1',
            title: 'Which key?',
            detail: 'The description pastes ghp_abcdefghijklmnopqrstuvwxyz0123 — is that live?',
          },
        ],
      }),
    )
    expect(body).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123')
    expect(body).toContain('[REDACTED]')
  })

  it('keeps the whole comment inside a tracker-safe budget even when escaping expands it', () => {
    // `#` becomes `&#35;` — a 5x expansion. 25 findings of pathological detail would blow past
    // Jira's comment limit, and a REJECTED comment is a silently unasked question.
    const findings = Array.from({ length: 25 }, (_, i) => ({
      id: `itm_${i}`,
      title: '#'.repeat(200),
      detail: '#'.repeat(1200),
    }))
    const body = renderReviewQuestionsComment(post({ findings }))
    expect(body.length).toBeLessThanOrEqual(30_000)
    expect(body).toContain('… (truncated)')
  })
})
