import { normalizeCallPhase } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { normalizeProxyPhase, phasedProxyBaseUrl } from '../src/pi.js'

// `normalizeProxyPhase` is a deliberate COPY of kernel's `normalizeCallPhase` (the container
// image is built from `src/` plus typescript alone, so the harness can carry no runtime
// dependency on a workspace package — the same constraint that forced `src/host-markdown.ts`).
//
// A copy that can drift is worse than no copy here, because both directions are silent:
//  - harness STRICTER than kernel ⇒ the call takes the plain path and lands unattributed, on
//    exactly the phase a reader went looking for.
//  - harness LOOSER than kernel ⇒ the request spends a round trip on a segment the backend
//    then normalises to `''`, so the URL claims an attribution the row doesn't have.
// Neither fails anything, so this suite pins the two to identical verdicts over a corpus.
const CORPUS: Array<[name: string, input: string]> = [
  ['a plain phase', 'agent'],
  ['a hyphenated phase', 'validation-repair'],
  ['the other repair loop', 'reproduction-repair'],
  ["the registry's initial marker", 'starting'],
  ['the terminal marker', 'done'],
  ['a phase neither build has heard of', 'compaction'],
  ['digits', 'pass2'],
  ['surrounding whitespace', '  agent  '],
  ['mixed case', 'Agent'],
  ['mixed case and padding together', ' Validation-Repair '],
  ['an inner space', 'repair round'],
  ['a path traversal attempt', '../../etc'],
  ['a path separator', 'agent/evil'],
  ['a query-string smuggle', 'agent?x=1'],
  ['an underscore (not in the alphabet)', 'validation_repair'],
  ['a percent escape', 'agent%2F..'],
  ['empty', ''],
  ['only whitespace', '   '],
  ['exactly at the length cap', 'a'.repeat(32)],
  ['one past the length cap', 'a'.repeat(33)],
]

describe('harness normalizeProxyPhase conforms to kernel normalizeCallPhase', () => {
  for (const [name, input] of CORPUS) {
    it(`agrees on ${name}`, () => {
      expect(normalizeProxyPhase(input)).toBe(normalizeCallPhase(input))
    })
  }

  it('agrees that a non-string is not a phase', () => {
    // Kernel takes `unknown` because its inputs arrive over HTTP; the harness's marker is
    // typed, so `undefined` is the only non-string it can see. Both answer the same.
    expect(normalizeProxyPhase(undefined)).toBe(normalizeCallPhase(undefined))
  })

  it('sends exactly the segment the backend will store, or no segment at all', () => {
    // The property that actually matters end to end: whatever segment the harness puts on the
    // URL must survive the backend's normalisation UNCHANGED, so the phase a reader sees on
    // the row is the phase the harness meant. Anything that wouldn't survive takes the plain
    // path instead of spending a request to be discarded.
    for (const [, input] of CORPUS) {
      const url = phasedProxyBaseUrl('https://api.test/v1', input, true)
      const expected = normalizeCallPhase(input)
      expect(url).toBe(expected ? `https://api.test/v1/phase/${expected}` : 'https://api.test/v1')
    }
  })
})
