import { describe, expect, it } from 'vitest'
import type { JudgeVerdict } from './types.js'
import { annotateOutOfRangeScore, disposeJudgeVerdict, renderJudgeRework } from './judge-logic.js'

const verdict = (score: number, findings: JudgeVerdict['findings'] = []): JudgeVerdict => ({
  score,
  summary: 'because reasons',
  findings,
})

const base = { threshold: 0.7, bounces: 0, maxBounces: 1, hasBounceTarget: true } as const

describe('disposeJudgeVerdict', () => {
  it('passes at or above the threshold', () => {
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.9), onFail: 'park' }).disposition,
    ).toBe('pass')
    // Exactly AT the threshold passes: the number an operator typed into the preset must be
    // reachable, or a `1.0` threshold would be unsatisfiable and a `0.7` one would need 0.70001.
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.7), onFail: 'fail' }).disposition,
    ).toBe('pass')
  })

  it('applies the registration disposition below the threshold', () => {
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.5), onFail: 'park' }).disposition,
    ).toBe('park')
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.5), onFail: 'fail' }).disposition,
    ).toBe('fail')
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.5), onFail: 'bounce' }).disposition,
    ).toBe('bounce')
  })

  it('degrades a spent bounce budget to a park, never a silent advance', () => {
    const result = disposeJudgeVerdict({
      ...base,
      verdict: verdict(0.5),
      onFail: 'bounce',
      bounces: 1,
      maxBounces: 1,
    })
    expect(result.disposition).toBe('park')
    expect(result.note).toContain('1/1')
  })

  it('degrades a bounce with no producing step to a park, and says why', () => {
    const result = disposeJudgeVerdict({
      ...base,
      verdict: verdict(0.5),
      onFail: 'bounce',
      hasBounceTarget: false,
    })
    expect(result.disposition).toBe('park')
    expect(result.note).toContain('No preceding producing step')
  })

  it('treats a zero bounce budget as "never bounce", and says so in those terms', () => {
    // `judgeMaxBounces: 0` is the "Manual review only" preset's setting: it routes everything to
    // the human it already asks, rather than spending a rework round on its own.
    const result = disposeJudgeVerdict({
      ...base,
      verdict: verdict(0.5),
      onFail: 'bounce',
      maxBounces: 0,
    })
    expect(result.disposition).toBe('park')
    // NOT "budget spent (0/0)" — nothing was spent; the preset never offered a round. An
    // operator reading that would go looking for a bug instead of recognising their own policy.
    expect(result.note).toContain('no rework rounds')
    expect(result.note).not.toContain('0/0')
  })
})

describe('renderJudgeRework', () => {
  it('orders findings worst-first and folds in the human guidance', () => {
    const brief = renderJudgeRework(
      verdict(0.4, [
        { title: 'Minor nit', severity: 'low' },
        { title: 'Unrelated refactor', severity: 'critical', detail: 'touched src/other' },
        { title: 'Missing requirement', severity: 'high', where: 'src/a.ts:12' },
      ]),
      'Scope adherence',
      'focus on the refactor first',
    )
    const order = ['Unrelated refactor', 'Missing requirement', 'Minor nit'].map((t) =>
      brief.indexOf(t),
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(brief).toContain('Scope adherence')
    expect(brief).toContain('0.40')
    expect(brief).toContain('src/a.ts:12')
    expect(brief).toContain('focus on the refactor first')
  })

  it('renders a clean-but-failing verdict without a findings list', () => {
    const brief = renderJudgeRework(verdict(0.2), 'Scope adherence')
    expect(brief).toContain('because reasons')
    expect(brief).not.toContain('Address each of the following')
  })
})

describe('annotateOutOfRangeScore', () => {
  it('explains a zero the 0..1 clamp produced from a 0..100 answer', () => {
    // The schema's `v.fallback(… maxValue(1) …, 0)` turns `85` into 0.00 beside a sensible
    // summary, which reads as "the work is worthless" rather than "the scale was wrong".
    const annotated = annotateOutOfRangeScore({ score: 85, summary: 'Looks good' }, verdict(0))
    expect(annotated.score).toBe(0)
    expect(annotated.findings?.[0]?.severity).toBe('critical')
    expect(annotated.findings?.[0]?.detail).toContain('85')
  })

  it('keeps the original findings beneath the explanation', () => {
    const annotated = annotateOutOfRangeScore(
      { score: -3 },
      verdict(0, [{ title: 'Real problem', severity: 'high' }]),
    )
    expect(annotated.findings?.map((f) => f.title)).toEqual([
      'The rubric assessment scored on the wrong scale',
      'Real problem',
    ])
  })

  it('leaves an in-range verdict alone, including a legitimate zero', () => {
    const legitimateZero = verdict(0, [{ title: 'Ignored the rubric', severity: 'critical' }])
    expect(annotateOutOfRangeScore({ score: 0 }, legitimateZero)).toBe(legitimateZero)
    const passing = verdict(0.9)
    expect(annotateOutOfRangeScore({ score: 0.9 }, passing)).toBe(passing)
  })

  it('ignores a non-numeric or absent raw score (nothing to explain)', () => {
    const zero = verdict(0)
    expect(annotateOutOfRangeScore({ score: 'high' }, zero)).toBe(zero)
    expect(annotateOutOfRangeScore({}, zero)).toBe(zero)
    expect(annotateOutOfRangeScore(null, zero)).toBe(zero)
    expect(annotateOutOfRangeScore({ score: Number.NaN }, zero)).toBe(zero)
  })
})
