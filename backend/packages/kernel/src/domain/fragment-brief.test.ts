import { describe, expect, it } from 'vitest'
import {
  FRAGMENT_BRIEF_MIN_BODY_CHARS,
  bodyWarrantsBrief,
  fragmentBodyFingerprint,
  resolveFragmentBrief,
} from './fragment-brief.js'

const LONG = 'x'.repeat(FRAGMENT_BRIEF_MIN_BODY_CHARS)
const SHORT = 'x'.repeat(FRAGMENT_BRIEF_MIN_BODY_CHARS - 1)

describe('bodyWarrantsBrief', () => {
  it('is inclusive at the threshold and measures the TRIMMED body', () => {
    expect(bodyWarrantsBrief(LONG)).toBe(true)
    expect(bodyWarrantsBrief(SHORT)).toBe(false)
    // Trailing whitespace must not push a short standard over the line — it would buy a
    // condensation call for a body the agent reads as identical.
    expect(bodyWarrantsBrief(`${SHORT}   \n\n`)).toBe(false)
  })
})

describe('fragmentBodyFingerprint', () => {
  it('is stable for the same body and ignores surrounding whitespace', () => {
    expect(fragmentBodyFingerprint('a body')).toBe(fragmentBodyFingerprint('  a body\n'))
  })

  it('changes when the body changes', () => {
    expect(fragmentBodyFingerprint('a body')).not.toBe(fragmentBodyFingerprint('a bodyy'))
  })

  it('prefixes the length, so a digest collision alone cannot pass off a stale brief', () => {
    expect(fragmentBodyFingerprint('abc').startsWith('3-')).toBe(true)
  })
})

describe('resolveFragmentBrief', () => {
  it('prefers an authored brief over everything, at any body length', () => {
    expect(
      resolveFragmentBrief({
        body: SHORT,
        authoredBrief: '  Keep it terse.  ',
        stored: { brief: 'generated', bodyFingerprint: fragmentBodyFingerprint(SHORT) },
      }),
    ).toEqual({ kind: 'authored', brief: 'Keep it terse.' })
  })

  it('treats a blank authored brief as none', () => {
    expect(resolveFragmentBrief({ body: SHORT, authoredBrief: '   ' })).toEqual({
      kind: 'body-below-threshold',
    })
  })

  it('folds a short body in full rather than paying to condense it', () => {
    expect(resolveFragmentBrief({ body: SHORT })).toEqual({ kind: 'body-below-threshold' })
  })

  it('asks for a generation when a long body has no brief at all', () => {
    expect(resolveFragmentBrief({ body: LONG })).toEqual({
      kind: 'generate',
      bodyFingerprint: fragmentBodyFingerprint(LONG),
    })
  })

  it('reuses a stored brief whose fingerprint still matches the body', () => {
    expect(
      resolveFragmentBrief({
        body: LONG,
        stored: { brief: ' condensed ', bodyFingerprint: fragmentBodyFingerprint(LONG) },
      }),
    ).toEqual({ kind: 'generated', brief: 'condensed' })
  })

  it('REGENERATES when the body moved underneath a stored brief', () => {
    // The source-document-changed case: the persisted brief condenses a revision this
    // standard no longer has, so folding it would state a rule the standard dropped.
    expect(
      resolveFragmentBrief({
        body: LONG,
        stored: { brief: 'condensed', bodyFingerprint: fragmentBodyFingerprint('an older body') },
      }),
    ).toEqual({ kind: 'generate', bodyFingerprint: fragmentBodyFingerprint(LONG) })
  })

  it('regenerates rather than folding an empty stored brief', () => {
    expect(
      resolveFragmentBrief({
        body: LONG,
        stored: { brief: '  ', bodyFingerprint: fragmentBodyFingerprint(LONG) },
      }).kind,
    ).toBe('generate')
  })
})
