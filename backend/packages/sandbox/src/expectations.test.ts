import type { SandboxExpectation } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { renderExpectationBrief, scoreExpectations } from './expectations.js'

const expectation = (
  over: Partial<SandboxExpectation> & Pick<SandboxExpectation, 'id'>,
): SandboxExpectation => ({
  summary: over.id,
  detail: '',
  trickiness: 1,
  impact: 1,
  matchHints: [],
  ...over,
})

describe('scoreExpectations', () => {
  it('matches an expectation via its summary, token-sequence (not substring)', () => {
    const out = scoreExpectations(
      [expectation({ id: 'a', summary: 'missing reset logic' })],
      'The token bucket has a MISSING   reset logic bug.',
    )
    expect(out.caught.map((e) => e.id)).toEqual(['a'])
    // `reset logic` must NOT match inside `preset logic`.
    const noMatch = scoreExpectations(
      [expectation({ id: 'a', summary: 'reset logic' })],
      'The preset logic is fine.',
    )
    expect(noMatch.missed.map((e) => e.id)).toEqual(['a'])
  })

  it('prefers matchHints over summary when present', () => {
    const out = scoreExpectations(
      [
        expectation({
          id: 'a',
          summary: 'unbounded memory growth',
          matchHints: ['Map', 'never evicted'],
        }),
      ],
      'The buckets are never evicted from the table.',
    )
    expect(out.caught.map((e) => e.id)).toEqual(['a'])
  })

  it('matches a trailing-* hint by prefix on its LAST token only', () => {
    const hint = (matchHints: string[]) => [expectation({ id: 'a', matchHints })]
    // The word form varies and one hint covers all of them.
    for (const output of ['consumers must be idempotent', 'this needs idempotency', 'idempoten']) {
      expect(scoreExpectations(hint(['idempoten*']), output).caught.map((e) => e.id)).toEqual(['a'])
    }
    // Without the marker a stem is a DEAD hint: the scorer compares tokens by equality, so it
    // scores "missed" for every answer while reading as a perfectly sensible fixture. This is the
    // asymmetry the marker exists to make visible.
    expect(
      scoreExpectations(hint(['idempoten']), 'consumers must be idempotent').missed,
    ).toHaveLength(1)
    // Only the tail is a prefix: the earlier tokens still need to match whole.
    expect(
      scoreExpectations(hint(['no invalidat*']), 'there is no invalidation').caught,
    ).toHaveLength(1)
    expect(
      scoreExpectations(hint(['no invalidat*']), 'nothing invalidates it').missed,
    ).toHaveLength(1)
  })

  it('weights the miss penalty by impact (missing high-impact hurts most)', () => {
    const exps = [expectation({ id: 'low', impact: 1 }), expectation({ id: 'high', impact: 5 })]
    // Catch only the low-impact one → impactRecall = 1 - 5/6 ≈ 0.17, and the
    // high-impact miss is flagged.
    const out = scoreExpectations(exps, 'low')
    expect(out.impactRecall).toBe(0.17)
    expect(out.missedHighImpact).toEqual(['high'])
  })

  it('awards the wow bonus only for catching tricky items, never penalizes missing them', () => {
    const exps = [
      expectation({ id: 'tricky-caught', trickiness: 5, summary: 'tricky-caught' }),
      expectation({ id: 'tricky-missed', trickiness: 4, summary: 'tricky-missed' }),
      expectation({ id: 'easy', trickiness: 1, summary: 'easy' }),
    ]
    const out = scoreExpectations(exps, 'tricky-caught and easy are here')
    // wowBonus = 5 / (5 + 4) ≈ 0.56; the easy item does not dilute it.
    expect(out.wowBonus).toBe(0.56)
  })

  it('treats an empty expectation set as full recall and no wow on offer', () => {
    expect(scoreExpectations([], 'anything')).toMatchObject({ impactRecall: 1, wowBonus: 1 })
  })

  it('reports wowBonus 1 when nothing is tricky', () => {
    const out = scoreExpectations([expectation({ id: 'a', trickiness: 2, summary: 'a' })], 'a')
    expect(out.wowBonus).toBe(1)
  })
})

describe('renderExpectationBrief', () => {
  it('renders impact/trickiness and is empty for no expectations', () => {
    expect(renderExpectationBrief([])).toBe('')
    const brief = renderExpectationBrief([
      expectation({
        id: 'a',
        summary: 'no time-window reset',
        detail: 'lifetime cap, not a rate limit',
        impact: 5,
        trickiness: 3,
      }),
    ])
    expect(brief).toContain('no time-window reset')
    expect(brief).toContain('impact 5, trickiness 3')
    expect(brief).toContain('lifetime cap, not a rate limit')
  })
})
