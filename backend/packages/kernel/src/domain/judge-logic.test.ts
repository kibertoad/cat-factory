import { describe, expect, it } from 'vitest'
import type { JudgeVerdict } from './types.js'
import { disposeJudgeVerdict, renderJudgeRework } from './judge-logic.js'

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

  it('distinguishes the three parks by REASON, not by their prose', () => {
    // The engine branches on this: only `budget_spent` is the automation giving up, so only that
    // one may be answered by an unattended risk policy. Reading the distinction back out of
    // `note` would re-point the decision the next time somebody rewords a sentence.
    const below = { ...base, verdict: verdict(0.5) } as const
    expect(disposeJudgeVerdict({ ...below, onFail: 'park' }).parkReason).toBe('registration')
    expect(
      disposeJudgeVerdict({ ...below, onFail: 'bounce', hasBounceTarget: false }).parkReason,
    ).toBe('no_bounce_target')
    expect(
      disposeJudgeVerdict({ ...below, onFail: 'bounce', bounces: 1, maxBounces: 1 }).parkReason,
    ).toBe('budget_spent')
    // A ZERO budget reads as spent too, and deliberately so: `bounces >= maxBounces` is the same
    // question either way. The composition to be aware of is a preset that sets both
    // `judgeMaxBounces: 0` and `autonomy: 'unattended'` — such a run proceeds past a failing
    // verdict having spent no rework at all. That is what its operator asked for on both knobs,
    // and the step records that policy decided it; the shipped `Manual review only` cannot reach
    // it, being `attended`.
    expect(disposeJudgeVerdict({ ...below, onFail: 'bounce', maxBounces: 0 }).parkReason).toBe(
      'budget_spent',
    )
    // Nothing that is not a park carries one.
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.9), onFail: 'park' }).parkReason,
    ).toBeUndefined()
    expect(disposeJudgeVerdict({ ...below, onFail: 'fail' }).parkReason).toBeUndefined()
    expect(disposeJudgeVerdict({ ...below, onFail: 'bounce' }).parkReason).toBeUndefined()
  })

  it('treats a zero bounce budget as "never bounce"', () => {
    // `judgeMaxBounces: 0` is the "Manual review only" preset's setting: it routes everything to
    // the human it already asks, rather than spending a rework round on its own.
    expect(
      disposeJudgeVerdict({ ...base, verdict: verdict(0.5), onFail: 'bounce', maxBounces: 0 })
        .disposition,
    ).toBe('park')
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
