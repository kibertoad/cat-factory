import { describe, expect, it } from 'vitest'
import { renderReproDigest } from './reproTest.logic.js'

describe('renderReproDigest', () => {
  it('renders a digest for a reproduced outcome with its test paths', () => {
    const digest = renderReproDigest({
      outcome: 'reproduced',
      testPaths: ['test/submit.test.ts', '  '],
      notes: 'Fails with an unhandled rejection on empty email.',
    })!
    expect(digest).toContain('## Reproduction test')
    expect(digest).toContain('Reproduced — a failing test was committed')
    expect(digest).toContain('`test/submit.test.ts`')
    // The blank path is dropped.
    expect(digest).not.toContain('- ``')
    expect(digest).toContain('### Notes')
    expect(digest).toContain('unhandled rejection')
  })

  it('renders the concede (not_reproducible) outcome with its reason and no test list', () => {
    const digest = renderReproDigest({
      outcome: 'not_reproducible',
      testPaths: [],
      notes: 'Needs production data to trigger.',
    })!
    expect(digest).toContain('Not reproducible — no failing test was committed')
    expect(digest).not.toContain('### Tests')
    expect(digest).toContain('Needs production data to trigger.')
  })

  it('degrades a partial/contentless object to the outcome heading (fallbacks apply)', () => {
    // An empty object coerces to `not_reproducible` (the conservative fallback) — still useful
    // to the coder, so it renders rather than being dropped.
    const digest = renderReproDigest({})!
    expect(digest).toContain('Not reproducible')
  })

  it('returns undefined for a non-object (unparseable) result so the raw reply is kept', () => {
    expect(renderReproDigest('not json')).toBeUndefined()
    expect(renderReproDigest(null)).toBeUndefined()
  })
})
