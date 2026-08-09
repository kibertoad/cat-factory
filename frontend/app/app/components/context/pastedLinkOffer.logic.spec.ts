import { describe, expect, it } from 'vitest'
import { claimCandidates, firstLinkCandidate } from './pastedLinkOffer.logic'

describe('firstLinkCandidate', () => {
  it('picks a URL out of prose and drops the punctuation the sentence left on it', () => {
    expect(
      firstLinkCandidate('Build the screen at https://www.figma.com/design/abc?node-id=1-2.'),
    ).toBe('https://www.figma.com/design/abc?node-id=1-2')
    expect(firstLinkCandidate('see [design](https://www.figma.com/design/abc), then ship')).toBe(
      'https://www.figma.com/design/abc',
    )
  })

  it('answers null for text with no link, and takes only the FIRST of several', () => {
    expect(firstLinkCandidate('make the button green')).toBeNull()
    // One chip beside a field cannot answer "which of these did you mean", and guessing is
    // worse than sending the author to the attach picker, which is still right there.
    expect(firstLinkCandidate('https://a.test/one and https://b.test/two')).toBe(
      'https://a.test/one',
    )
  })
})

describe('claimCandidates', () => {
  it('asks only HOST-PINNED sources, whatever else is connected', () => {
    // Notion's parser claims any UUID-shaped run, so asked about a Figma link whose file key
    // happens to carry one it answers yes — and the offer would stage a design into Notion's key
    // space. Registration order is preserved for the ones that remain.
    expect(claimCandidates(['notion', 'figma', 'confluence', 'zeplin'])).toEqual([
      'figma',
      'zeplin',
    ])
    expect(claimCandidates(['notion', 'confluence'])).toEqual([])
  })
})
