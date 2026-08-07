import { describe, expect, it } from 'vitest'
import { freshnessHeaderLines, type DocumentFreshnessGap } from './document-freshness.js'

// The renderer is the whole user-visible surface of document freshness: what an agent reads at the top
// of a `.cat-context/` file. Each case here is a distinct FACT that must not render like another one —
// the "absent and zero must never render the same" rule applied to staleness.

describe('freshnessHeaderLines', () => {
  it('renders nothing when no verdict was reached', () => {
    // No refresher wired: this deployment never asked, which is not the same as concluding the body
    // is unverifiable. The header must stay byte-for-byte what it was before the feature existed.
    expect(freshnessHeaderLines(undefined)).toBe('')
  })

  it('renders nothing for a document with no source to confirm against', () => {
    // An `upload` cannot trail anything, so a freshness note here would invent a problem.
    expect(freshnessHeaderLines({ status: 'not-applicable' })).toBe('')
  })

  it('states the revision a confirmed document was built against', () => {
    expect(
      freshnessHeaderLines({ status: 'confirmed', version: '2317456', change: 'unchanged' }),
    ).toBe('Revision: 2317456\n')
  })

  it('states the same revision whether or not the check had to re-import', () => {
    // Both mean "the agent is reading the live revision". The distinction is for operators reading
    // logs, not for the agent reading the file, so it must not change the rendered claim.
    expect(freshnessHeaderLines({ status: 'confirmed', version: 'v9', change: 'reimported' })).toBe(
      freshnessHeaderLines({ status: 'confirmed', version: 'v9', change: 'unchanged' }),
    )
  })

  it('warns, and names the gap, when the copy could not be confirmed', () => {
    const gaps: DocumentFreshnessGap[] = [
      'source_unreachable',
      'not_connected',
      'credentials_unreadable',
      'unversioned',
    ]
    const lines = gaps.map((reason) => freshnessHeaderLines({ status: 'unconfirmed', reason }))

    for (const line of lines) {
      expect(line).toContain('NOT confirmed')
      expect(line).toMatch(/\n$/)
    }
    // Every gap renders DISTINCTLY, because each one has a different remedy: wait out an outage,
    // reconnect the source, accept that this deployment cannot read the credential, accept that the
    // source has no revision at all. A shared "unknown" would send the reader at the wrong one.
    expect(new Set(lines).size).toBe(gaps.length)
    expect(lines[1]).toContain('no longer connected')
    expect(lines[0]).toContain('could not be reached')
    expect(lines[2]).toContain('cannot read the source credentials')
    expect(lines[3]).toContain('no revision to compare')
  })

  it('never claims a revision it does not have', () => {
    // A confirmed verdict with an empty token would render `Revision: ` — a header that reads as a
    // revision the reader failed to see rather than as one that was never known.
    expect(freshnessHeaderLines({ status: 'confirmed', version: '', change: 'unchanged' })).toBe('')
  })
})
