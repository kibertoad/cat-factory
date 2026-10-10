import { describe, expect, it } from 'vitest'
import {
  FRAGMENT_BRIEF_MAX_CHARS,
  FRAGMENT_BRIEF_MIN_BODY_CHARS,
  bodyWarrantsBrief,
  fragmentBodyFingerprint,
  isUsableBrief,
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

  it('reads an empty stored brief as NOT-CONDENSABLE, so the model is not called again', () => {
    // The marker: this exact body was condensed and came back unusable. Folding the full
    // standard is the answer until the standard itself changes — re-asking would re-pay for
    // the same refusal on every implementer dispatch, forever.
    expect(
      resolveFragmentBrief({
        body: LONG,
        stored: { brief: '  ', bodyFingerprint: fragmentBodyFingerprint(LONG) },
      }),
    ).toEqual({ kind: 'not-condensable' })
  })

  it('clears the not-condensable marker when the standard is edited', () => {
    // The marker is scoped to a BODY, never to a fragment: a curator who rewrites the
    // standard gets a fresh attempt with no manual reset.
    expect(
      resolveFragmentBrief({
        body: LONG,
        stored: { brief: '', bodyFingerprint: fragmentBodyFingerprint('an older body') },
      }),
    ).toEqual({ kind: 'generate', bodyFingerprint: fragmentBodyFingerprint(LONG) })
  })

  it('lets an authored brief override a not-condensable marker', () => {
    expect(
      resolveFragmentBrief({
        body: LONG,
        authoredBrief: 'Hand-written.',
        stored: { brief: '', bodyFingerprint: fragmentBodyFingerprint(LONG) },
      }),
    ).toEqual({ kind: 'authored', brief: 'Hand-written.' })
  })
})

describe('isUsableBrief', () => {
  const body = 'x'.repeat(10_000)

  it('accepts a condensation that is materially shorter', () => {
    expect(isUsableBrief('y'.repeat(2_500), body)).toBe(true)
  })

  it('rejects a restatement that saved nothing', () => {
    // The generator is told to return the text near its original length rather than drop a
    // rule, so this is an ordinary outcome — and folding the full body is strictly better
    // than folding a same-size text nobody verified.
    expect(isUsableBrief('y'.repeat(9_000), body)).toBe(false)
  })

  it('rejects an empty condensation', () => {
    expect(isUsableBrief('   ', body)).toBe(false)
  })

  it('scales with the body, so a big standard condensed well is NOT refused', () => {
    // The bug this rule replaced: a fixed 4k cap refused a 20k standard condensed to 5k — a
    // 4x per-turn saving, the best outcome the feature can produce — while accepting a 2k
    // standard "condensed" to 1.9k.
    const big = 'x'.repeat(20_000)
    expect(isUsableBrief('y'.repeat(5_000), big)).toBe(true)
    expect(isUsableBrief('y'.repeat(5_000), 'x'.repeat(8_000))).toBe(false)
  })

  it('applies an absolute ceiling for an uncapped document-backed body', () => {
    // A linked Confluence/Notion page has no wire cap, so the ratio alone would admit an
    // unbounded row that is then folded into every implementer turn.
    const huge = 'x'.repeat(200_000)
    expect(isUsableBrief('y'.repeat(FRAGMENT_BRIEF_MAX_CHARS + 1), huge)).toBe(false)
    expect(isUsableBrief('y'.repeat(FRAGMENT_BRIEF_MAX_CHARS), huge)).toBe(true)
  })
})
