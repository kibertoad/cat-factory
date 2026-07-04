import { describe, expect, it } from 'vitest'
import { renderInvestigationDigest } from './bugInvestigation.logic.js'

describe('renderInvestigationDigest', () => {
  it('renders a prose digest from a structured investigation', () => {
    const digest = renderInvestigationDigest({
      clarity: 'needs_clarification',
      summary: 'The submit handler swallows the error.',
      rootCauseHypotheses: ['Unhandled rejection', ''],
      affectedRepos: [
        { repo: 'acme/web', paths: ['src/submit.ts', ''], rationale: 'holds onSubmit' },
      ],
      suggestedReproductions: ['Submit empty form'],
      questions: ['Which browser?', '  '],
    })!
    expect(digest).toContain('## Investigation summary')
    expect(digest).toContain('The submit handler swallows the error.')
    expect(digest).toContain('- Unhandled rejection')
    expect(digest).toContain('**acme/web** — holds onSubmit')
    expect(digest).toContain('`src/submit.ts`')
    expect(digest).toContain('## Suggested reproductions')
    // needs_clarification ⇒ questions section is included; the blank one is dropped.
    expect(digest).toContain('## Open questions for the reporter')
    expect(digest).toContain('- Which browser?')
  })

  it('omits the questions section when the report is clear', () => {
    const digest = renderInvestigationDigest({
      clarity: 'clear',
      summary: 'Fine.',
      rootCauseHypotheses: [],
      affectedRepos: [],
      suggestedReproductions: [],
      questions: ['a leftover question'],
    })!
    expect(digest).toContain('## Investigation summary')
    expect(digest).not.toContain('Open questions')
  })

  it('returns undefined for an unparseable or empty result (raw reply is kept)', () => {
    expect(renderInvestigationDigest('not json')).toBeUndefined()
    // A parseable-but-contentless object degrades to no digest, not an empty heading dump.
    expect(
      renderInvestigationDigest({
        clarity: 'clear',
        rootCauseHypotheses: [],
        affectedRepos: [],
        suggestedReproductions: [],
        questions: [],
      }),
    ).toBeUndefined()
  })
})
