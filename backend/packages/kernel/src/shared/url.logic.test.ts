import { describe, expect, it } from 'vitest'
import { normalizeUrl, urlMatchCandidates } from './url.logic.js'

describe('normalizeUrl', () => {
  it('canonicalises only the semantically irrelevant differences', () => {
    expect(normalizeUrl('  https://wiki/spec/  ')).toBe('https://wiki/spec')
    expect(normalizeUrl('https://wiki/spec///')).toBe('https://wiki/spec')
    // Case, query and fragment are NOT touched: they can change what a URL points at.
    expect(normalizeUrl('https://Wiki/Spec?v=2#top')).toBe('https://Wiki/Spec?v=2#top')
  })
})

describe('urlMatchCandidates', () => {
  it('offers both stored forms so a point lookup can match either', () => {
    expect(urlMatchCandidates('https://wiki/spec/')).toEqual([
      'https://wiki/spec',
      'https://wiki/spec/',
    ])
  })

  it('refuses a needle that normalises to nothing', () => {
    // A stored `url` is legitimately EMPTY for a document with no origin page (an `upload`), so
    // candidates of `['', '/']` would make a lookup for nothing match every uploaded document and
    // hand an arbitrary one back as the page a description pointed at.
    expect(urlMatchCandidates('')).toBeNull()
    expect(urlMatchCandidates('   ')).toBeNull()
    expect(urlMatchCandidates('///')).toBeNull()
  })
})
