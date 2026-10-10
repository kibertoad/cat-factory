import { describe, expect, it } from 'vitest'
import {
  replyPublicRunClarityFindingContract,
  replyPublicRunFindingContract,
} from '@cat-factory/contracts'
import type { ReviewQuestionPost } from '@cat-factory/kernel'
import type { ReviewQuestionChannels } from './reviewQuestions.logic.js'
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

/** The default: a ticket whose replies reach the run, which is what most cases below are about. */
const WIRED: ReviewQuestionChannels = { ticketReplies: true }

function render(
  over: Partial<ReviewQuestionPost> = {},
  channels: ReviewQuestionChannels = WIRED,
): string {
  return renderReviewQuestionsComment(post(over), channels)
}

describe('issueRefFor', () => {
  it('qualifies the external id by source, so two trackers cannot collide on one key', () => {
    expect(issueRefFor({ source: 'github', externalId: 'acme/api#42' })).toBe('github:acme/api#42')
    expect(issueRefFor({ source: 'jira', externalId: 'ENG-42' })).toBe('jira:ENG-42')
  })
})

describe('renderReviewQuestionsComment', () => {
  it('renders every finding with the id an answer has to name', () => {
    const body = render({
      findings: [
        { id: 'itm_1', title: 'Which currencies?', detail: 'The spec omits them.' },
        { id: 'itm_2', title: 'Rounding?', detail: 'Half-up or bankers?' },
      ],
    })
    expect(body).toContain('`itm_1`')
    expect(body).toContain('`itm_2`')
    expect(body).toContain('Half-up or bankers?')
  })

  it('names the iteration and its cap, so a reader knows how many passes remain', () => {
    expect(render({ iteration: 3, maxIterations: 6 })).toContain('review pass 3 of 6')
  })

  it('truncates an oversized detail rather than risking a rejected oversized comment', () => {
    const body = render({ findings: [{ id: 'itm_1', title: 't', detail: 'x'.repeat(5000) }] })
    expect(body).toContain('… (truncated)')
    expect(body.length).toBeLessThan(2500)
  })

  it('caps the finding list and SAYS what it left out — a silent cut reads as a short review', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `itm_${i}`,
      title: `q${i}`,
      detail: `d${i}`,
    }))
    const body = render({ findings: many })
    expect(body).toContain('30 open questions')
    expect(body).toContain('5 further questions omitted for length')
    expect(body).not.toContain('`itm_29`')
  })
})

// ---------------------------------------------------------------------------
// The answer path. A comment naming a route the surface does not serve is a 404 printed on a
// customer's ticket, and it is the ONE line the whole comment exists to deliver — so the path is
// asserted against the route contract the server itself mounts, never a copy of the string.
// ---------------------------------------------------------------------------

describe('renderReviewQuestionsComment — where answers go', () => {
  it.each([
    ['requirements' as const, replyPublicRunFindingContract],
    ['clarity' as const, replyPublicRunClarityFindingContract],
  ])('names the route the %s reply contract actually resolves', (subject, contract) => {
    // Derived from the contract rather than restated: the hand-written copy this replaced said
    // `…/items/<id>/reply` where the surface serves `…/findings/:itemId/reply`, and the assertion
    // that should have caught it had copied the same mistake.
    const expected = contract.pathResolver({ runId: 'exe_9', itemId: '<id>' })
    expect(render({ subject })).toContain(`POST ${expected}`)
    // Guard the specific way it was wrong, so a regression cannot pass by matching a prefix.
    expect(render({ subject })).not.toContain('/items/<id>/reply')
  })

  it('leads with the ticket grammar when a reply on the ticket reaches the run', () => {
    const body = render()
    expect(body).toContain('@cat-factory answer <id> <your answer>')
    expect(body).toContain('@cat-factory dismiss <id>')
  })

  it('OMITS the ticket grammar when replies are not wired, rather than advising a dead end', () => {
    // The inbound path fails closed without a minted webhook secret, so on such a workspace the
    // grammar is advice that silently does nothing — followed by the one person who came in
    // through the ticket. The API line then has to carry the whole answer path on its own.
    const body = render({}, { ticketReplies: false })
    expect(body).not.toContain('@cat-factory')
    expect(body).toContain(
      `POST ${replyPublicRunFindingContract.pathResolver({ runId: 'exe_9', itemId: '<id>' })}`,
    )
    expect(body).toContain('dismiss the')
  })
})

// ---------------------------------------------------------------------------
// Per-subject copy. A bug reporter told the run "paused to get its requirements straight"
// reasonably concludes the comment landed on the wrong ticket.
// ---------------------------------------------------------------------------

describe('renderReviewQuestionsComment — subject wording', () => {
  it('describes a clarity park as bug triage, with its own count and pass numbers', () => {
    // The count/pluralisation/pass numbers are asserted for the clarity template too because they
    // used to be `{n}`/`{s}`/`{i}`/`{max}` holes filled by sequential `.replace()`: only the
    // requirements copy was covered, so a mistyped placeholder in this one would have shipped a
    // literal `{n}` to a reporter with nothing failing.
    const body = render({
      subject: 'clarity',
      iteration: 2,
      maxIterations: 3,
      findings: [
        { id: 'itm_1', title: 'No repro', detail: 'What did you click?' },
        { id: 'itm_2', title: 'Which browser?', detail: 'Version too, please.' },
      ],
    })
    expect(body).toContain('cannot confidently fix this bug')
    expect(body).toContain('It raised 2 open questions (triage pass 2 of 3)')
    expect(body).not.toContain('requirements')
    expect(body).not.toMatch(/\{[a-z]+\}/)
  })

  it('says "question" for one and "questions" for several, on both subjects', () => {
    for (const subject of ['requirements', 'clarity'] as const) {
      expect(render({ subject })).toContain('1 open question (')
      expect(
        render({
          subject,
          findings: [
            { id: 'a', title: 'a', detail: 'a' },
            { id: 'b', title: 'b', detail: 'b' },
          ],
        }),
      ).toContain('2 open questions (')
    }
  })
})

// ---------------------------------------------------------------------------
// The host boundary. A finding is MODEL-authored prose derived from a customer's task
// description, and it lands on a tracker issue — frequently a public one — that the host
// parses. Everything below is a side effect this platform must never cause on a user's behalf.
// ---------------------------------------------------------------------------

describe('renderReviewQuestionsComment — untrusted text', () => {
  it('does not notify a real account when a finding mentions one', () => {
    const body = render({
      findings: [
        { id: 'itm_1', title: 'Ask @alice', detail: 'Confirm with @bob before we proceed.' },
      ],
    })
    expect(body).not.toContain('@alice')
    expect(body).not.toContain('@bob')
    // …while still READING as the reviewer wrote it: the escape renders as the original glyph.
    expect(body).toContain('&#64;alice')
    expect(body).toContain('&#64;bob')
  })

  it('does not cross-link an unrelated issue from a `#123` in the prose', () => {
    const body = render({
      findings: [{ id: 'itm_1', title: 'Scope', detail: 'Superseded by #42?' }],
    })
    expect(body).not.toContain('#42')
    expect(body).toContain('&#35;42')
  })

  it('closes a fence the finding left open — otherwise it swallows the answer instructions', () => {
    const body = render({
      findings: [{ id: 'itm_1', title: 'Format', detail: 'Example:\n```json\n{"a":1}' }],
    })
    // The instruction line is the whole point of the comment; an unbalanced fence hides it.
    expect(body).toContain(
      replyPublicRunFindingContract.pathResolver({ runId: 'exe_9', itemId: '<id>' }),
    )
    expect(body.split('```').length % 2).toBe(1)
  })

  it('scrubs a credential that reached the review through the task description', () => {
    const body = render({
      findings: [
        {
          id: 'itm_1',
          title: 'Which key?',
          detail: 'The description pastes ghp_abcdefghijklmnopqrstuvwxyz0123 — is that live?',
        },
      ],
    })
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
    const body = render({ findings })
    expect(body.length).toBeLessThanOrEqual(30_000)
    expect(body).toContain('… (truncated)')
  })
})
